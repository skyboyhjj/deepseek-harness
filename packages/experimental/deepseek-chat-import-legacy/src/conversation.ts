/**
 * 将旧版 DeepSeek 导出会话（mapping 树）转换为 DSH 的 `SessionEvent[]` 种子。
 *
 * 事件序列照抄 `deepseek-chat-import` 的 `convertConversation`，仅将「选分支 +
 * 逐消息生成」替换为 `format.ts` 的 mapping 树遍历，并把片段集合收窄为旧版仅有的
 * REQUEST / RESPONSE / THINK / SEARCH 四类。
 */

import { createHash } from 'node:crypto'
import type {
  AssistantMessage,
  ContentBlock,
  LlmFailure,
  MessageId,
  SystemMessage,
  ToolCallBlock,
  ToolCallId,
  ToolResultMessage,
  UserMessage,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentId, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
// 引入 `session/title` 事件的类型增强。
import type {} from '@deepseek-ai/dsh-session-title'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { WebSearchResult } from '@deepseek-ai/dsh-web'
import type { LegacyFileEntry, LegacyFragment, LegacyLinearMessage } from './format.ts'
import { LegacyConversationError, parseLegacyConversation } from './format.ts'
import { brandNumber, brandString, formatSearchOutput, normalizeSessionTitle, searchMetaFromValue } from './runtime.ts'

/** 导入消息的模型来源标识。 */
export const IMPORTED_MODEL_SOURCE = { provider: 'deepseek-chat-export', model: 'deepseek-chat-export' } as const

export interface ConvertConversationOptions {
  /** 生成事件 id 的回调。 */
  readonly createId: () => string
  /** 会话标题的 UTF-8 字节上限。 */
  readonly maxTitleBytes: number
}

export interface ConvertedConversation {
  readonly title: string | null
  /** 首个事件的 epoch 毫秒时间。 */
  readonly createdAt: number
  readonly events: readonly SessionEvent[]
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type EventInput = DistributiveOmit<SessionEvent, 'seq' | 'time'>

interface ReplyStep {
  readonly content: ContentBlock[]
  readonly calls: PendingCall[]
}

interface PendingCall {
  readonly block: ToolCallBlock
  readonly result: readonly ContentBlock[]
  readonly isError: boolean
  readonly meta?: JsonValue
}

const SYNTHETIC_FILE_ID_PREFIX = 'deepseek-chat-import-legacy:'

export function convertConversation(value: unknown, options: ConvertConversationOptions): ConvertedConversation {
  const file = parseLegacyConversation(value)
  if (file === null) throw new LegacyConversationError('会话没有可导入的消息')
  const log = new LogBuilder(options)
  const title = normalizeTitle(file.title, options.maxTitleBytes)
  let turn = 0
  for (let index = 0; index < file.messages.length; index++) {
    const user = file.messages[index]!
    if (user.role !== 'USER') continue
    const next = file.messages[index + 1]
    const reply = next?.role === 'ASSISTANT' ? next : undefined
    turn++
    log.turn(turn, user, reply)
    if (turn === 1 && title !== null) {
      log.add({ type: 'session/title', data: { title, messageSeqs: [], source: { kind: 'user' } } })
    }
  }
  if (log.events.length === 0) throw new LegacyConversationError('会话没有可导入的事件')
  return { title, createdAt: log.events[0]!.time, events: log.events }
}

class LogBuilder {
  readonly events: SessionEvent[] = []
  private time = 0
  private readonly options: ConvertConversationOptions

  constructor(options: ConvertConversationOptions) {
    this.options = options
  }

  add(event: EventInput): SessionSeq {
    const seq = brandNumber<SessionSeq>(this.events.length)
    this.events.push({ ...event, seq, time: this.time })
    return seq
  }

  turn(turn: number, user: LegacyLinearMessage, reply: LegacyLinearMessage | undefined): void {
    this.at(user.time)
    this.add({ type: 'turn/start', data: { turn } })
    let step = 1
    this.add({ type: 'step/start', data: { turn, step } })
    if (turn === 1) {
      const head: SystemMessage = { id: brandString<MessageId>(this.id()), role: 'system', content: [], source: { kind: 'system-prompt' } }
      this.add({ type: 'system/message', data: { turn, step, message: head }, surfaceOp: 'append' })
    }
    this.add({ type: 'user/message', data: this.userMessage(user), surfaceOp: 'append' })
    if (reply === undefined) {
      this.closeTurn(turn, step, failure('DEEPSEEK_EXPORT_NO_REPLY', 'The export contains no reply to this message.'))
      return
    }
    this.at(reply.time)
    const steps = this.replySteps(reply, userQuery(user))
    if (steps.length === 0) {
      this.closeTurn(turn, step, failure('DEEPSEEK_EXPORT_EMPTY_REPLY', 'The original reply has no importable content.'))
      return
    }
    for (const [position, { content, calls }] of steps.entries()) {
      if (position > 0) {
        step++
        this.add({ type: 'step/start', data: { turn, step } })
      }
      this.add({
        type: 'assistant/message',
        data: { turn, step, message: assistantMessage(this.id(), [...content, ...calls.map(call => call.block)]), stream: [] },
        surfaceOp: 'append',
      })
      const callSeqs = calls.map(({ block }) => this.add({ type: 'tool/call', data: { turn, step, callId: block.id, name: block.name, arguments: block.arguments } }))
      for (const [callIndex, call] of calls.entries()) {
        this.add({
          type: 'tool/result',
          data: { turn, step, message: toolResult(this.id(), call), ...(call.meta === undefined ? {} : { meta: call.meta }) },
          surfaceOp: 'append',
          sourceEventSeqs: [callSeqs[callIndex]!],
        })
      }
      if (position < steps.length - 1) this.add({ type: 'step/end', data: { turn, step } })
    }
    this.closeTurn(turn, step, { kind: 'completed' })
  }

  private closeTurn(turn: number, step: number, reason: { kind: 'completed' } | { kind: 'error'; error: LlmFailure }): void {
    this.add({ type: 'step/end', data: { turn, step } })
    this.add({ type: 'turn/end', data: { turn, reason } })
  }

  private at(time: number): void {
    this.time = Math.max(this.time, time)
  }

  private id(): string {
    return this.options.createId()
  }

  private userMessage(message: LegacyLinearMessage): UserMessage {
    const attachments: ContentBlock[] = []
    const lines: string[] = []
    for (const fragment of message.fragments) {
      if (fragment.type === 'REQUEST') lines.push(fragment.content)
    }
    for (const file of message.files) {
      attachments.push({ type: 'file', attachment: syntheticFileRef(file) })
    }
    const text = lines.join('\n')
    const content: ContentBlock[] = text.trim().length > 0
      ? [...attachments, { type: 'text', text }]
      : attachments.length > 0
        ? attachments
        : [{ type: 'text', text: '' }]
    return { id: brandString<MessageId>(this.id()), role: 'user', content, source: { kind: 'user' } }
  }

  private replySteps(reply: LegacyLinearMessage, query: string): ReplyStep[] {
    const steps: ReplyStep[] = []
    let current: ReplyStep = { content: [], calls: [] }
    const pushStep = (): void => {
      if (current.content.length === 0 && current.calls.length === 0) return
      steps.push(current)
      current = { content: [], calls: [] }
    }
    const appendContent = (block: ContentBlock): void => {
      if (current.calls.length > 0) pushStep()
      current.content.push(block)
    }
    for (const fragment of reply.fragments) {
      switch (fragment.type) {
        case 'THINK':
          if (fragment.content.length > 0) appendContent({ type: 'reasoning', text: fragment.content })
          break
        case 'RESPONSE':
          if (fragment.content.length > 0) appendContent({ type: 'text', text: fragment.content })
          break
        case 'SEARCH': {
          const call = searchCall(this.id(), fragment, query)
          if (call !== undefined) current.calls.push(call)
          break
        }
        case 'REQUEST':
          break
      }
    }
    pushStep()
    return steps
  }
}

function normalizeTitle(title: string | null, maxBytes: number): string | null {
  if (title === null) return null
  const normalized = normalizeSessionTitle(title, maxBytes)
  return normalized.length === 0 ? null : normalized
}

function userQuery(message: LegacyLinearMessage): string {
  return message.fragments.filter(fragment => fragment.type === 'REQUEST').map(fragment => fragment.content).join('\n')
}

function syntheticFileRef(file: LegacyFileEntry): FileAttachmentRef {
  const digest = createHash('sha256').update(`${SYNTHETIC_FILE_ID_PREFIX}${file.id}`).digest('hex')
  return { attachmentId: brandString<AttachmentId>(`sha256:${digest}`), name: fileDisplayName(file.fileName), bytes: 0 }
}

function fileDisplayName(name: string): string {
  const leaf = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1)
  const clean = leaf.replace(/[\u0000-\u001F\u007F]/gu, '').trim()
  return clean.length === 0 ? 'file' : clean
}

function assistantMessage(id: string, content: ContentBlock[]): AssistantMessage {
  return { id: brandString<MessageId>(id), role: 'assistant', content, source: { kind: 'model', ...IMPORTED_MODEL_SOURCE } }
}

function toolResult(id: string, call: PendingCall): ToolResultMessage {
  return { id: brandString<MessageId>(id), role: 'tool', content: call.result, isError: call.isError, source: { kind: 'tool', callId: call.block.id }, toolCallId: call.block.id }
}

function searchCall(id: string, fragment: Extract<LegacyFragment, { type: 'SEARCH' }>, query: string): PendingCall | undefined {
  const queries = [query].filter(value => value.trim().length > 0)
  if (queries.length === 0) return undefined
  const block: ToolCallBlock = { type: 'tool-call', id: brandString<ToolCallId>(id), name: 'web_search', arguments: JSON.stringify({ queries }) }
  const result: WebSearchResult = {
    sources: fragment.results.map((source) => {
      const title = nonEmpty(source.title)
      const snippet = nonEmpty(source.snippet)
      const publishedAt = source.publishedAt ?? undefined
      return {
        url: source.url,
        ...(title === undefined ? {} : { title }),
        ...(snippet === undefined ? {} : { snippet }),
        ...(publishedAt === undefined ? {} : { publishedAt }),
      }
    }),
    truncated: false,
  }
  return {
    block,
    result: [{ type: 'text', text: formatSearchOutput(result) }],
    isError: false,
    meta: searchMetaFromValue(result),
  }
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return value === null || value === undefined || value.trim().length === 0 ? undefined : value
}

function failure(code: string, message: string): { kind: 'error'; error: LlmFailure } {
  return { kind: 'error', error: { code, message } }
}
