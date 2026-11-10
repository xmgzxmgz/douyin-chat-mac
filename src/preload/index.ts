import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type DesktopApi } from '../shared/ipc'

/* eslint-disable @typescript-eslint/no-explicit-any */
const invoke = (channel: string, ...args: unknown[]): any => ipcRenderer.invoke(channel, ...args)

const api: DesktopApi = {
  auth: {
    loginWithCookie: (input) => invoke(IPC.authLoginCookie, input),
    loginInApp: () => invoke(IPC.authLoginDouyin),
    createQrLogin: () => invoke(IPC.authLoginQr),
    pollQr: (qrId) => invoke(IPC.authPollQr, qrId),
    cancelQr: (qrId) => invoke(IPC.authCancelQr, qrId),
    logout: () => invoke(IPC.authLogout),
    session: () => invoke(IPC.authSession),
    accounts: () => invoke(IPC.authAccounts),
    switchAccount: (accountId) => invoke(IPC.authSwitch, accountId)
  },
  conversations: {
    list: () => invoke(IPC.convList),
    setPinned: (id, pinned) => invoke(IPC.convPin, id, pinned),
    setMuted: (id, muted) => invoke(IPC.convMute, id, muted),
    markRead: (id) => invoke(IPC.convRead, id),
    setActive: (id) => invoke(IPC.convActive, id),
    setHidden: (id, hidden) => invoke(IPC.convHide, id, hidden),
    setDraft: (id, draft) => invoke(IPC.convDraft, id, draft),
    find: (keyword) => invoke(IPC.convFind, keyword)
  },
  messages: {
    history: (query) => invoke(IPC.msgHistory, query),
    send: (input) => invoke(IPC.msgSend, input),
    retry: (clientId) => invoke(IPC.msgRetry, clientId),
    recall: (id) => invoke(IPC.msgRecall, id),
    deleteLocal: (id) => invoke(IPC.msgDeleteLocal, id),
    typing: (conversationId) => invoke(IPC.msgTyping, conversationId)
  },
  friends: {
    list: () => invoke(IPC.friendList),
    search: (keyword) => invoke(IPC.friendSearch, keyword),
    add: (userId, remark) => invoke(IPC.friendAdd, userId, remark),
    remove: (id) => invoke(IPC.friendRemove, id),
    setBlocked: (id, blocked) => invoke(IPC.friendBlock, id, blocked),
    setRemark: (id, remark) => invoke(IPC.friendRemark, id, remark)
  },
  settings: {
    get: () => invoke(IPC.settingsGet),
    update: (patch) => invoke(IPC.settingsUpdate, patch)
  },
  app: {
    info: () => invoke(IPC.appInfo),
    syncNow: () => invoke(IPC.appSync),
    openExternal: (url) => invoke(IPC.appOpenExternal, url),
    peekOpen: (url) => invoke(IPC.peekOpen, url),
    peekClose: () => invoke(IPC.peekClose),
    exportConversation: (id) => invoke(IPC.appExport, id),
    clearCache: () => invoke(IPC.appClearCache),
    quit: () => invoke(IPC.appQuit)
  },
  onEvent: (listener) => {
    const handler = (_e: unknown, payload: never) => listener(payload)
    ipcRenderer.on(IPC.event, handler as never)
    return () => ipcRenderer.removeListener(IPC.event, handler as never)
  }
}

contextBridge.exposeInMainWorld('desktop', api)
