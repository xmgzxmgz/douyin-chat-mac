import { AppError, isRetryable } from '../../core/errors'
import { classifyStatusCode } from './endpoints'
import { DEFAULT_UA, UnsupportedSigner, buildCommonParams, extractCsrfToken, extractTtwid, type Signer } from './signature'

export type FetchResponseLike = {
  ok: boolean
  status: number
  text(): Promise<string>
}

export type FetchLike = (url: string, init: Record<string, unknown>) => Promise<FetchResponseLike>

export interface HttpClientOptions {
  cookie: string
  userAgent?: string
  signer?: Signer
  fetchImpl?: FetchLike
  timeoutMs?: number
  maxRetries?: number
  minIntervalMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface RequestOptions {
  query?: Record<string, string | number | undefined>
  body?: string
  /** 部分只读接口（如自检）可跳过签名，便于排障 */
  skipSignature?: boolean
}

export class DouyinHttpClient {
  private cookieValue: string
  private userAgentValue: string
  private signer?: Signer
  private fetchImpl: FetchLike
  private timeoutMs: number
  private maxRetries: number
  private minIntervalMs: number
  private now: () => number
  private sleep: (ms: number) => Promise<void>
  private lastRequestAt = 0
  requestCount = 0

  constructor(opts: HttpClientOptions) {
    this.cookieValue = opts.cookie
    this.userAgentValue = opts.userAgent ?? DEFAULT_UA
    this.signer = opts.signer ?? new UnsupportedSigner()
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
    this.timeoutMs = opts.timeoutMs ?? 15000
    this.maxRetries = opts.maxRetries ?? 2
    this.minIntervalMs = opts.minIntervalMs ?? 120
    this.now = opts.now ?? (() => Date.now())
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  get cookie(): string {
    return this.cookieValue
  }

  get userAgent(): string {
    return this.userAgentValue
  }

  setSigner(signer: Signer | undefined): void {
    this.signer = signer
  }

  updateCredentials(cookie: string, userAgent?: string): void {
    this.cookieValue = cookie
    if (userAgent) this.userAgentValue = userAgent
  }

  async get<T>(url: string, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>('GET', url, opts)
  }

  async post<T>(url: string, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>('POST', url, opts)
  }

  async request<T>(method: 'GET' | 'POST', url: string, opts: RequestOptions = {}): Promise<T> {
    let attempt = 0
    for (;;) {
      try {
        return await this.once<T>(method, url, opts)
      } catch (err) {
        attempt += 1
        if (attempt > this.maxRetries || !isRetryable(err)) throw AppError.from(err)
        await this.sleep(Math.min(2000, 250 * 2 ** (attempt - 1)))
      }
    }
  }

  private async once<T>(method: 'GET' | 'POST', url: string, opts: RequestOptions): Promise<T> {
    await this.throttle()

    const query: Record<string, string> = {}
    for (const [k, v] of Object.entries({ ...buildCommonParams(this.now()), ...(opts.query ?? {}) })) {
      if (v !== undefined) query[k] = String(v)
    }
    const ttwid = extractTtwid(this.cookie)
    if (ttwid && !query.ttwid) query.ttwid = ttwid

    const headers: Record<string, string> = {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      'user-agent': this.userAgent,
      cookie: this.cookie,
      referer: 'https://www.douyin.com/',
      'content-type': 'application/x-www-form-urlencoded'
    }
    const csrf = extractCsrfToken(this.cookie)
    if (csrf) headers['x-secsdk-csrf-token'] = csrf

    if (this.signer && !opts.skipSignature) {
      let signed: Record<string, string>
      try {
        signed = await this.signer.sign({
          method,
          url,
          query,
          body: opts.body,
          userAgent: this.userAgent
        })
      } catch (err) {
        if ((err as Error).message === 'SIGNER_REQUIRED') {
          throw new AppError(
            'UNSUPPORTED',
            '抖音 Web 私信接口需要有效的签名参数（a_bogus/msToken）。当前未配置签名来源，请在「设置 → 接入真实账号」中配置后再试。'
          )
        }
        throw AppError.from(err)
      }
      Object.assign(query, signed)
    }

    const search = new URLSearchParams(query).toString()
    const target = method === 'GET' ? `${url}?${search}` : `${url}?${search}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    this.requestCount += 1

    let res: FetchResponseLike
    try {
      res = await this.fetchImpl(target, {
        method,
        headers,
        body: method === 'POST' ? (opts.body ?? '') : undefined,
        signal: controller.signal,
        redirect: 'follow'
      })
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw new AppError('NETWORK', `请求超时（>${this.timeoutMs}ms）`)
      throw new AppError('NETWORK', `网络请求失败：${(err as Error).message}`)
    } finally {
      clearTimeout(timer)
    }

    if (res.status === 401 || res.status === 403) throw new AppError('AUTH_EXPIRED', '登录态失效，请重新登录')
    if (res.status === 429) throw new AppError('RATE_LIMITED', '请求过于频繁，请稍后再试')
    if (res.status >= 500) throw new AppError('SERVER', `服务端异常（HTTP ${res.status}）`)

    const text = await res.text()
    let payload: unknown
    try {
      payload = text ? JSON.parse(text) : {}
    } catch {
      throw new AppError('SERVER', `响应不是合法 JSON（HTTP ${res.status}）`, text.slice(0, 200))
    }

    const root = payload as Record<string, unknown>
    const code = typeof root.status_code === 'number' ? root.status_code : undefined
    const kind = classifyStatusCode(code)
    if (kind === 'auth') throw new AppError('AUTH_EXPIRED', '登录态已失效，请重新登录')
    if (kind === 'rate') throw new AppError('RATE_LIMITED', '触发访问频率限制')
    if (kind === 'server') {
      throw new AppError('SERVER', `接口返回异常（status_code=${code}）`, typeof root.status_msg === 'string' ? root.status_msg : undefined)
    }

    return (root.data !== undefined ? root.data : root) as T
  }

  private async throttle(): Promise<void> {
    const gap = this.now() - this.lastRequestAt
    if (gap < this.minIntervalMs) await this.sleep(this.minIntervalMs - gap)
    this.lastRequestAt = this.now()
  }
}
