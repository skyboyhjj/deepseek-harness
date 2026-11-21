/**
 * 旧版 DeepSeek 导出格式（`conversations.json`）的解析：ChatGPT 风格的
 * `mapping` 消息树，每个非 root 节点带 `message`（含 `fragments`），但没有显式
 * `role`。
 *
 * 树按深度优先先序展平：root 无法到达的孤立节点被丢弃，同角色连续片段折叠进父
 * 消息，每个消息的角色由片段推断（REQUEST → USER，其余 → ASSISTANT），并以父角色
 * 兜底。
 */

/** 展平后的消息角色。 */
export type LegacyRole = 'USER' | 'ASSISTANT'

/** 一条展平后的搜索结果；`publishedAt` 为 UNIX 秒 `published_at` 的 ISO 形式。 */
export interface LegacySearchResult {
  readonly url: string
  readonly title: string
  readonly snippet: string
  readonly publishedAt: string | null
}

/** 旧版导出记录的片段类型。 */
export type LegacyFragment =
  | { readonly type: 'REQUEST'; readonly content: string }
  | { readonly type: 'RESPONSE'; readonly content: string }
  | { readonly type: 'THINK'; readonly content: string }
  | { readonly type: 'SEARCH'; readonly results: readonly LegacySearchResult[] }

/** 旧版用户消息携带的一个文件；导出不含二进制数据。 */
export interface LegacyFileEntry {
  readonly id: string
  readonly fileName: string
}

/** 树展平并完成角色推断后的一条消息。 */
export interface LegacyLinearMessage {
  readonly role: LegacyRole
  /** 由 `inserted_at` 解析出的 epoch 毫秒。 */
  readonly time: number
  readonly fragments: readonly LegacyFragment[]
  readonly files: readonly LegacyFileEntry[]
}

/** 展平为交替消息序列后的一个会话。 */
export interface LegacyLinearConversation {
  readonly id: string
  readonly title: string | null
  readonly messages: readonly LegacyLinearMessage[]
}

/** 旧版会话文件解析失败时抛出；消息描述具体缺陷。 */
export class LegacyConversationError extends Error {
  override readonly name = 'LegacyConversationError'
}

/** 将一个旧版会话展平为交替消息序列；无法解析时返回 null。 */
export function parseLegacyConversation(value: unknown): LegacyLinearConversation | null {
  const item = record(value, 'conversation')
  const id = string(item.id, 'conversation id')
  const mapping = record(item.mapping, 'conversation mapping')

  const nodes = new Map<string, NodeEntry>()
  for (const key of Object.keys(mapping)) {
    nodes.set(key, readNode(mapping[key]))
  }

  let rootKey: string | undefined
  if (nodes.has('root')) {
    rootKey = 'root'
  } else {
    for (const [key, node] of nodes) {
      if (node.message === null) {
        rootKey = key
        break
      }
    }
  }
  const root = rootKey === undefined ? undefined : nodes.get(rootKey)
  if (root === undefined) return null

  const messages: MutableLinearMessage[] = []
  const assigned = new Map<string, number>()
  let sequence = 0

  const visit = (key: string, parentRole: LegacyRole | null, parentId: number | null): void => {
    if (assigned.has(key)) return
    const node = nodes.get(key)
    if (node === undefined || node.message === null) return
    const role: LegacyRole = node.message.roleHint ?? inferRole(parentRole)
    if (parentRole === null && role !== 'USER') return
    const children = node.children.filter(child => nodes.has(child))

    if (parentRole !== null && role === parentRole && parentId !== null) {
      const parent = messages[parentId - 1]
      if (parent !== undefined) {
        parent.fragments.push(...node.message.fragments)
        parent.files.push(...node.message.files)
      }
      assigned.set(key, parentId)
      for (const child of children) visit(child, parentRole, parentId)
      return
    }

    sequence += 1
    assigned.set(key, sequence)
    messages.push({
      role,
      time: node.message.time,
      fragments: [...node.message.fragments],
      files: [...node.message.files],
    })
    for (const child of children) visit(child, role, sequence)
  }

  for (const child of root.children.filter(key => nodes.has(key))) {
    visit(child, null, null)
  }

  if (messages.length === 0) return null

  return {
    id,
    title: typeof item.title === 'string' ? item.title : null,
    messages,
  }
}

/** 折叠过程中可原地追加片段的内部消息类型（公开类型为 readonly）。 */
interface MutableLinearMessage {
  role: LegacyRole
  time: number
  fragments: LegacyFragment[]
  files: LegacyFileEntry[]
}

interface NodeEntry {
  readonly children: string[]
  readonly message: MessageEntry | null
}

interface MessageEntry {
  readonly roleHint: LegacyRole | null
  readonly time: number
  readonly fragments: LegacyFragment[]
  readonly files: LegacyFileEntry[]
}

function readNode(value: unknown): NodeEntry {
  const item = record(value, 'mapping node')
  const children = list(item.children ?? [], 'node children')
    .map(child => (typeof child === 'string' ? child : ''))
    .filter(child => child.length > 0)
  const message = item.message === null || item.message === undefined ? null : readMessage(item.message)
  return { children, message }
}

function readMessage(value: unknown): MessageEntry {
  const item = record(value, 'message')
  const fragments: LegacyFragment[] = []
  for (const envelope of list(item.fragments ?? [], 'message fragments')) {
    const fragment = readFragment(envelope)
    if (fragment !== undefined) fragments.push(fragment)
  }
  const files: LegacyFileEntry[] = []
  for (const file of list(item.files ?? [], 'message files')) {
    const entry = readFile(file)
    if (entry !== undefined) files.push(entry)
  }
  return {
    roleHint: roleHintOf(fragments),
    time: parseTime(item.inserted_at) ?? 0,
    fragments,
    files,
  }
}

function readFragment(value: unknown): LegacyFragment | undefined {
  const item = record(value, 'fragment')
  if (typeof item.type !== 'string') return undefined
  switch (item.type) {
    case 'REQUEST':
      return { type: 'REQUEST', content: text(item.content) }
    case 'RESPONSE':
      return { type: 'RESPONSE', content: text(item.content) }
    case 'THINK':
      return { type: 'THINK', content: text(item.content) }
    case 'SEARCH': {
      const results: LegacySearchResult[] = []
      for (const entry of list(item.results ?? [], 'SEARCH results')) {
        const result = readSearchResult(entry)
        if (result !== undefined) results.push(result)
      }
      return { type: 'SEARCH', results }
    }
    default:
      return undefined
  }
}

function readSearchResult(value: unknown): LegacySearchResult | undefined {
  const item = record(value, 'search result')
  const url = text(item.url)
  if (url.length === 0) return undefined
  return {
    url,
    title: text(item.title),
    snippet: text(item.snippet),
    publishedAt: unixToIso(item.published_at),
  }
}

function readFile(value: unknown): LegacyFileEntry | undefined {
  const item = record(value, 'file')
  const id = text(item.id)
  if (id.length === 0) return undefined
  return { id, fileName: text(item.file_name) }
}

function roleHintOf(fragments: readonly LegacyFragment[]): LegacyRole | null {
  let hasRequest = false
  let hasAssistant = false
  for (const fragment of fragments) {
    if (fragment.type === 'REQUEST') hasRequest = true
    else hasAssistant = true
  }
  if (hasRequest) return 'USER'
  if (hasAssistant) return 'ASSISTANT'
  return null
}

function inferRole(parentRole: LegacyRole | null): LegacyRole {
  if (parentRole === 'ASSISTANT') return 'USER'
  if (parentRole === 'USER') return 'ASSISTANT'
  return 'USER'
}

function parseTime(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.getTime() : undefined
}

function unixToIso(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const date = new Date(value * 1000)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LegacyConversationError(`${label} 必须是对象`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new LegacyConversationError(`${label} 必须是字符串`)
  return value
}

function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new LegacyConversationError(`${label} 必须是数组`)
  return value
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
