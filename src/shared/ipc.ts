import type {
  Account,
  AppEvent,
  AppInfo,
  AppSettings,
  Conversation,
  Friend,
  HistoryQuery,
  Message,
  QrLoginState,
  QrLoginTicket,
  SessionInfo,
  SendMessageInput,
  SyncStatus
} from './types'

export type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }

export const IPC = {
  authLoginCookie: 'auth:login-cookie',
  authLoginDouyin: 'auth:login-douyin',
  authLoginQr: 'auth:login-qr',
  authPollQr: 'auth:poll-qr',
  authCancelQr: 'auth:cancel-qr',
  authLogout: 'auth:logout',
  authSession: 'auth:session',
  authAccounts: 'auth:accounts',
  authSwitch: 'auth:switch',

  convList: 'conv:list',
  convPin: 'conv:pin',
  convMute: 'conv:mute',
  convRead: 'conv:read',
  convActive: 'conv:active',
  convHide: 'conv:hide',
  convDraft: 'conv:draft',
  convFind: 'conv:find',

  msgHistory: 'msg:history',
  msgSend: 'msg:send',
  msgRetry: 'msg:retry',
  msgRecall: 'msg:recall',
  msgDeleteLocal: 'msg:delete-local',
  msgTyping: 'msg:typing',

  friendList: 'friend:list',
  friendSearch: 'friend:search',
  friendAdd: 'friend:add',
  friendRemove: 'friend:remove',
  friendBlock: 'friend:block',
  friendRemark: 'friend:remark',

  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',

  appInfo: 'app:info',
  appSync: 'app:sync',
  peekOpen: 'peek:open',
  peekClose: 'peek:close',
  appOpenExternal: 'app:open-external',
  appExport: 'app:export',
  appClearCache: 'app:clear-cache',
  appQuit: 'app:quit',

  event: 'app:event'
} as const

export interface DesktopApi {
  auth: {
    loginWithCookie(input: { cookie: string; userAgent?: string }): Promise<Result<SessionInfo>>
    /** 应用内打开抖音网页登录，自动捕获会话 */
    loginInApp(): Promise<Result<SessionInfo>>
    createQrLogin(): Promise<Result<QrLoginTicket>>
    pollQr(qrId: string): Promise<Result<QrLoginState>>
    cancelQr(qrId: string): Promise<Result<void>>
    logout(): Promise<Result<void>>
    session(): Promise<Result<SessionInfo>>
    accounts(): Promise<Result<Account[]>>
    switchAccount(accountId: string): Promise<Result<SessionInfo>>
  }
  conversations: {
    list(): Promise<Result<Conversation[]>>
    setPinned(id: string, pinned: boolean): Promise<Result<Conversation>>
    setMuted(id: string, muted: boolean): Promise<Result<Conversation>>
    markRead(id: string): Promise<Result<Conversation>>
    /** 告知主进程当前正在查看的会话，用于抑制重复通知 */
    setActive(id: string | null): Promise<Result<void>>
    setHidden(id: string, hidden: boolean): Promise<Result<Conversation>>
    setDraft(id: string, draft: string): Promise<Result<void>>
    find(keyword: string): Promise<Result<Conversation[]>>
  }
  messages: {
    history(query: HistoryQuery): Promise<Result<Message[]>>
    send(input: SendMessageInput): Promise<Result<Message>>
    retry(clientId: string): Promise<Result<Message>>
    recall(id: string): Promise<Result<Message>>
    deleteLocal(id: string): Promise<Result<void>>
    typing(conversationId: string): Promise<Result<void>>
  }
  friends: {
    list(): Promise<Result<Friend[]>>
    search(keyword: string): Promise<Result<Friend[]>>
    add(userId: string, remark?: string): Promise<Result<Friend>>
    remove(id: string): Promise<Result<void>>
    setBlocked(id: string, blocked: boolean): Promise<Result<Friend>>
    setRemark(id: string, remark: string): Promise<Result<Friend>>
  }
  settings: {
    get(): Promise<Result<AppSettings>>
    update(patch: Partial<AppSettings>): Promise<Result<AppSettings>>
  }
  app: {
    info(): Promise<Result<AppInfo>>
    syncNow(): Promise<Result<SyncStatus>>
    openExternal(url: string): Promise<Result<void>>
    peekOpen(url: string): Promise<Result<void>>
    peekClose(): Promise<Result<void>>
    exportConversation(id: string): Promise<Result<{ path: string }>>
    clearCache(): Promise<Result<void>>
    quit(): Promise<Result<void>>
  }
  onEvent(listener: (event: AppEvent) => void): () => void
}

declare global {
  interface Window {
    desktop: DesktopApi
  }
}
