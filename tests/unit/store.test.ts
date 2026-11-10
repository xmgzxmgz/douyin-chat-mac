import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Conversation, Message } from '../../src/shared/types'
import { Store } from '../../src/main/store/repository'

const dirs: string[] = []
const stores: Store[] = []

function makeStore(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dychat-store-'))
  dirs.push(dir)
  const store = new Store(dir)
  stores.push(store)
  return { store, dir }
}

function conversation(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv_1',
    accountId: 'acc_1',
    type: 'private',
    title: '阿泽',
    avatarUrl: '',
    peerId: 'p1',
    lastMessageAt: 1000,
    lastMessagePreview: 'hi',
    unreadCount: 0,
    mentionCount: 0,
    pinned: false,
    muted: false,
    hidden: false,
    draft: '',
    updatedAt: 1000,
    ...over
  }
}

function message(over: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    clientId: 'm1',
    conversationId: 'conv_1',
    accountId: 'acc_1',
    senderId: 'me',
    senderName: '我',
    type: 'text',
    content: { text: 'hi' },
    createdAt: 1000,
    status: 'sent',
    isSelf: true,
    ...over
  }
}

afterEach(() => {
  // 先清掉延迟落盘定时器，再删目录，避免 ENOENT
  for (const store of stores.splice(0)) store.dispose()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('Store · 会话', () => {
  it('置顶会话排在最前，其余按时间倒序', () => {
    const { store } = makeStore()
    store.upsertConversations('acc_1', [
      conversation({ id: 'a', lastMessageAt: 100 }),
      conversation({ id: 'b', lastMessageAt: 300 }),
      conversation({ id: 'c', lastMessageAt: 200, pinned: true })
    ])
    expect(store.listConversations('acc_1').map((c) => c.id)).toEqual(['c', 'b', 'a'])
  })

  it('本地标记不被服务端全量刷新覆盖', () => {
    const { store } = makeStore()
    store.upsertConversations('acc_1', [conversation({ id: 'a' })])
    store.patchConversation('a', { pinned: true, muted: true, draft: '还没写完' })
    store.upsertConversations('acc_1', [conversation({ id: 'a', pinned: false, muted: false, draft: '' })])
    const conv = store.getConversation('a')!
    expect(conv.pinned).toBe(true)
    expect(conv.muted).toBe(true)
    expect(conv.draft).toBe('还没写完')
  })

  it('已读水位生效：服务端旧未读不会回涨', () => {
    const { store } = makeStore()
    store.upsertConversations('acc_1', [conversation({ id: 'a', unreadCount: 5, lastMessageAt: 1000 })])
    store.patchConversation('a', { unreadCount: 0, readAt: 2000 })
    store.upsertConversations('acc_1', [conversation({ id: 'a', unreadCount: 5, lastMessageAt: 1000 })])
    expect(store.getConversation('a')!.unreadCount).toBe(0)
  })

  it('已读水位之后的新消息仍计未读', () => {
    const { store } = makeStore()
    store.upsertConversations('acc_1', [conversation({ id: 'a', unreadCount: 0, lastMessageAt: 1000 })])
    store.patchConversation('a', { unreadCount: 0, readAt: 2000 })
    store.upsertConversations('acc_1', [conversation({ id: 'a', unreadCount: 3, lastMessageAt: 3000 })])
    expect(store.getConversation('a')!.unreadCount).toBe(3)
  })

  it('隐藏会话不出现在列表中，但数据保留', () => {
    const { store } = makeStore()
    store.upsertConversations('acc_1', [conversation({ id: 'a' }), conversation({ id: 'b' })])
    store.patchConversation('b', { hidden: true })
    expect(store.listConversations('acc_1').map((c) => c.id)).toEqual(['a'])
    expect(store.allConversations('acc_1')).toHaveLength(2)
  })
})

describe('Store · 消息', () => {
  it('按 clientId 去重，服务端回执覆盖本地乐观消息', () => {
    const { store } = makeStore()
    store.appendMessage(message({ id: 'tmp_1', clientId: 'tmp_1', status: 'sending' }))
    store.appendMessage(message({ id: 'server_1', clientId: 'tmp_1', status: 'sent' }))
    const list = store.listMessages('conv_1', undefined, 10)
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('server_1')
    expect(list[0].status).toBe('sent')
  })

  it('按时间倒序分页，before 游标生效', () => {
    const { store } = makeStore()
    for (let i = 1; i <= 5; i++) store.appendMessage(message({ id: `m${i}`, clientId: `m${i}`, createdAt: i * 100 }))
    expect(store.listMessages('conv_1', undefined, 2).map((m) => m.id)).toEqual(['m5', 'm4'])
    expect(store.listMessages('conv_1', 400, 10).map((m) => m.id)).toEqual(['m3', 'm2', 'm1'])
  })

  it('单会话超过 2000 条时裁剪最旧消息', () => {
    const { store } = makeStore()
    for (let i = 1; i <= 2005; i++) {
      store.appendMessage(message({ id: `m${i}`, clientId: `m${i}`, createdAt: i }))
    }
    const list = store.listMessages('conv_1', undefined, 5000)
    expect(list).toHaveLength(2000)
    expect(list[list.length - 1].id).toBe('m6')
    expect(list[0].id).toBe('m2005')
  })
})

describe('Store · 设置与持久化', () => {
  it('设置做深合并，不丢失 notifications 子字段', () => {
    const { store } = makeStore()
    store.updateSettings({ notifications: { ...store.getSettings().notifications, sound: false } })
    const s = store.getSettings()
    expect(s.notifications.sound).toBe(false)
    expect(s.notifications.enabled).toBe(true)
    expect(s.sendKey).toBe('enter')
  })

  it('写入磁盘后可被新实例读回', () => {
    const { store, dir } = makeStore()
    store.upsertAccount({
      accountId: 'acc_1',
      id: 'u1',
      nickname: '林一',
      avatarUrl: '',
      mode: 'mock',
      createdAt: 1,
      lastLoginAt: 2
    })
    store.upsertConversations('acc_1', [conversation({ id: 'a' })])
    store.appendMessage(message({ id: 'm9', clientId: 'm9' }))
    store.flush()

    const reopened = new Store(dir)
    expect(reopened.activeAccountId).toBe('acc_1')
    expect(reopened.listConversations('acc_1')).toHaveLength(1)
    expect(reopened.getMessage('m9')?.content.text).toBe('hi')
  })

  it('状态文件损坏时备份并降级为空状态，不阻塞启动', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dychat-store-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'state.json'), '{not valid json', 'utf8')
    const store = new Store(dir)
    expect(store.listConversations('acc_1')).toEqual([])
    expect(store.getSettings().mode).toBe('mock')
  })
})
