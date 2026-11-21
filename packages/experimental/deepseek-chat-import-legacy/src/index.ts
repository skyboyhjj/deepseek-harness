/**
 * 宿主插件：把浏览器上传的旧版 DeepSeek 导出（ChatGPT 风格 mapping 树，
 * `deepseek_data-*.zip`）作为所选 Workspace 中的已存储 DSH Session 导入。
 * 上传在内存中处理，绝不落盘。
 * @module @deepseek-ai/dsh-deepseek-chat-import-legacy
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { principalOf, Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { importLegacyExport } from './importer.ts'
import { UPLOAD_PATH } from './protocol.ts'
import { createUploadRoute } from './upload.ts'
import type { ImportClaim } from './upload.ts'
import type { DeepseekChatImportLegacyLimits } from './types.ts'

export { ExportSourceError } from './archive.ts'
export type { LegacyArchive } from './archive.ts'
export { convertConversation, IMPORTED_MODEL_SOURCE } from './conversation.ts'
export type { ConvertedConversation, ConvertConversationOptions } from './conversation.ts'
export { parseLegacyConversation, LegacyConversationError } from './format.ts'
export type {
  LegacyFileEntry,
  LegacyFragment,
  LegacyLinearConversation,
  LegacyLinearMessage,
  LegacyRole,
  LegacySearchResult,
} from './format.ts'
export type { DeepseekChatImportLegacyDependencies, DeepseekChatImportLegacyRequest, DeepseekChatImportLegacyWorkspace } from './importer.ts'
export type { ImportClaim, UploadRouteHandler } from './upload.ts'
export type {
  DeepseekChatImportLegacyFailureReason,
  DeepseekChatImportLegacyLimits,
  DeepseekChatImportLegacyLine,
  DeepseekChatImportLegacyResponse,
  DeepseekChatImportLegacyResult,
  DeepseekChatImportLegacySkip,
} from './types.ts'

/** 导入器的部署上限。 */
export interface Config {
  /** 一次导入最多写入的 Session 数。 */
  maxSessions: number
  /** 一次上传可携带的最大导出归档字节数；整个归档在导入期间驻留内存。 */
  maxUploadBytes: number
  /** 导入标题的最大 UTF-8 字节数，与 session-title 服务的 maxTitleBytes 保持一致。 */
  maxTitleBytes: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 旧版 DeepSeek 导出导入器的 upload route 与 Remote 上限。 */
    deepseekChatImportLegacy: DeepseekChatImportLegacyService
  }
}

/** 提供仅 owner 的导出上传 route，以及浏览器先行检查的上限。 */
export default class DeepseekChatImportLegacyService extends TypertRemoteService {
  static inject = ['typert', 'connection', 'sessionPersistence', 'workspaceRegistry']
  static Config: Schema<Config> = Schema.object({
    maxSessions: Schema.natural().min(1).default(1000)
      .description('一次导入最多写入的 Session 数。'),
    maxUploadBytes: Schema.natural().min(1).default(512 * 1024 * 1024)
      .description('一次上传可携带的最大导出归档字节数；整个归档在导入期间驻留内存。'),
    maxTitleBytes: Schema.natural().min(1).default(80)
      .description('导入标题的最大 UTF-8 字节数；与 session-title 的 maxTitleBytes 保持一致。'),
  })

  /** 运行中的导入，持有单个导入槽。 */
  private active: { readonly controller: AbortController; readonly settled: Promise<void> } | undefined

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'deepseekChatImportLegacy', { namespace: 'deepseekChatImportLegacy' })
    const route = createUploadRoute({
      maxUploadBytes: config.maxUploadBytes,
      claim: () => this.claim(),
      // registry 查找校验 wire id；未知 id 返回 undefined。
      workspace: id => ctx.workspaceRegistry.get(id as WorkspaceId),
      import: (archive, workspace, onProgress, signal) => importLegacyExport({
        persistence: ctx.sessionPersistence,
        projectionCache: ctx.get('sessionProjectionCache'),
        workspaceRegistered: id => ctx.workspaceRegistry.get(id as WorkspaceId) !== undefined,
        createId: () => randomUUID(),
        warn: (message) => { ctx.logger.warn(message) },
      }, {
        archive,
        workspace,
        limits: { maxSessions: config.maxSessions, maxTitleBytes: config.maxTitleBytes },
        onProgress,
      }, signal),
      failed: (error) => { ctx.logger.error('deepseek-chat-import-legacy: import failed', error) },
    })
    ctx.effect(
      () => ctx.connection.fetch.register({ path: UPLOAD_PATH, methods: ['POST'], requestBody: 'streaming', fetch: route }),
      'deepseek-chat-import-legacy: upload route',
    )
    ctx.effect(() => async () => {
      // 卸载会取消运行中的导入，并仅在其停止写入后完成。
      this.active?.controller.abort()
      await this.active?.settled
    }, 'deepseek-chat-import-legacy: running import')
  }

  /**
   * 上报浏览器上传前检查的上限。仅 owner 可导入，因此其余 principal 一律拒绝。
   * @param signal - 客户端取消或 Remote 撤回。
   * @returns 接受的最大归档大小。
   * @throws {RemoteError} `deepseekChatImportLegacy/owner-only` 当调用者不是 owner。
   */
  @Remote
  limits(signal: AbortSignal): DeepseekChatImportLegacyLimits {
    signal.throwIfAborted()
    if (principalOf(this.ctx.invocation) !== undefined) {
      throw new RemoteError('deepseekChatImportLegacy/owner-only', 'only the owner may import DeepSeek chat exports', {})
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
}
