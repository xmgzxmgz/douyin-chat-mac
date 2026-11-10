/**
 * 领域模型（主进程与渲染进程共享）
 * 所有时间字段均为毫秒级 Unix 时间戳。
 */

export type ID = string

export type AdapterMode = 'mock' | 'douyin-web'

export interface Profile {
  id: ID
  nickname: string
  avatarUrl: string
  uniqueId?: string
  signature?: string
  followerCount?: number
  followingCount?: number
}

export interface Account extends Profile {
  accountId: ID
  mode: AdapterMode
  createdAt: number
  lastLoginAt: number
}

export type SessionStatus = 'anonymous' | 'active' | 'expiring' | 'expired'

export interface SessionInfo {
  status: SessionStatus
  account: Account | null
  expiresAt: number | null
  mode: AdapterMode
  lastSyncAt: number | null
}

export type ConversationType = 'private' | 'group' | 'system'

export interface Conversation {
  id: ID
  accountId: ID
  type: ConversationType
  title: string
  avatarUrl: string
  peerId: ID
  memberCount?: number
  lastMessageAt: number
  lastMessagePreview: string
  unreadCount: number
  mentionCount: number
  pinned: boolean
  muted: boolean
  hidden: boolean
  draft: string
  /** 本地已读水位：服务端返回的未读若已被本地读过，则不再回涨 */
  readAt?: number
  updatedAt: number
}

export type MessageType = 'text' | 'image' | 'emoji' | 'voice' | 'file' | 'video' | 'share' | 'system'

export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'recalled'

export interface MessageContent {
  text?: string
  url?: string
  thumbUrl?: string
  name?: string
  size?: number
  mime?: string
  width?: number
  height?: number
  duration?: number
  emojiName?: string
  title?: string
  desc?: string
  /** 分享卡片的封面图 */
  coverUrl?: string
  /** 卡片来源作者（评论分享、视频作者） */
  author?: string
  /** 视频 / 图文的 item id，用于拼公开链接 */
  itemId?: string
  /** 卡片角标：视频 / 图文 / 评论 / 直播 / 商品 / 名片 */
  kind?: string
}

export interface ReplyRef {
  messageId: ID
  senderName: string
  preview: string
}

export interface Message {
  id: ID
  clientId: string
  conversationId: ID
  accountId: ID
  senderId: ID
  senderName: string
  senderAvatar?: string
  /** 发送者的 sec_uid（抖音加密 ID），用于查询昵称 */
  senderSecUid?: string
  type: MessageType
  content: MessageContent
  createdAt: number
  status: MessageStatus
  isSelf: boolean
  replyTo?: ReplyRef
  recalledAt?: number
  errorCode?: string
  errorMessage?: string
}

export interface Friend {
  id: ID
  accountId: ID
  nickname: string
  remark?: string
  avatarUrl: string
  uniqueId?: string
  signature?: string
  online: boolean
  blocked: boolean
  createdAt: number
}

export interface NotificationSettings {
  enabled: boolean
  sound: boolean
  showPreview: boolean
  badge: boolean
  dndEnabled: boolean
  dndStart: string
  dndEnd: string
}

export interface AppSettings {
  mode: AdapterMode
  theme: 'light' | 'dark' | 'system'
  sendKey: 'enter' | 'cmd+enter'
  autoLaunch: boolean
  closeToTray: boolean
  pollIntervalMs: number
  historyPageSize: number
  notifications: NotificationSettings
}

export type SyncPhase = 'idle' | 'connecting' | 'syncing' | 'offline' | 'error'

export interface SyncStatus {
  phase: SyncPhase
  lastSyncAt: number | null
  error?: string
  latencyMs?: number
}

export interface ConversationSummary {
  conversation: Conversation
  peer?: Friend
}

export interface SendMessageInput {
  conversationId: ID
  type: MessageType
  content: MessageContent
  replyTo?: ReplyRef
}

export interface HistoryQuery {
  conversationId: ID
  before?: number
  limit?: number
}

export interface QrLoginTicket {
  qrId: string
  imageDataUrl: string
  expiresAt: number
}

export type QrLoginState =
  | { state: 'pending' }
  | { state: 'scanned' }
  | { state: 'confirmed'; session: SessionInfo }
  | { state: 'expired' }
  | { state: 'error'; message: string }

export type AppEvent =
  | { type: 'conversations:updated'; payload: Conversation[] }
  | { type: 'messages:new'; payload: Message[] }
  | { type: 'message:updated'; payload: Message }
  | { type: 'friends:updated'; payload: Friend[] }
  | { type: 'session:changed'; payload: SessionInfo }
  | { type: 'sync:status'; payload: SyncStatus }
  | { type: 'typing'; payload: { conversationId: ID; peerName: string; at: number } }
  | { type: 'ui:open-conversation'; payload: { conversationId: ID } }
  | { type: 'toast'; payload: { level: 'info' | 'success' | 'warn' | 'error'; text: string } }

export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  dataDir: string
  adapter: AdapterMode
}
