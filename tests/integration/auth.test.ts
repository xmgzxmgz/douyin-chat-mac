import { describe, expect, it } from 'vitest'
import type { AppEvent } from '../../src/shared/types'
import { ChatService } from '../../src/main/core/chat-service'
import { MemoryNotifier } from '../../src/main/core/notifier'
import { MockAdapter } from '../../src/main/adapters/mock/mock-adapter'
import { MockServer } from '../../src/main/adapters/mock/mock-server'
import { MemoryVault } from '../../src/main/security/memory-vault'
import { Store } from '../../src/main/store/repository'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

function makeService(): { service: ChatService; server: MockServer; vault: MemoryVault } {
  const store = new Store('/tmp/dychat-auth', { inMemory: true })
  const vault = new MemoryVault()
  const server = new MockServer({ latencyMs: 0, jitterMs: 0, autoReply: false })
  const service = new ChatService({
    store,
    vault,
    notifier: new MemoryNotifier(),
    logger: silentLogger,
    createAdapter: () => new MockAdapter(server),
    syncIntervalMs: 60_000,
    sendOptions: { maxAttempts: 1, baseDelayMs: 1, sleep: async () => {} }
  })
  return { service, server, vault }
}

describe('鉴权 · Cookie 登录', () => {
  it('Cookie 缺少 sessionid 时报 AUTH_INVALID', async () => {
    const { service } = makeService()
    await expect(service.loginWithCookie({ cookie: 'ttwid=abc' })).rejects.toMatchObject({ code: 'AUTH_INVALID' })
    expect(service.getSession().status).toBe('anonymous')
  })

  it('Cookie 已过期时报 AUTH_EXPIRED', async () => {
    const { service } = makeService()
    await expect(service.loginWithCookie({ cookie: 'sessionid=abc; expired=1' })).rejects.toMatchObject({
      code: 'AUTH_EXPIRED'
    })
  })

  it('登录成功后凭据落库且只暴露账号资料给渲染层', async () => {
    const { service, vault } = makeService()
    const session = await service.loginWithCookie({ cookie: 'sessionid=abc' })
    expect(session.status).toBe('active')
    expect(session.account?.nickname).toBe('林一')
    const saved = await vault.load(session.account!.accountId)
    expect(saved?.cookie).toBe('sessionid=abc')
    // 会话信息里不包含 cookie 字段
    expect(JSON.stringify(session)).not.toContain('sessionid')
  })

  it('登录会发出 session:changed 事件', async () => {
    const { service } = makeService()
    const events: AppEvent[] = []
    service.subscribe((e) => events.push(e))
    await service.loginWithCookie({ cookie: 'sessionid=abc' })
    expect(events.some((e) => e.type === 'session:changed')).toBe(true)
  })
})

describe('鉴权 · 扫码登录（演示环境）', () => {
  it('创建二维码 → 待扫描 → 确认后建立会话', async () => {
    const { service, server } = makeService()
    const ticket = await service.createQrLogin()
    expect(ticket.qrId).toBeTruthy()
    expect(ticket.imageDataUrl.startsWith('data:image/svg+xml')).toBe(true)

    const pending = await service.pollQrLogin(ticket.qrId)
    expect(pending.state).toBe('pending')

    server.forceQrState(ticket.qrId, 'scanned')
    expect((await service.pollQrLogin(ticket.qrId)).state).toBe('scanned')

    server.forceQrState(ticket.qrId, 'confirmed')
    const confirmed = await service.pollQrLogin(ticket.qrId)
    expect(confirmed.state).toBe('confirmed')
    if (confirmed.state === 'confirmed') {
      expect(confirmed.session.status).toBe('active')
      expect(confirmed.session.account?.nickname).toBe('林一')
    }
    expect(service.listConversations().length).toBe(4)
  })

  it('未创建二维码时轮询会明确报错', async () => {
    const { service } = makeService()
    await expect(service.pollQrLogin('qr_missing')).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

describe('鉴权 · 会话失效', () => {
  it('同步过程中登录态失效会停机并置为 expired', async () => {
    const { service, server } = makeService()
    await service.loginWithCookie({ cookie: 'sessionid=abc' })
    await service.syncNow()

    const events: AppEvent[] = []
    service.subscribe((e) => events.push(e))

    server.sessionExpired = true
    const status = await service.syncNow()

    expect(status.phase).toBe('error')
    expect(service.getSession().status).toBe('expired')
    expect(events.some((e) => e.type === 'session:changed')).toBe(true)
    expect(events.some((e) => e.type === 'toast' && e.payload.level === 'warn')).toBe(true)
  })

  it('退出登录后再同步会要求重新登录', async () => {
    const { service } = makeService()
    await service.loginWithCookie({ cookie: 'sessionid=abc' })
    await service.logout()
    await expect(service.syncNow()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
  })
})
