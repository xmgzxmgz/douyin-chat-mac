import type { Conversation, Message, NotificationSettings } from '@shared/types'

export interface NotifyDecision {
  notify: boolean
  sound: boolean
  badge: boolean
  reason: string
}

export interface NotifyContext {
  message: Message
  conversation: Conversation
  settings: NotificationSettings
  activeConversationId: string | null
  appFocused: boolean
  now: Date
}

/** 判断当前时刻是否处于免打扰区间，支持跨零点（如 22:00 → 08:00） */
export function isWithinDnd(now: Date, start: string, end: string): boolean {
  const parse = (s: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
    if (!m) return null
    const h = Number(m[1])
    const min = Number(m[2])
    if (h > 23 || min > 59) return null
    return h * 60 + min
  }
  const s = parse(start)
  const e = parse(end)
  if (s === null || e === null) return false
  if (s === e) return true
  const cur = now.getHours() * 60 + now.getMinutes()
  return s < e ? cur >= s && cur < e : cur >= s || cur < e
}

/**
 * 通知决策（纯函数，便于单测）：
 * 自己发的、当前正在看的会话、免打扰时段、关闭通知 → 不弹通知。
 * 免打扰/免打扰会话仍保留未读计数与角标。
 */
export function decideNotification(ctx: NotifyContext): NotifyDecision {
  const { message, conversation, settings, activeConversationId, appFocused, now } = ctx
  const base = { badge: settings.badge, sound: settings.sound }
  if (message.isSelf) return { ...base, notify: false, reason: 'self' }
  if (message.type === 'system') return { ...base, notify: false, reason: 'system' }
  if (!settings.enabled) return { ...base, notify: false, reason: 'disabled' }
  if (appFocused && activeConversationId === conversation.id) return { ...base, notify: false, reason: 'focused' }
  if (conversation.muted) return { ...base, notify: false, reason: 'muted' }
  if (settings.dndEnabled && isWithinDnd(now, settings.dndStart, settings.dndEnd)) {
    return { ...base, notify: false, reason: 'dnd' }
  }
  return { ...base, notify: true, reason: 'ok' }
}

export function notificationBody(message: Message, showPreview: boolean): string {
  if (!showPreview) return '收到一条新消息'
  switch (message.type) {
    case 'text':
      return message.content.text ?? ''
    case 'image':
      return '[图片]'
    case 'emoji':
      return `[${message.content.emojiName ?? '表情'}]`
    case 'voice':
      return `[语音] ${message.content.duration ?? 0}"`
    case 'file':
      return `[文件] ${message.content.name ?? ''}`
    case 'share':
      return `[分享] ${message.content.title ?? ''}`
    default:
      return '收到一条新消息'
  }
}
