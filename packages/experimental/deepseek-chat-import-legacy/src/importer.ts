/**
 * 将内存中已解析的旧版 DeepSeek 导出会话逐条写入调用方指定的 Workspace。
 *
 * 输入是 `conversations.json` 解析后的顶层数组（每条为一棵 mapping 树），没有
 * manifest、index 或图片。逐条 `convertConversation` 后，用照抄自
 * `deepseek-chat-import` 的 `writeSession` 写入：`Session.create` 先在写入前做种子
 * 校验，随后 `persistence.create → append → flush → close`。
 */

import { brandNumber, brandString } from '@deepseek-ai/dsh-brand'
import { Session, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { convertConversation } from './conversation.ts'
import type { ConvertConversationOptions, ConvertedConversation } from './conversation.ts'
import { ExportSourceError, parseLegacyArchive } from './archive.ts'
import type { DeepseekChatImportLegacyResult, DeepseekChatImportLegacySkip } from './types.ts'

/** 一次导入所需的服务与输入。 */
export interface DeepseekChatImportLegacyDependencies {
  /** 接收每条导入 Session 的持久化存储；`SessionPersistence` 满足该形状。 */
  readonly persistence: {
    create(header: SessionHeader, options: { signal: AbortSignal }): Promise<Pick<SessionHandle, 'append' | 'flush' | 'close'>>
  }
  /** 每次写入后刷新的可选 Session 列表投影缓存。 */
  readonly projectionCache?: {
    coldSnapshot(header: SessionHeader, inheritedEventCount: SessionLogOffset, events: readonly SessionEvent[]): unknown
  } | undefined
  /** 目标 Workspace 是否仍已注册；每次写入前检查。 */
  readonly workspaceRegistered: (workspaceId: string) => boolean
  /** 生成唯一 Session、消息与工具调用 id。 */
  readonly createId: () => string
  /** 每个未导入会话的诊断信息。 */
  readonly warn: (message: string) => void
}

/** 接收导入 Session 的 Workspace；registry 的 `Workspace` 满足它。 */
export interface DeepseekChatImportLegacyWorkspace {
  /** 结果中上报的 Workspace id。 */
  readonly id: string
  /** 既有的规范目录，用作每条导入 Session 的工作目录。 */
  readonly path: string
  /**
   * 把一条已存储 Session 记为成员。
   * @param sessionId - header cwd 为 {@link path} 的 Session。
   */
  attachSession(sessionId: SessionId): Promise<void>
}

/** 一次导入的部署上限。 */
export interface DeepseekChatImportLegacyLimits {
  /** 最多写入的 Session 数。 */
  readonly maxSessions: number
  /** 导入标题的 UTF-8 字节上限。 */
  readonly maxTitleBytes: number
}

/** 一次导入请求。 */
export interface DeepseekChatImportLegacyRequest {
  /** `conversations.json` 解析后的顶层数组，每条为一条旧版会话。 */
  readonly conversations: readonly unknown[]
  /** 接收 Session 的 Workspace。 */
  readonly workspace: DeepseekChatImportLegacyWorkspace
  /** Session 数与标题长度上限。 */
  readonly limits: DeepseekChatImportLegacyLimits
  /**
   * 启动后与每条导入 Session 后的进度回调。
   * @param done - 已导入的 Session 数。
   * @param total - 导入尝试写入的 Session 数。
   */
  readonly onProgress: (done: number, total: number) => void
}

/**
 * 把旧版导出会话逐条写入一个 Workspace。
 *
 * 每条会话先经 `convertConversation` 转换（内部含 `parseLegacyConversation` 校验），
 * 再经 `Session.create` 种子校验后写入；转换或写入失败的会话记入 `skipped` 并继续下
 * 一条。写入前的 `workspaceRegistered` 检查保证 Workspace 被移除时立即停止。
 * @param deps - 存储、Workspace 与 id 服务。
 * @param request - 会话数组、目标 Workspace、上限与进度回调。
 * @param signal - 取消信号，在各步骤间检查；已写入的 Session 会保留。
 * @returns 导入汇总。
 * @throws {Error} 当 Workspace 在导入过程中被移除。
 */
export async function importLegacyConversations(
  deps: DeepseekChatImportLegacyDependencies,
  request: DeepseekChatImportLegacyRequest,
  signal: AbortSignal,
): Promise<DeepseekChatImportLegacyResult> {
  const { conversations, limits, workspace } = request
  const total = Math.min(limits.maxSessions, conversations.length)
  const options: ConvertConversationOptions = { createId: deps.createId, maxTitleBytes: limits.maxTitleBytes }
  const sessionIds: SessionId[] = []
  const skipped: DeepseekChatImportLegacySkip[] = []
  request.onProgress(0, total)

  for (let index = 0; index < total; index++) {
    signal.throwIfAborted()
    if (!deps.workspaceRegistered(workspace.id)) {
      throw new Error(`workspace ${workspace.id} was removed during the import`)
    }
    const value = conversations[index]!
    let title: string | null = null
    try {
      const conversion = convertConversation(value, options)
      title = conversion.title
      const id = await writeSession(deps, conversion, workspace.path, signal)
      await attachSession(workspace, id)
      sessionIds.push(id)
    } catch (error) {
      signal.throwIfAborted()
      const reason = errorText(error)
      skipped.push({ index, title, reason })
      deps.warn(`deepseek-chat-import-legacy: conversation at index ${index} was not imported: ${reason}`)
    }
    request.onProgress(sessionIds.length, total)
  }

  return {
    workspaceId: workspace.id,
    workspacePath: workspace.path,
    sessionIds,
    conversationCount: conversations.length,
    omittedByLimit: conversations.length - total,
    skipped,
  }
}

/** 记录一条已存储 Session 为 Workspace 成员，失败时带上已存储的 id。 */
async function attachSession(workspace: DeepseekChatImportLegacyWorkspace, id: SessionId): Promise<void> {
  try {
    await workspace.attachSession(id)
  } catch (error) {
    // SessionPersistence 不提供删除，因此已存储的 Session 会留在 Workspace 之外。
    throw new Error(`stored as Session ${id} but not added to the workspace: ${errorText(error)}`, { cause: error })
  }
}

/** 照抄 `deepseek-chat-import` 的 `writeSession`：种子校验后 create → append → flush → close。 */
async function writeSession(
  deps: DeepseekChatImportLegacyDependencies,
  conversion: ConvertedConversation,
  cwd: string,
  signal: AbortSignal,
): Promise<SessionId> {
  const id = brandString<SessionId>(deps.createId())
  const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id, createdAt: conversion.createdAt, cwd, isSeeded: false }
  // 构造与活 Session 执行同一套种子校验；分离实例随后丢弃。
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 一次导入请求（携带原始归档字节）。 */
export interface DeepseekChatImportLegacyExportRequest {
  /** 完整的上传字节（ZIP）。 */
  readonly archive: Uint8Array
  readonly workspace: DeepseekChatImportLegacyWorkspace
  readonly limits: DeepseekChatImportLegacyLimits
  readonly onProgress: (done: number, total: number) => void
}

/**
 * 解析上传的 ZIP、提取 conversations.json 并逐条导入。
 * @throws {ExportSourceError} 归档不可读、缺少 conversations.json 或没有任何会话。
 */
export async function importLegacyExport(
  deps: DeepseekChatImportLegacyDependencies,
  request: DeepseekChatImportLegacyExportRequest,
  signal: AbortSignal,
): Promise<DeepseekChatImportLegacyResult> {
  const { conversations } = parseLegacyArchive(request.archive)
  if (conversations.length === 0) {
    throw new ExportSourceError('no-conversations', 'the export has no conversations', {})
  }
  return importLegacyConversations(deps, {
    conversations,
    workspace: request.workspace,
    limits: request.limits,
    onProgress: request.onProgress,
  }, signal)
}
