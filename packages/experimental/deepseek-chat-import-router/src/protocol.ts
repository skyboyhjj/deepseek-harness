/** Host route 与浏览器上传器共享的路由常量。 */

/** 接收一个导出归档的 `/api` 之下的绝对路由。 */
export const UPLOAD_PATH = '/api/deepseek-chat-import-router/archive'

/**
 * {@link UPLOAD_PATH} 的浏览器相对形式；页面用它相对 document base 解析，使带路径
 * 前缀的代理继续工作。
 */
export const UPLOAD_ROUTE = UPLOAD_PATH.slice(1)
