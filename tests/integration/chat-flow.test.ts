import { describe, beforeEach, expect, it } from 'vitest'
import type { Message } from '../../src/shared/types'
import { ChatService } from '../../src/main/core/chat-service'
import { MemoryNotifier } from '../../src/main/core/notifier'
import { MockAdapter } from '../../src/main/adapters/mock/mock-adapter'
import { MockServer } from '../../src/main/adapters/mock/mock-server'
import { MemoryVault } from '../../src/main/security/memory-vault'
import { Store } from '../../src/main/store/repository'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

interface Ctx {
  store: Store
  vault: MemoryVault
  notifier: MemoryNotifier
  server: MockServer
  service: ChatService
  accountId: string
}

async function setup(): Promise<Ctx> {
  const store = new Store('/tmp/dychat-integration', { inMemory: true })
  const vault = new MemoryVault()
  const notifier = new MemoryNotifier()
  const server = new MockServer({ latencyMs: 0, jitterMs: 0, autoReply: false })
  const service = new ChatService({
    store,
    vault,
    notifier,
    logger: silentLogger,
    createAdapter: () => new MockAdapter(server),
    syncIntervalMs: 60_000,
    sendOptions: { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} }
  })
  await service.loginWithCookie({ cookie: 'sessionid=integration_test; ttwid=t1' })
  await service.syncNow()
  const accountId = service.getSession().account!.accountId
  return { store, vault, notifier, server, service, accountId }
}

async function waitFor(check: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 8))
  }
}

const text = (t: string): Message['content'] => ({ text: t })

describe('端到端 · 登录与会话装载', () => {
  let ctx: Ctx
  beforeEach(async () => {
    ctx = await setup()
  })

  it('登录后会话按置顶 + 时间排序，好友列表就绪', () => {
    const session = ctx.service.getSession()
    expect(session.status).toBe('active')
    expect(session.account?.nickname).toBe('林一')

    const convs = ctx.service.listConversations()
    expect(convs).toHaveLength(4)
    expect(convs[0].title).toBe('阿泽')
    expect(convs[0].pinned).toBe(true)
    expect(ctx.service.listFriends()).toHaveLength(3)
  })

  it('首次同步只补历史，不补历史消息通知', () => {
    expect(ctx.notifier.sent).toHaveLength(0)
    expect(ctx.store.listMessages(ctx.service.listConversations()[0].id, undefined, 50).length).toBeGreaterThan(0)
  })
})

describe('端到端 · 消息收发', () => {
  let ctx: Ctx
  beforeEach(async () => {
    ctx = await setup()
  })

  it('发送文本：乐观入队 → 服务端回执 → 会话预览更新', async () => {
    const conv = ctx.service.listConversations().find((c) => c.title === '阿泽')!
    const optimistic = await ctx.service.send({ conversationId: conv.id, type: 'text', content: text('晚上见') })
    expect(optimistic.status).toBe('sending')

    await waitFor(() => ctx.store.getMessageByClientId(optimistic.clientId)?.status === 'sent')
    const stored = ctx.store.getMessageByClientId(optimistic.clientId)!
    expect(stored.content.text).toBe('晚上见')
    expect(stored.isSelf).toBe(true)
    expect(ctx.store.getConversation(conv.id)!.lastMessagePreview).toBe('晚上见')
  })

  it('收到新消息：未读 +1、弹通知、Dock 角标累加', async () => {
    const conv = ctx.service.listConversations().find((c) => c.title === '阿泽')!
    ctx.service.setFocused(false)
    ctx.service.setActiveConversation(null)
    const before = ctx.store.getConversation(conv.id)!.unreadCount

    ctx.server.simulateIncoming(conv.id, '在吗，看到回我一下')
    await ctx.service.syncNow()

    expect(ctx.store.getConversation(conv.id)!.unreadCount).toBe(before + 1)
    expect(ctx.notifier.sent).toHaveLength(1)
    expect(ctx.notifier.sent[0].body).toBe('在吗，看到回我一下')
    expect(ctx.notifier.sent[0].conversationId).toBe(conv.id)
    expect(ctx.notifier.badge).toBeGreaterThan(0)
  })

  it('正在查看该会话时不弹通知，并自动已读', async () => {
    const conv = ctx.service.listConversations().find((c) => c.title === '阿泽')!
    ctx.service.setFocused(true)
    ctx.service.setActiveConversation(conv.id)

    ctx.server.simulateIncoming(conv.id, '你在看这个会话')
    await ctx.service.syncNow()

    expect(ctx.notifier.sent).toHaveLength(0)
    expect(ctx.store.getConversation(conv.id)!.unreadCount).toBe(0)
  })

  it('免打扰会话不弹通知，但仍累计未读', async () => {
    const group = ctx.service.listConversations().find((c) => c.type === 'group')!
    ctx.service.setFocused(false)
    ctx.service.setMuted(group.id, true)

    ctx.server.simulateIncoming(group.id, '群里有人发图')
    await ctx.service.syncNow()

    expect(ctx.notifier.sent).toHaveLength(0)
    expect(ctx.store.getConversation(group.id)!.unreadCount).toBeGreaterThan(0)
  })

  it('网络故障：重试耗尽后标记失败，手动重试可成功', async () => {
    const conv = ctx.service.listConversations()[0]
    ctx.server.failNextSends = 10
    const optimistic = await ctx.service.send({ conversationId: conv.id, type: 'text', content: text('会失败的消息') })

    await waitFor(() => ctx.store.getMessageByClientId(optimistic.clientId)?.status === 'failed')
    const failed = ctx.store.getMessageByClientId(optimistic.clientId)!
    expect(failed.errorCode).toBe('NETWORK')

    ctx.server.failNextSends = 0
    await ctx.service.retry(optimistic.clientId)
    await waitFor(() => ctx.store.getMessageByClientId(optimistic.clientId)?.status === 'sent')
    expect(ctx.store.getMessageByClientId(optimistic.clientId)!.errorCode).toBeUndefined()
  })

  it('空文本被拒绝，不产生本地消息', async () => {
    const conv = ctx.service.listConversations()[0]
    await expect(ctx.service.send({ conversationId: conv.id, type: 'text', content: text('   ') })).rejects.toMatchObject({
      code: 'VALIDATION'
    })
  })

  it('撤回自己的消息，列表预览同步更新', async () => {
    const conv = ctx.service.listConversations()[0]
    const optimistic = await ctx.service.send({ conversationId: conv.id, type: 'text', content: text('说错话了') })
    await waitFor(() => ctx.store.getMessageByClientId(optimistic.clientId)?.status === 'sent')

    const recalled = await ctx.service.recall(optimistic.clientId)
    expect(recalled.status).toBe('recalled')
    expect(recalled.content.text).toBe('')
    expect(ctx.store.getConversation(conv.id)!.lastMessagePreview).toBe('[消息已撤回]')
  })

  it('超过 2 分钟的消息不可撤回', async () => {
    const conv = ctx.service.listConversations()[0]
    ctx.store.appendMessage({
      id: 'old_1',
      clientId: 'old_1',
      conversationId: conv.id,
      accountId: ctx.accountId,
      senderId: 'self_1001',
      senderName: '林一',
      type: 'text',
      content: text('很久以前'),
      createdAt: Date.now() - 3 * 60 * 1000,
      status: 'sent',
      isSelf: true
    })
    await expect(ctx.service.recall('old_1')).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('历史消息分页：本地不足时回源拉取并合并去重', async () => {
    const conv = ctx.service.listConversations()[0]
    const page = await ctx.service.history(conv.id, undefined, 50)
    const ids = page.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(page.length).toBeGreaterThanOrEqual(2)
  })
})

describe('端到端 · 会话与好友管理', () => {
  let ctx: Ctx
  beforeEach(async () => {
    ctx = await setup()
  })

  it('置顶 / 免打扰 / 隐藏生效', () => {
    const convs = ctx.service.listConversations()
    const target = convs.find((c) => c.title === '陈屿')!
    const pinnedFirst = ctx.service.listConversations()[0]
    ctx.service.setPinned(pinnedFirst.id, false)
    ctx.service.setPinned(target.id, true)
    expect(ctx.service.listConversations()[0].id).toBe(target.id)

    ctx.service.setMuted(target.id, true)
    expect(ctx.store.getConversation(target.id)!.muted).toBe(true)

    ctx.service.setHidden(target.id, true)
    expect(ctx.service.listConversations().some((c) => c.id === target.id)).toBe(false)
  })

  it('标为已读后未读与角标归零，且同步不会回涨', async () => {
    const conv = ctx.service.listConversations().find((c) => c.title === '阿泽')!
    expect(ctx.store.getConversation(conv.id)!.unreadCount).toBeGreaterThan(0)
    ctx.service.markRead(conv.id)
    expect(ctx.store.getConversation(conv.id)!.unreadCount).toBe(0)

    await ctx.service.syncNow()
    expect(ctx.store.getConversation(conv.id)!.unreadCount).toBe(0)
    expect(ctx.notifier.badge).toBe(
      ctx.store.allConversations(ctx.accountId).reduce((s, c) => s + c.unreadCount, 0)
    )
  })

  it('搜索好友、备注、拉黑、删除', async () => {
    expect((await ctx.service.searchFriends('阿泽')).map((f) => f.id)).toEqual(['u_2001'])

    const added = await ctx.service.addFriend('u_2002', '小满同学')
    expect(added.remark).toBe('小满同学')

    const renamed = ctx.service.setRemark('u_2002', '满满')
    expect(renamed.remark).toBe('满满')

    const blocked = await ctx.service.setBlocked('u_2002', true)
    expect(blocked.blocked).toBe(true)

    await ctx.service.removeFriend('u_2003')
    expect(ctx.service.listFriends().some((f) => f.id === 'u_2003')).toBe(false)
  })

  it('导出会话为 Markdown，包含标题与消息正文', async () => {
    const conv = ctx.service.listConversations().find((c) => c.title === '阿泽')!
    const { filename, content } = ctx.service.exportConversation(conv.id)
    expect(filename).toMatch(/阿泽.*\.md/)
    expect(content).toContain('# 阿泽')
    expect(content).toContain('晚上八点老地方？')
  })
})

describe('端到端 · 生命周期', () => {
  it('重启后从钥匙串恢复登录态与本地数据', async () => {
    const ctx = await setup()
    const accountId = ctx.accountId
    const convCount = ctx.service.listConversations().length

    const revived = new ChatService({
      store: ctx.store,
      vault: ctx.vault,
      notifier: new MemoryNotifier(),
      logger: silentLogger,
      createAdapter: () => new MockAdapter(ctx.server),
      syncIntervalMs: 60_000,
      sendOptions: { maxAttempts: 1, baseDelayMs: 1, sleep: async () => {} }
    })
    await revived.init()

    expect(revived.getSession().account?.accountId).toBe(accountId)
    expect(revived.listConversations()).toHaveLength(convCount)
    revived.dispose()
  })

  it('退出登录清空会话视图与凭据', async () => {
    const ctx = await setup()
    await ctx.service.logout()

    expect(ctx.service.getSession().status).toBe('anonymous')
    expect(ctx.service.listConversations()).toEqual([])
    expect(await ctx.vault.load(ctx.accountId)).toBeNull()
    expect(ctx.notifier.badge).toBe(0)
  })

  it('切换到已保存的第二个账号，会话归属随之切换', async () => {
    const ctx = await setup()
    const second = {
      accountId: 'acc_second',
      id: 'self_1001',
      nickname: '备用号',
      avatarUrl: '',
      mode: 'mock' as const,
      createdAt: 1,
      lastLoginAt: 2
    }
    ctx.store.upsertAccount(second)
    await ctx.vault.save('acc_second', { cookie: 'sessionid=second_account', savedAt: Date.now() })
    ctx.store.setSession({ accountId: 'acc_second', mode: 'mock', expiresAt: null, lastSyncAt: null })

    const session = await ctx.service.switchAccount('acc_second')
    expect(session.account?.accountId).toBe('acc_second')
    expect(ctx.service.listConversations().length).toBeGreaterThan(0)
    expect(ctx.service.listConversations().every((c) => c.accountId === 'acc_second')).toBe(true)
  })
})
