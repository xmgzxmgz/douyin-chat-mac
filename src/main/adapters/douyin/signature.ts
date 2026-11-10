/**
 * 签名与公共参数。
 *
 * 抖音 Web 端每个私信请求都会携带一组由页面 JS 计算的防篡改参数
 * （常见为 a_bogus / msToken / X-Bogus / verifyFp 等）。这些参数依赖：
 *   1. 当前 UA、设备指纹、webid；
 *   2. 请求的 query 与 body；
 *   3. 页面侧不断更新的风控脚本。
 *
 * 本客户端**不内置**任何绕过/伪造算法：那既不稳定，也可能违反平台条款。
 * 取而代之提供一个 Signer 扩展点，由使用者自行提供合法的签名来源，例如：
 *   - 复用自己浏览器中已登录页面的会话（推荐，见 README「接入真实账号」）；
 *   - 由具备资质的合作方/官方开放平台下发的签名服务。
 *
 * 未注入 Signer 时，适配器会在发请求前抛出 UNSUPPORTED，并在 UI 中给出明确提示，
 * 而不是发出一个注定被拒绝的请求。
 */
export interface SignRequestInput {
  method: 'GET' | 'POST'
  url: string
  query: Record<string, string>
  body?: string
  userAgent: string
}

export interface Signer {
  readonly name: string
  sign(input: SignRequestInput): Promise<Record<string, string>>
}

export const COMMON_PARAMS = {
  device_platform: 'webapp',
  aid: '6383',
  channel: 'channel_pc_web',
  pc_client_type: '1',
  version_code: '190500',
  version_name: '19.5.0',
  cookie_enabled: 'true',
  screen_width: '1728',
  screen_height: '1117',
  browser_language: 'zh-CN',
  browser_platform: 'MacIntel',
  browser_name: 'Chrome',
  browser_version: '131.0.0.0',
  engine_name: 'Blink',
  engine_version: '131.0.0.0',
  os_name: 'Mac OS',
  os_version: '10.15.7',
  cpu_core_num: '8',
  device_memory: '8',
  platform: 'PC',
  downlink: '10',
  effective_type: '4g',
  round_trip_time: '50'
} as const

export const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export function buildCommonParams(now = Date.now()): Record<string, string> {
  return {
    ...COMMON_PARAMS,
    webid: '',
    msToken: '',
    ttwid: '',
    _t: String(Math.floor(now / 1000))
  }
}

/** 从 cookie 串中提取 csrf / ttwid 等需要回填到 query 或 header 的字段 */
export function parseCookie(cookie: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of cookie.split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    if (k) out[k] = v
  }
  return out
}

export function extractCsrfToken(cookie: string): string | undefined {
  const c = parseCookie(cookie)
  return c.csrf_token ?? c.csrfToken ?? c.passport_csrf_token
}

export function extractTtwid(cookie: string): string | undefined {
  return parseCookie(cookie).ttwid
}

export class UnsupportedSigner implements Signer {
  readonly name = 'unsupported'

  async sign(): Promise<Record<string, string>> {
    throw new Error('SIGNER_REQUIRED')
  }
}
