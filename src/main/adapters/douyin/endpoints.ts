/**
 * 抖音 Web 端私信相关端点集中配置。
 *
 * ⚠️ 重要：以下 IM 路径是**初版推断**，2026-11-10 实测结果为：
 *   - /aweme/v1/web/im/{conversation/list,message/history,friend/list} → 网关返回 "Unsupported path(Janus)"
 *   - /aweme/v1/web/im/user/info/ → 返回 status_code=0 "url doesn't match"
 *   即这些路径当前**不可用**，必须用浏览器 Network 面板抓到的真实请求替换。
 *
 * 抓包与回放：`npm run probe -- --curl <抓包文件>`（见 docs/接口与合规.md）
 */
const BASE = process.env.DOUYIN_API_BASE ?? 'https://www.douyin.com'

export const ENDPOINTS = {
  profileSelf: `${BASE}/aweme/v1/web/im/user/info/`,
  conversationList: `${BASE}/aweme/v1/web/im/conversation/list/`,
  messageHistory: `${BASE}/aweme/v1/web/im/message/history/`,
  messageSend: `${BASE}/aweme/v1/web/im/message/send/`,
  messageRecall: `${BASE}/aweme/v1/web/im/message/recall/`,
  friendList: `${BASE}/aweme/v1/web/im/friend/list/`,
  friendAdd: `${BASE}/aweme/v1/web/im/friend/add/`,
  friendRemove: `${BASE}/aweme/v1/web/im/friend/remove/`,
  userSearch: `${BASE}/aweme/v1/web/discover/search/`,
  qrConnect: `${BASE}/passport/web/get_qrcode/`,
  qrCheck: `${BASE}/passport/web/check_qrconnect/`
} as const

/** 业务状态码 → 语义。仅保留客户端需要区分的几类。 */
export const STATUS_CODE = {
  OK: 0,
  AUTH_EXPIRED: [8, 10008, 2154, 2096],
  RATE_LIMITED: [5, 10015, 10016]
} as const

export function classifyStatusCode(code: number | undefined): 'ok' | 'auth' | 'rate' | 'server' {
  if (code === undefined || code === STATUS_CODE.OK) return 'ok'
  if ((STATUS_CODE.AUTH_EXPIRED as readonly number[]).includes(code)) return 'auth'
  if ((STATUS_CODE.RATE_LIMITED as readonly number[]).includes(code)) return 'rate'
  return 'server'
}
