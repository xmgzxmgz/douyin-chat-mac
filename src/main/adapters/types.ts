import type {
  Account,
  AdapterMode,
  Conversation,
  Friend,
  Message,
  MessageContent,
  Profile,
  QrLoginState,
  QrLoginTicket,
  SessionStatus
} from '@shared/types'

export interface Credentials {
  cookie: string
  userAgent?: string
  csrfToken?: string
  savedAt: number
}

export interface LoginResult {
  account: Account
  credentials: Credentials
  expiresAt: number | null
}

export interface PullResult {
  messages: Message[]
  conversations: Conversation[]
  cursor: number
}

export interface SendResult {
  message: Message
}

/**
 * 平台适配器契约。所有网络/协议细节收敛在实现内，
 * 上层（ChatService / UI）只依赖此接口，便于替换数据源与离线测试。
 */
export interface ChatAdapter {
  readonly mode: AdapterMode
  /** 是否支持发送消息。只读适配器设 false，UI 会直接给出明确提示而不是伪造失败消息 */
  readonly canSend?: boolean

  // 鉴权
  loginWithCookie(input: { cookie: string; userAgent?: string }): Promise<LoginResult>
  createQrLogin(): Promise<QrLoginTicket>
  pollQrLogin(qrId: string): Promise<QrLoginState>
  cancelQrLogin(qrId: string): Promise<void>
  restore(credentials: Credentials): Promise<Account>
  validateSession(): Promise<{ status: SessionStatus; expiresAt: number | null }>
  logout(): Promise<void>

  // 资料
  fetchProfile(): Promise<Profile>

  // 会话
  fetchConversations(): Promise<Conversation[]>

  // 消息
  pullUpdates(cursor: number): Promise<PullResult>
  fetchHistory(conversationId: string, before: number | undefined, limit: number): Promise<Message[]>
  sendMessage(input: {
    conversationId: string
    type: Message['type']
    content: MessageContent
    clientId: string
    replyTo?: Message['replyTo']
    localId: string
  }): Promise<Message>
  recallMessage(messageId: string): Promise<void>
  sendTyping(conversationId: string): Promise<void>
  /** 可选：把已读状态同步到服务端。未实现时仅本地生效。 */
  markRead?(conversationId: string): Promise<void>

  // 好友
  fetchFriends(): Promise<Friend[]>
  searchUsers(keyword: string): Promise<Friend[]>
  addFriend(userId: string, remark?: string): Promise<Friend>
  removeFriend(friendId: string): Promise<void>
  setBlocked(friendId: string, blocked: boolean): Promise<Friend>

  dispose(): void
}

export type AdapterFactory = (accountId?: string) => ChatAdapter
