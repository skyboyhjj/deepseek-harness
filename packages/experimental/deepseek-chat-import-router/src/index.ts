/**
 * 宿主插件：把浏览器上传的 DeepSeek 导出归档（新版 v3 或旧版）通过统一入口路由到
 * 匹配的 converter，作为所选 Workspace 中的已存储 DSH Session 导入。上传在内存中处理，
 * 绝不落盘。
 * @module @deepseek-ai/dsh-deepseek-chat-import-router
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { brandNumber, brandString } from '@deepseek-ai/dsh-brand'
import { Session, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { principalOf, Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { ExportSourceError as V3ExportSourceError } from '@deepseek-ai/dsh-deepseek-chat-import/src/archive.ts'
import { ExportSourceError as LegacyExportSourceError } from '@deepseek-ai/dsh-deepseek-chat-import-legacy/src/archive.ts'
import { v3Converter } from './v3-converter.ts'
import { legacyConverter } from './legacy-converter.ts'
import type { ArchiveConverter, ConvertedConversation, ConvertOptions, ConvertResult } from './converter.ts'
import { UPLOAD_PATH } from './protocol.ts'
import { createUploadRoute } from './upload.ts'
import type { DeepseekChatImportRouterWorkspace, ImportClaim } from './upload.ts'
import { ExportSourceError } from './types.ts'
import type { DeepseekChatImportRouterLimits, DeepseekChatImportRouterResult, DeepseekChatImportRouterSkip } from './types.ts'

/** 按优先级遍历的 converter 列表；新版（含 manifest.json）优先。 */
const converters: readonly ArchiveConverter[] = [v3Converter, legacyConverter]

/** 部署上限。 */
export interface Config {
  /** 一次导入最多写入的 Session 数。 */
  maxSessions: number
  /** 一次上传可携带的最大导出归档字节数；整个归档在导入期间驻留内存。 */
  maxUploadBytes: number
  /** 单个归档条目声明未压缩字节的最大值；更大的条目不解压。 */
  maxEntryBytes: number
  /** 导入标题的最大 UTF-8 字节数；与 session-title 的 maxTitleBytes 保持一致。 */
  maxTitleBytes: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 统一导入入口的 upload route 与 Remote 上限。 */
    deepseekChatImportRouter: DeepseekChatImportRouterService
  }
}

/** writeSession 需要的存储与 id 服务。 */
interface WriteDeps {
  /** 持久化存储，接收每条导入 Session；一个 `SessionPersistence` 满足它。 */
  readonly persistence: {
    create(header: SessionHeader, options: { signal: AbortSignal }): Promise<Pick<SessionHandle, 'append' | 'flush' | 'close'>>
  }
  /** 可选的 Session 列表投影缓存，每条写入后刷新。 */
  readonly projectionCache?: {
    coldSnapshot(header: SessionHeader, inheritedEventCount: SessionLogOffset, events: readonly SessionEvent[]): unknown
  } | undefined
  /** 铸造唯一 Session、消息、工具调用 id。 */
  readonly createId: () => string
}

/** 提供仅 owner 的导出上传 route，以及浏览器先行检查的上限。 */
export default class DeepseekChatImportRouterService extends TypertRemoteService {
  static inject = ['typert', 'connection', 'sessionPersistence', 'workspaceRegistry']
  static Config: Schema<Config> = Schema.object({
    maxSessions: Schema.natural().min(1).default(1000)
      .description('一次导入最多写入的 Session 数。'),
    maxUploadBytes: Schema.natural().min(1).default(512 * 1024 * 1024)
      .description('一次上传可携带的最大导出归档字节数；整个归档在导入期间驻留内存。'),
    maxEntryBytes: Schema.natural().min(1).default(256 * 1024 * 1024)
      .description('单个归档条目声明未压缩字节的最大值；更大的条目不解压。'),
    maxTitleBytes: Schema.natural().min(1).default(80)
      .description('导入标题的最大 UTF-8 字节数；与 session-title 的 maxTitleBytes 保持一致。'),
  })

  /** 运行中的导入，持有单个导入槽。 */
  private active: { readonly controller: AbortController; readonly settled: Promise<void> } | undefined

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'deepseekChatImportRouter', { namespace: 'deepseekChatImportRouter' })
    const route = createUploadRoute({
      maxUploadBytes: config.maxUploadBytes,
      claim: () => this.claim(),
      // registry 查找校验 wire id；未知 id 返回 undefined。
      workspace: id => ctx.workspaceRegistry.get(id as WorkspaceId),
      import: (archive, workspace, onProgress, signal) => this.importArchive(archive, workspace, onProgress, signal),
      failed: (error) => { ctx.logger.error('deepseek-chat-import-router: import failed', error) },
    })
    ctx.effect(
      () => ctx.connection.fetch.register({ path: UPLOAD_PATH, methods: ['POST'], requestBody: 'streaming', fetch: route }),
      'deepseek-chat-import-router: upload route',
    )
    ctx.effect(() => async () => {
      // 卸载会取消运行中的导入，并仅在其停止写入后完成。
      this.active?.controller.abort()
      await this.active?.settled
    }, 'deepseek-chat-import-router: running import')
  }

  @Remote
  limits(signal: AbortSignal): DeepseekChatImportRouterLimits {
    signal.throwIfAborted()
    if (principalOf(this.ctx.invocation) !== undefined) {
      throw new RemoteError('deepseekChatImportRouter/owner-only', 'only the owner may import DeepSeek chat exports', {})
    }
    return { maxUploadBytes: this.config.maxUploadBytes }
  }

  private claim(): ImportClaim | undefined {
    if (this.active !== undefined) return undefined
    const controller = new AbortController()
    const { promise: settled, resolve: settle } = Promise.withResolvers<void>()
    this.active = { controller, settled }
    return {
      signal: controller.signal,
      release: () => {
        this.active = undefined
        settle()
      },
    }
  }

  /**
   * 识别格式并完成一次导入：convert 产出种子日志，再逐条写入 Session。
   * @param archive - 完整 body 字节。
   * @param workspace - 解析出的目标。
   * @param onProgress - 进度回调。
   * @param signal - 请求生命周期与槽的组合。
   * @returns 导入摘要。
   * @throws {ExportSourceError} `unsupported-format` 当没有 converter 识别这份归档，以及归档层失败。
   */
  private async importArchive(
    archive: Uint8Array,
    workspace: DeepseekChatImportRouterWorkspace,
    onProgress: (done: number, total: number) => void,
    signal: AbortSignal,
  ): Promise<DeepseekChatImportRouterResult> {
    for (const converter of converters) {
      if (!converter.detect(archive)) continue
      const deps: WriteDeps = {
        persistence: this.ctx.sessionPersistence,
        projectionCache: this.ctx.get('sessionProjectionCache'),
        createId: () => randomUUID(),
      }
      const options: ConvertOptions = {
        createId: deps.createId,
        maxTitleBytes: this.config.maxTitleBytes,
        maxEntryBytes: this.config.maxEntryBytes,
        attachments: this.ctx.get('attachments'),
        warn: (message) => { this.ctx.logger.warn(message) },
      }
      let result: ConvertResult
      try {
        result = await converter.convert(archive, options, signal)
      } catch (error) {
        signal.throwIfAborted()
        throw asRouterError(error)
      }
      const skipped: DeepseekChatImportRouterSkip[] = [...result.skipped]
      const sessionIds: SessionId[] = []
      const total = Math.min(this.config.maxSessions, result.conversations.length)
      onProgress(0, total)
      for (let index = 0; index < total; index++) {
        signal.throwIfAborted()
        // Workspace 在写入期间被移除会在下一次写入前中止导入。
        if (this.ctx.workspaceRegistry.get(workspace.id as WorkspaceId) === undefined) {
          throw new ExportSourceError('workspace-not-found', `workspace ${workspace.id} was removed during the import`)
        }
        const conversion = result.conversations[index]!
        try {
          const id = await writeSession(deps, conversion, workspace.path, signal)
          await attachSession(workspace, id)
          sessionIds.push(id)
        } catch (error) {
          signal.throwIfAborted()
          const reason = errorText(error)
          skipped.push({ conversationId: conversion.title ?? `conversation-${index + 1}`, title: conversion.title, reason })
          this.ctx.logger.warn(`deepseek-chat-import-router: conversation was not imported: ${reason}`)
        }
        onProgress(sessionIds.length, total)
      }
      return {
        workspaceId: workspace.id,
        workspacePath: workspace.path,
        sessionIds,
        conversationCount: result.conversationCount,
        omittedByLimit: result.conversations.length - total,
        skipped,
      }
    }
    throw new ExportSourceError('unsupported-format', 'the upload is not a recognized DeepSeek chat export archive')
  }
}

/** 记录一条已存储 Session 为 Workspace 成员，失败时命名已存储 id。 */
async function attachSession(workspace: DeepseekChatImportRouterWorkspace, id: SessionId): Promise<void> {
  try {
    await workspace.attachSession(id)
  } catch (error) {
    // SessionPersistence 不提供删除，所以已存储的 Session 留在 Workspace 之外。
    throw new Error(`stored as Session ${id} but not added to the workspace: ${errorText(error)}`, { cause: error })
  }
}

async function writeSession(
  deps: WriteDeps,
  conversion: ConvertedConversation,
  cwd: string,
  signal: AbortSignal,
): Promise<SessionId> {
  const id = brandString<SessionId>(deps.createId())
  const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id, createdAt: conversion.createdAt, cwd, isSeeded: false }
  // 构造过程运行与 live Session 相同的种子校验；分离实例随即丢弃。
  Session.create(id, conversion.events, header)
  signal.throwIfAborted()
  const handle = await deps.persistence.create(header, { signal })
  try {
    await handle.append(conversion.events)
    await handle.flush()
  } finally {
    await handle.close()
  }
  deps.projectionCache?.coldSnapshot(header, brandNumber<SessionLogOffset>(0), conversion.events)
  return id
}

/** 把两包的归档层失败翻译为 router 自己的 ExportSourceError，供 upload route 生成 outcome 行。 */
function asRouterError(error: unknown): unknown {
  if (error instanceof V3ExportSourceError || error instanceof LegacyExportSourceError) {
    return new ExportSourceError(error.reason, error.message, { cause: error })
  }
  return error
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
