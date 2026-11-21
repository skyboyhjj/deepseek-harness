/**
 * 统一导入路由（router）的共存测试：同一个 upload route 依次接收新版 v3 ZIP 与旧版
 * legacy ZIP，验证统一入口能正确识别格式并分别导入，且非归档字节返回 unsupported-format。
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { strToU8, zipSync } from 'fflate'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import * as SessionStore from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SessionProjection from '@deepseek-ai/dsh-session-projection'
import * as SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import * as Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import * as Workspace from '@deepseek-ai/dsh-workspace'
// 引入 `session/title` 事件的类型增强，供读取会话标题。
import type {} from '@deepseek-ai/dsh-session-title'
import * as DeepseekChatImportRouter from '../src/index.ts'
import { UPLOAD_PATH } from '../src/protocol.ts'
import type { DeepseekChatImportRouterLine, DeepseekChatImportRouterResult } from '../src/types.ts'

const BASE = Date.UTC(2026, 10, 11, 2, 0, 0)
const at = (ms: number): string => new Date(BASE + ms).toISOString()

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** 一条新版 v3 会话文件：一条 USER 请求加一条已完成的 ASSISTANT 应答。 */
function v3Conversation(id: string, title: string, leafAt: number) {
  return {
    id, title, inserted_at: at(0),
    messages: [
      { id: 1, parent_id: null, role: 'USER', status: 'FINISHED', inserted_at: at(leafAt - 1), fragments: [{ type: 'REQUEST', content: `question ${id}` }] },
      { id: 2, parent_id: 1, role: 'ASSISTANT', status: 'FINISHED', inserted_at: at(leafAt), fragments: [{ type: 'RESPONSE', content: `answer ${id}` }] },
    ],
  }
}

/** 新版 v3 归档：manifest.json + chat_session_index.json + 两个会话文件。 */
function v3Archive(): Uint8Array {
  return zipSync({
    'manifest.json': strToU8('{"export_format_version":3}'),
    'chat_session_index.json': strToU8(JSON.stringify([
      { id: 'one', title: 'v3 one', pinned: false, inserted_at: at(0), updated_at: at(2_000), message_count: 2 },
      { id: 'two', title: 'v3 two', pinned: false, inserted_at: at(0), updated_at: at(1_000), message_count: 2 },
    ])),
    'chat_sessions/one.json': strToU8(JSON.stringify(v3Conversation('one', 'v3 one', 2_000))),
    'chat_sessions/two.json': strToU8(JSON.stringify(v3Conversation('two', 'v3 two', 1_000))),
  })
}

/** 一条旧版 legacy 会话：mapping 树，root 下一条 USER 请求后跟一条 ASSISTANT 应答。 */
function legacyConversation(id: string, title: string, ms: number) {
  return {
    id, title,
    mapping: {
      root: { children: ['u1'], message: null },
      u1: { children: ['a1'], message: { inserted_at: at(ms - 1), fragments: [{ type: 'REQUEST', content: `question ${id}` }], files: [] } },
      a1: { children: [], message: { inserted_at: at(ms), fragments: [{ type: 'RESPONSE', content: `answer ${id}` }], files: [] } },
    },
  }
}

/** 旧版 legacy 归档：仅 conversations.json，不含 manifest.json。 */
function legacyArchive(): Uint8Array {
  return zipSync({
    'conversations.json': strToU8(JSON.stringify([
      legacyConversation('l1', 'legacy one', 2_000),
      legacyConversation('l2', 'legacy two', 1_000),
    ])),
  })
}

/** 通过 Loader 启动真实持久化与 Workspace 服务，并用替身提供 Connection route 注册。 */
async function boot() {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-deepseek-import-router-loader-')))
  const workspacePath = join(root, 'project')
  await mkdir(workspacePath)
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
    '  config:',
    `    root: ${JSON.stringify(join(root, 'sessions'))}`,
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@deepseek-ai/dsh-storage-json'",
    '  config:',
    `    root: ${JSON.stringify(join(root, 'storage'))}`,
    "- name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: json',
    "- name: '@deepseek-ai/dsh-workspace'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-session-projection-cache'",
    '  config:',
    '    writeEveryEvents: 1',
    '    writeIntervalMs: 1000',
    "- name: '@deepseek-ai/dsh-typert-registry'",
    '- id: deepseek-chat-import-router',
    "  name: '@deepseek-ai/dsh-deepseek-chat-import-router'",
    '  config:',
    '    maxSessions: 10',
    '    maxUploadBytes: 1048576',
    '    maxEntryBytes: 1048576',
    '    maxTitleBytes: 80',
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  const routes = new Map<string, ConnectionFetchRoute>()
  context.provide('connection', {
    fetch: {
      register: (route: ConnectionFetchRoute) => {
        routes.set(route.path, route)
        return () => { routes.delete(route.path); return Promise.resolve() }
      },
    },
  } as never)
  context.provide('attachments', { saveImage: () => Promise.reject(new Error('unused')) } as never)
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlPersistence],
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-workspace', Workspace],
    ['@deepseek-ai/dsh-session-projection', SessionProjection],
    ['@deepseek-ai/dsh-session-projection-cache', SessionProjectionCache],
    ['@deepseek-ai/dsh-typert-registry', TypertRegistry],
    ['@deepseek-ai/dsh-deepseek-chat-import-router', DeepseekChatImportRouter],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as never
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()

  const ctx = context
  const workspace = await ctx.workspaceRegistry.create(workspacePath)
  const post = (body: Uint8Array): Promise<Response> => {
    const route = routes.get(UPLOAD_PATH)
    if (route === undefined) throw new Error('upload route is not registered')
    return route.fetch(new Request(`http://127.0.0.1${UPLOAD_PATH}?workspaceId=${workspace.id}`, {
      method: 'POST', body: new Uint8Array(body), headers: { 'content-type': 'application/octet-stream' },
    }))
  }
  return { ctx, routes, workspace, workspacePath, post }
}

/** 把 NDJSON 应答按行解析为 wire 行。 */
const lines = async (response: Response): Promise<DeepseekChatImportRouterLine[]> =>
  (await response.text()).split('\n').filter(line => line !== '').map(line => JSON.parse(line) as DeepseekChatImportRouterLine)

/** 取应答末尾的 outcome 行；非成功即失败，直接抛出。 */
const outcome = (answer: DeepseekChatImportRouterLine[]): DeepseekChatImportRouterResult => {
  const last = answer.at(-1)
  if (last?.type !== 'outcome' || !last.outcome.ok) throw new Error(`unexpected answer ${JSON.stringify(answer)}`)
  return last.outcome.value
}

/** 读取已落库 Session 的标题（来自 `session/title` 事件），按字典序返回。 */
async function sessionTitles(ctx: Context): Promise<string[]> {
  const titles: string[] = []
  for (const snapshot of await ctx.sessionPersistence.list()) {
    const handle = await ctx.sessionPersistence.open(snapshot.header.id, 'read')
    try {
      const { events } = await handle.read()
      for (const event of events) {
        if (event.type === 'session/title') titles.push(event.data.title)
      }
    } finally {
      await handle.close()
    }
  }
  return titles.sort()
}

it('同一 upload route 混传 v3 与 legacy 归档，统一入口分别识别并导入', async () => {
  const { ctx, routes, workspace, workspacePath, post } = await boot()
  expect(routes.get(UPLOAD_PATH)).toMatchObject({ methods: ['POST'], requestBody: 'streaming' })

  // 新版 v3 归档：统一入口按 manifest 识别，走 v3 converter。
  const v3Lines = await lines(await post(v3Archive()))
  expect(v3Lines.slice(0, -1)).toEqual([
    { type: 'progress', done: 0, total: 2 },
    { type: 'progress', done: 1, total: 2 },
    { type: 'progress', done: 2, total: 2 },
  ])
  const v3Result = outcome(v3Lines)
  expect(v3Result).toMatchObject({
    workspaceId: workspace.id,
    workspacePath,
    conversationCount: 2,
    omittedByLimit: 0,
    skipped: [],
  })
  expect(v3Result.sessionIds).toHaveLength(2)

  // 旧版 legacy 归档：无 manifest，统一入口按 conversations.json 识别，走 legacy converter。
  const legacyLines = await lines(await post(legacyArchive()))
  expect(legacyLines.slice(0, -1)).toEqual([
    { type: 'progress', done: 0, total: 2 },
    { type: 'progress', done: 1, total: 2 },
    { type: 'progress', done: 2, total: 2 },
  ])
  const legacyResult = outcome(legacyLines)
  expect(legacyResult).toMatchObject({
    workspaceId: workspace.id,
    workspacePath,
    conversationCount: 2,
    omittedByLimit: 0,
    skipped: [],
  })
  expect(legacyResult.sessionIds).toHaveLength(2)

  // 四类标题各来自对应 converter，证明格式路由正确，两类会话均落库。
  expect(await ctx.sessionPersistence.list()).toHaveLength(4)
  expect(await sessionTitles(ctx)).toEqual(['legacy one', 'legacy two', 'v3 one', 'v3 two'])
})

it('对非归档字节返回 unsupported-format 失败', async () => {
  const { ctx, post } = await boot()
  expect(await lines(await post(strToU8('this is not a zip archive')))).toEqual([
    { type: 'outcome', outcome: { ok: false, error: { reason: 'unsupported-format', message: 'the upload is not a recognized DeepSeek chat export archive' } } },
  ])
  expect(await ctx.sessionPersistence.list()).toEqual([])
})
