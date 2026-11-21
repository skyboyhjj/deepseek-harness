/**
 * Upload route：一次经过认证的 POST 携带完整导出归档，缓冲到内存、导入、导入结束时
 * 释放。应答以 `application/x-ndjson` 流式输出进度行与一个 outcome 行。上传内容不落盘。
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import { ExportSourceError } from './types.ts'
import type { DeepseekChatImportRouterFailureReason, DeepseekChatImportRouterLine, DeepseekChatImportRouterResult } from './types.ts'

/** 接收导入 Session 的 Workspace；registry 的 `Workspace` 满足它。 */
export interface DeepseekChatImportRouterWorkspace {
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

/** 所属服务的单个导入槽。 */
export interface ImportClaim {
  /** 所属服务卸载时中止。 */
  readonly signal: AbortSignal
  /** 释放槽；请求结束时恰好调用一次。 */
  release(): void
}

/** route 需要所属服务提供的能力。 */
export interface UploadRouteHandler {
  /** 接受的最大 body 字节数。 */
  readonly maxUploadBytes: number
  /**
   * 占用服务的单个导入槽。
   * @returns 槽；另一个导入占用期间为 undefined。
   */
  claim(): ImportClaim | undefined
  /**
   * 解析目标 Workspace。
   * @param workspaceId - 请求 query 中的 id。
   * @returns Workspace；未知时为 undefined。
   */
  workspace(workspaceId: string): DeepseekChatImportRouterWorkspace | undefined
  /**
   * 导入一个缓冲归档。
   * @param archive - 完整 body 字节。
   * @param workspace - 解析出的目标。
   * @param onProgress - 已导入 Session 数与导入尝试写入的 Session 数。
   * @param signal - 请求生命周期与槽的组合。
   * @returns 导入摘要。
   */
  import(
    archive: Uint8Array,
    workspace: DeepseekChatImportRouterWorkspace,
    onProgress: (done: number, total: number) => void,
    signal: AbortSignal,
  ): Promise<DeepseekChatImportRouterResult>
  /**
   * 上报既非归档失败也非取消的导入失败。
   * @param error - 抛出的值；响应随后在没有 outcome 行的情况下结束。
   */
  failed(error: unknown): void
}

const NDJSON_HEADERS = {
  'content-type': 'application/x-ndjson; charset=utf-8',
  // 压缩中间件尊重 no-transform，进度行不会被滞留。
  'cache-control': 'no-store, no-transform',
  'x-content-type-options': 'nosniff',
}

/**
 * 通过所属服务的导入槽一次处理一个上传。
 * @param handler - route 背后的服务操作。
 * @returns 注册在 Connection route 上的 Fetch 处理器。
 */
export function createUploadRoute(handler: UploadRouteHandler): (request: Request) => Promise<Response> {
  return async (request) => {
    const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (mediaType !== 'application/octet-stream') {
      return new Response('content type must be application/octet-stream', { status: 415 })
    }
    const workspaceId = new URL(request.url).searchParams.get('workspaceId')
    if (workspaceId === null || workspaceId === '') return new Response('workspaceId is required', { status: 400 })
    const claim = handler.claim()
    if (claim === undefined) {
      await request.body?.cancel()
      return failure('busy', 'another import is running')
    }
    let streaming = false
    try {
      const workspace = handler.workspace(workspaceId)
      if (workspace === undefined) {
        await request.body?.cancel()
        return failure('workspace-not-found', `workspace ${workspaceId} does not exist`)
      }
      const cancel = new AbortController()
      const signal = AbortSignal.any([claim.signal, request.signal, cancel.signal])
      const archive = await readBounded(request, handler.maxUploadBytes, signal)
      if (archive === undefined) return failure('too-large', `the archive exceeds ${handler.maxUploadBytes} bytes`)
      streaming = true
      return new Response(importStream(handler, archive, workspace, claim, cancel, signal), { status: 200, headers: NDJSON_HEADERS })
    } finally {
      if (!streaming) claim.release()
    }
  }
}

/**
 * 在响应 body 之后运行一次导入：进度行，然后一个 outcome 行。取消 body 会中止导入；
 * 槽在导入结束时释放。
 */
function importStream(
  handler: UploadRouteHandler,
  archive: Uint8Array,
  workspace: DeepseekChatImportRouterWorkspace,
  claim: ImportClaim,
  cancel: AbortController,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  let open = true
  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      const send = (line: DeepseekChatImportRouterLine): void => { if (open) controller.enqueue(encodeLine(line)) }
      const end = (): void => {
        if (open) controller.close()
        open = false
      }
      handler.import(archive, workspace, (done, total) => { send({ type: 'progress', done, total }) }, signal).then(
        (value) => {
          send({ type: 'outcome', outcome: { ok: true, value } })
          end()
        },
        (error: unknown) => {
          if (signal.aborted) {
            end()
          } else if (error instanceof ExportSourceError) {
            send(outcomeLine(error.reason, error.message))
            end()
          } else {
            // 未取消，因此 body 仍打开。
            handler.failed(error)
            controller.error(error)
            open = false
          }
        },
      ).finally(() => { claim.release() })
    },
    cancel: () => {
      open = false
      cancel.abort()
    },
  })
}

/**
 * 从有效的 `content-length` 读取整个 body 到单缓冲，仅在 body 比声明更长时才增长；
 * 一旦会超过 `limit` 字节即返回 undefined。
 */
async function readBounded(request: Request, limit: number, signal: AbortSignal): Promise<Uint8Array | undefined> {
  const declared = Number(request.headers.get('content-length') ?? Number.NaN)
  if (declared > limit) {
    await request.body?.cancel()
    return undefined
  }
  let buffer = new Uint8Array(Number.isSafeInteger(declared) && declared >= 0 ? declared : 0)
  let total = 0
  if (request.body !== null) {
    const reader = request.body.getReader()
    // 取消会关闭 body 并结束挂起的读取，即使 body 源随后取消失败。
    const stop = (): void => { reader.cancel(signal.reason).catch(() => undefined) }
    signal.addEventListener('abort', stop, { once: true })
    try {
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        const end = total + chunk.value.byteLength
        if (end > limit) {
          await reader.cancel()
          return undefined
        }
        if (end > buffer.byteLength) {
          const grown = new Uint8Array(Math.min(limit, Math.max(end, buffer.byteLength * 2)))
          grown.set(buffer.subarray(0, total))
          buffer = grown
        }
        buffer.set(chunk.value, total)
        total = end
      }
    } finally {
      signal.removeEventListener('abort', stop)
    }
  }
  signal.throwIfAborted()
  return total === buffer.byteLength ? buffer : buffer.subarray(0, total)
}

function encodeLine(line: DeepseekChatImportRouterLine): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${JSON.stringify(line)}\n`)
}

function outcomeLine(reason: DeepseekChatImportRouterFailureReason, message: string): DeepseekChatImportRouterLine {
  return { type: 'outcome', outcome: { ok: false, error: { reason, message } } }
}

function failure(reason: DeepseekChatImportRouterFailureReason, message: string): Response {
  return new Response(encodeLine(outcomeLine(reason, message)), { status: 200, headers: NDJSON_HEADERS })
}
