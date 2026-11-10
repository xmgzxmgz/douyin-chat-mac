import { describe, expect, it } from 'vitest'
import type { Conversation, Message, NotificationSettings } from '../../src/shared/types'
import { decideNotification, isWithinDnd, notificationBody } from '../../src/main/core/notification-policy'

const settings: NotificationSettings = {
  enabled: true,
  sound: true,
  showPreview: true,
  badge: true,
  dndEnabled: false,
  dndStart: '22:00',
  dndEnd: '08:00'
}

const conversation: Conversation = {
  id: 'conv_1',
  accountId: 'acc_1',
  type: 'private',
  title: '阿泽',
  avatarUrl: '',
  peerId: 'p1',
  lastMessageAt: Date.now(),
  lastMessagePreview: '在吗',
  unreadCount: 1,
  mentionCount: 0,
  pinned: false,
  muted: false,
  hidden: false,
  draft: '',
  updatedAt: Date.now()
}

function message(over: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    clientId: 'm1',
    conversationId: 'conv_1',
    accountId: 'acc_1',
    senderId: 'p1',
    senderName: '阿泽',
    type: 'text',
    content: { text: '在吗' },
    createdAt: Date.now(),
    status: 'delivered',
    isSelf: false,
    ...over
  }
}

const base = {
  message: message(),
  conversation,
  settings,
  activeConversationId: 'conv_1',
  appFocused: true,
  now: new Date('2026-05-20T12:00:00')
}

describe('通知策略', () => {
  it('聚焦且正在看该会话时不打扰', () => {
    expect(decideNotification(base)).toMatchObject({ notify: false, reason: 'focused' })
  })

  it('窗口失焦时弹通知', () => {
    expect(decideNotification({ ...base, appFocused: false })).toMatchObject({ notify: true, reason: 'ok' })
  })

  it('看的是别的会话时仍弹通知', () => {
    expect(decideNotification({ ...base, activeConversationId: 'conv_other' })).toMatchObject({
      notify: true,
      reason: 'ok'
    })
  })

  it('自己发的消息不通知', () => {
    expect(decideNotification({ ...base, message: message({ isSelf: true }), appFocused: false })).toMatchObject({
      notify: false,
      reason: 'self'
    })
  })

  it('系统消息不通知', () => {
    expect(decideNotification({ ...base, message: message({ type: 'system' }), appFocused: false })).toMatchObject({
      notify: false,
      reason: 'system'
    })
  })

  it('关闭通知总开关后静默', () => {
    expect(
      decideNotification({ ...base, appFocused: false, settings: { ...settings, enabled: false } })
    ).toMatchObject({ notify: false, reason: 'disabled' })
  })

  it('免打扰会话不弹通知但仍计角标', () => {
    const decision = decideNotification({
      ...base,
      appFocused: false,
      conversation: { ...conversation, muted: true }
    })
    expect(decision).toMatchObject({ notify: false, reason: 'muted', badge: true })
  })

  it('免打扰时段内静默，但保留未读角标', () => {
    const decision = decideNotification({
      ...base,
      appFocused: false,
      settings: { ...settings, dndEnabled: true },
      now: new Date('2026-05-20T23:30:00')
    })
    expect(decision).toMatchObject({ notify: false, reason: 'dnd', badge: true })
  })

  it('免打扰时段外正常通知', () => {
    const decision = decideNotification({
      ...base,
      appFocused: false,
      settings: { ...settings, dndEnabled: true },
      now: new Date('2026-05-20T09:00:00')
    })
    expect(decision.notify).toBe(true)
  })
})

describe('免打扰时段解析', () => {
  it('跨零点区间命中两端之外的时间', () => {
    expect(isWithinDnd(new Date('2026-05-20T23:10:00'), '22:00', '08:00')).toBe(true)
    expect(isWithinDnd(new Date('2026-05-20T03:10:00'), '22:00', '08:00')).toBe(true)
    expect(isWithinDnd(new Date('2026-05-20T12:00:00'), '22:00', '08:00')).toBe(false)
  })

  it('同日区间正常工作', () => {
    expect(isWithinDnd(new Date('2026-05-20T13:00:00'), '12:00', '14:00')).toBe(true)
    expect(isWithinDnd(new Date('2026-05-20T14:00:00'), '12:00', '14:00')).toBe(false)
  })

  it('非法输入不阻塞通知', () => {
    expect(isWithinDnd(new Date(), '25:00', '08:00')).toBe(false)
    expect(isWithinDnd(new Date(), '', 'abc')).toBe(false)
  })
})

describe('通知正文', () => {
  it('关闭预览时使用通用文案', () => {
    expect(notificationBody(message(), false)).toBe('收到一条新消息')
  })

  it('各消息类型生成可读摘要', () => {
    expect(notificationBody(message(), true)).toBe('在吗')
    expect(notificationBody(message({ type: 'image' }), true)).toBe('[图片]')
    expect(notificationBody(message({ type: 'file', content: { name: 'a.pdf' } }), true)).toBe('[文件] a.pdf')
    expect(notificationBody(message({ type: 'voice', content: { duration: 8 } }), true)).toBe('[语音] 8"')
  })
})
