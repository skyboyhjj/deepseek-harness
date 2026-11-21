/** deepseek-chat-import-router 的浏览器安全 wire 类型。 */

import type {} from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** 仅 owner 可导入；其余 principal 一律拒绝。 */
    'deepseekChatImportRouter/owner-only': {}
  }
}

/** 整次导入为何中止。 */
export type DeepseekChatImportRouterFailureReason =
  | 'too-large'
  | 'unreadable-archive'
  | 'missing-manifest'
  | 'missing-index'
  | 'unsupported-version'
  | 'missing-conversations'
  | 'no-conversations'
  | 'workspace-not-found'
  | 'busy'
  | 'unsupported-format'

/** 归档层失败：携带一个 wire reason，upload route 据此生成 outcome 行。 */
export class ExportSourceError extends Error {
  /** 面向浏览器的失败原因。 */
  readonly reason: DeepseekChatImportRouterFailureReason

  constructor(reason: DeepseekChatImportRouterFailureReason, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.reason = reason
  }
}

/** 一条未能导入的会话。 */
export interface DeepseekChatImportRouterSkip {
  /** 会话 id（来自 index / 入口名），或转换失败时的可定位标识。 */
  conversationId: string
  /** 转换后（若可用）的标题；转换失败时为 null。 */
  title: string | null
  /** 描述缺陷的诊断信息。 */
  reason: string
}

/** 一次完成的导入摘要。 */
export interface DeepseekChatImportRouterResult {
  /** 接收了导入 Session 的 Workspace。 */
  workspaceId: string
  /** 该 Workspace 的规范目录，即每条导入 Session 的工作目录。 */
  workspacePath: string
  /** 导入的 Session。 */
  sessionIds: string[]
  /** 归档中的会话总数。 */
  conversationCount: number
  /** 因 maxSessions 上限而未写入的会话数。 */
  omittedByLimit: number
  /** 未能导入的会话。 */
  skipped: DeepseekChatImportRouterSkip[]
}

/** 浏览器上传前检查的导入上限。 */
export interface DeepseekChatImportRouterLimits {
  /** 一次上传可携带的最大导出归档字节数。 */
  maxUploadBytes: number
}

/** 一次上传的最终结果。 */
export type DeepseekChatImportRouterResponse =
  | { ok: true; value: DeepseekChatImportRouterResult }
  | { ok: false; error: { reason: DeepseekChatImportRouterFailureReason; message: string } }

/**
 * upload route 的 `application/x-ndjson` 应答的每一行：写入期间为进度行，随后恰好
 * 一个 outcome 行。没有 outcome 行就结束的应答是被中断了。
 */
export type DeepseekChatImportRouterLine =
  | {
    type: 'progress'
    /** 已导入的 Session 数。 */
    done: number
    /** 导入尝试写入的 Session 数：配置上限或有效会话数中较小者。 */
    total: number
  }
  | { type: 'outcome'; outcome: DeepseekChatImportRouterResponse }
