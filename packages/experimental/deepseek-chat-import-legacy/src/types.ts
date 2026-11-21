/** 旧版 DeepSeek 导出导入器的浏览器安全 wire 类型。 */

import type {} from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** 仅 owner 可导入；其余 principal 一律拒绝。 */
    'deepseekChatImportLegacy/owner-only': {}
  }
}

/** 整次导入为何中止。 */
export type DeepseekChatImportLegacyFailureReason =
  | 'too-large'
  | 'unreadable-archive'
  | 'missing-conversations'
  | 'no-conversations'
  | 'workspace-not-found'
  | 'busy'

/** 一条未能导入的会话。 */
export interface DeepseekChatImportLegacySkip {
  /** 会话在 conversations.json 数组中的下标。 */
  index: number
  /** 转换后（若可用）的标题；转换失败时为 null。 */
  title: string | null
  /** 描述缺陷的诊断信息。 */
  reason: string
}

/** 一次完成的导入摘要。 */
export interface DeepseekChatImportLegacyResult {
  /** 接收了导入 Session 的 Workspace。 */
  workspaceId: string
  /** 该 Workspace 的规范目录，即每条导入 Session 的工作目录。 */
  workspacePath: string
  /** 导入的 Session。 */
  sessionIds: string[]
  /** conversations.json 中的会话总数。 */
  conversationCount: number
  /** 因 maxSessions 上限而未写入的会话数。 */
  omittedByLimit: number
  /** 未能导入的会话。 */
  skipped: DeepseekChatImportLegacySkip[]
}

/** 浏览器上传前检查的导入上限。 */
export interface DeepseekChatImportLegacyLimits {
  /** 一次上传可携带的最大导出归档字节数。 */
  maxUploadBytes: number
}

/** 一次上传的最终结果。 */
export type DeepseekChatImportLegacyResponse =
  | { ok: true; value: DeepseekChatImportLegacyResult }
  | { ok: false; error: { reason: DeepseekChatImportLegacyFailureReason; message: string } }

/**
 * upload route 的 `application/x-ndjson` 应答的每一行：写入期间为进度行，随后恰好
 * 一个 outcome 行。没有 outcome 行就结束的应答是被中断了。
 */
export type DeepseekChatImportLegacyLine =
  | {
    type: 'progress'
    /** 已导入的 Session 数。 */
    done: number
    /** 导入尝试写入的 Session 数：配置上限或有效会话数中较小者。 */
    total: number
  }
  | { type: 'outcome'; outcome: DeepseekChatImportLegacyResponse }
