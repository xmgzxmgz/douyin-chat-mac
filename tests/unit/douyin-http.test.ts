import { describe, expect, it } from 'vitest'
import { AppError } from '../../src/main/core/errors'
import { DouyinHttpClient, type FetchLike } from '../../src/main/adapters/douyin/http-client'
import type { Signer } from '../../src/main/adapters/douyin/signature'

interface Call {
  url: string
  init: Record<string, unknown>
}

function fakeFetch(
  payload: unknown,
  opts: { status?: number; handler?: (url: string) => unknown } = {}
): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init })
    const body = opts.handler ? opts.handler(url) : payload
    return {
      ok: (opts.status ?? 200) < 400,
      status: opts.status ?? 200,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
    }
  }
  return { fetchImpl, calls }
}

const baseOptions = {
  cookie: 'sessionid=s1; ttwid=tw_1; csrf_token=csrf_1',
  minIntervalMs: 0,
  sleep: async () => {},
  now: () => 1_000_000,
  // 默认给一个最小可用 signer，让请求能走通；签名专项测试会覆盖它
  signer: { name: 'base', sign: async () => ({ a_bogus: 'base_sig' }) } as Signer
}

describe('DouyinHttpClient · 请求构造', () => {
  it('拼接公共参数、业务参数、ttwid 与签名参数', async () => {
    const { fetchImpl, calls } = fakeFetch({ status_code: 0, data: { value: 42 } })
    const signed: Record<string, string>[] = []
    const signer: Signer = {
      name: 'fake',
      sign: async (input) => {
        signed.push({ ...input.query })
        return { a_bogus: 'sig_abc', msToken: 'tok_1' }
      }
    }
    const client = new DouyinHttpClient({ ...baseOptions, fetchImpl, signer })
    const data = await client.get<{ value: number }>('https://www.douyin.com/aweme/v1/web/im/x/', {
      query: { count: 10 }
    })

    expect(data.value).toBe(42)
    const url = calls[0].url
    expect(url).toContain('device_platform=webapp')
    expect(url).toContain('aid=6383')
    expect(url).toContain('count=10')
    expect(url).toContain('ttwid=tw_1')
    expect(url).toContain('a_bogus=sig_abc')
    expect(signed[0].count).toBe('10')
  })

  it('携带 Cookie、UA 与 csrf 头', async () => {
    const { fetchImpl, calls } = fakeFetch({ status_code: 0 })
    const client = new DouyinHttpClient({ ...baseOptions, fetchImpl, userAgent: 'UA/1.0' })
    await client.get('https://www.douyin.com/x', { skipSignature: true })
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.cookie).toContain('sessionid=s1')
    expect(headers['user-agent']).toBe('UA/1.0')
    expect(headers['x-secsdk-csrf-token']).toBe('csrf_1')
    expect(headers.referer).toBe('https://www.douyin.com/')
  })

  it('POST 请求把 body 原样发出', async () => {
    const { fetchImpl, calls } = fakeFetch({ status_code: 0 })
    const client = new DouyinHttpClient({ ...baseOptions, fetchImpl })
    await client.post('https://www.douyin.com/y', { body: 'conversation_id=a&count=20' })
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.body).toBe('conversation_id=a&count=20')
  })
})

describe('DouyinHttpClient · 响应与错误归一', () => {
  it('status_code=0 时自动解包 data', async () => {
    const { fetchImpl } = fakeFetch({ status_code: 0, data: { list: [1, 2] } })
    const client = new DouyinHttpClient({ ...baseOptions, fetchImpl })
    await expect(client.get('https://www.douyin.com/x')).resolves.toEqual({ list: [1, 2] })
  })

  it('status_code=8 映射为登录态失效且不重试', async () => {
    const { fetchImpl, calls } = fakeFetch({ status_code: 8, status_msg: '登录过期' })
    const client = new DouyinHttpClient({ ...baseOptions, fetchImpl, maxRetries: 2 })
    await expect(client.get('https://www.douyin.com/x')).rejects.toMatchObject({ code: 'AUTH_EXPIRED' })
    expect(calls).toHaveLength(1)
  })

  it('HTTP 401/403 映射为登录态失效', async () => {
    const { fetchImpl } = fakeFetch({}, { status: 401 })
    const client = new DouyinHttpClient({ ...baseOptions, fetchImpl })
    await expect(client.get('https://www.douyin.com/x')).rejects.toMatchObject({ code: 'AUTH_EXPIRED' })
  })

  it('HTTP 429 与限流码会按次数重试后失败', async () => {
    const { fetchImpl, calls } = fakeFetch({}, { status: 429 })
    const client = new DouyinHttpClient({ ...baseOptions, fetchImpl, maxRetries: 2 })
    await expect(client.get('https://www.douyin.com/x')).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    expect(calls).toHaveLength(3)
  })

  it('5xx 映射为服务端错误', async () => {
    const { fetchImpl } = fakeFetch({}, { status: 503 })
    const client = new DouyinHttpClient({ ...baseOptions, fetchImpl, maxRetries: 0 })
    await expect(client.get('https://www.douyin.com/x')).rejects.toMatchObject({ code: 'SERVER' })
  })

  it('超时映射为网络错误', async () => {
    const fetchImpl: FetchLike = async () => {
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    }
    const client = new DouyinHttpClient({ ...baseOptions, fetchImpl, maxRetries: 0 })
    await expect(client.get('https://www.douyin.com/x')).rejects.toMatchObject({ code: 'NETWORK' })
  })

  it('非 JSON 响应给出可诊断错误', async () => {
    const { fetchImpl } = fakeFetch('<html>blocked</html>')
    const client = new DouyinHttpClient({ ...baseOptions, fetchImpl, maxRetries: 0 })
    await expect(client.get('https://www.douyin.com/x')).rejects.toMatchObject({ code: 'SERVER' })
  })

  it('未配置签名来源时抛出 UNSUPPORTED，而不是发出裸请求', async () => {
    const { fetchImpl, calls } = fakeFetch({ status_code: 0 })
    const client = new DouyinHttpClient({ ...baseOptions, signer: undefined, fetchImpl })
    const err = await client.get('https://www.douyin.com/x').catch((e: AppError) => e)
    expect((err as AppError).code).toBe('UNSUPPORTED')
    expect((err as AppError).message).toContain('签名')
    expect((err as AppError).retryable).toBe(false)
    expect(calls).toHaveLength(0)
  })
})
