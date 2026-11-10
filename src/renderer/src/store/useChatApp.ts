import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type {
  AppSettings,
  AppEvent,
  Conversation,
  Friend,
  Message,
  MessageContent,
  MessageType,
  ReplyRef,
  SessionInfo,
  SyncStatus
} from '@shared/types'

export type View = 'chats' | 'friends' | 'settings'
export type Filter = 'all' | 'unread'

export interface AppState {
  ready: boolean
  session: SessionInfo | null
  conversations: Conversation[]
  friends: Friend[]
  settings: AppSettings | null
  sync: SyncStatus
  activeId: string | null
  messages: Record<string, Message[]>
  view: View
  filter: Filter
  query: string
  replyTo: ReplyRef | null
  toast: { id: number; level: 'info' | 'success' | 'warn' | 'error'; text: string } | null
  loadingMore: boolean
}

type Action =
  | { type: 'ready' }
  | { type: 'bootstrap'; session: SessionInfo; conversations: Conversation[]; friends: Friend[]; settings: AppSettings; sync: SyncStatus }
  | { type: 'session'; session: SessionInfo }
  | { type: 'conversations'; conversations: Conversation[] }
  | { type: 'friends'; friends: Friend[] }
  | { type: 'sync'; sync: SyncStatus }
  | { type: 'settings'; settings: AppSettings }
  | { type: 'messages'; conversationId: string; messages: Message[]; mode: 'merge' | 'replace' }
  | { type: 'message:upsert'; message: Message }
  | { type: 'active'; id: string | null }
  | { type: 'view'; view: View }
  | { type: 'filter'; filter: Filter }
  | { type: 'query'; query: string }
  | { type: 'reply'; replyTo: ReplyRef | null }
  | { type: 'toast'; toast: AppState['toast'] }
  | { type: 'loading-more'; value: boolean }

const initialState: AppState = {
  ready: false,
  session: null,
  conversations: [],
  friends: [],
  settings: null,
  sync: { phase: 'idle', lastSyncAt: null },
  activeId: null,
  messages: {},
  view: 'chats',
  filter: 'all',
  query: '',
  replyTo: null,
  toast: null,
  loadingMore: false
}

function mergeMessages(base: Message[], incoming: Message[]): Message[] {
  const map = new Map<string, Message>()
  for (const m of base) map.set(m.clientId || m.id, m)
  for (const m of incoming) {
    const key = m.clientId || m.id
    const prev = map.get(key)
    map.set(key, prev ? { ...prev, ...m } : m)
  }
  return [...map.values()].sort((a, b) => a.createdAt - b.createdAt)
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'ready':
      return { ...state, ready: true }
    case 'bootstrap':
      return {
        ...state,
        ready: true,
        session: action.session,
        conversations: action.conversations,
        friends: action.friends,
        settings: action.settings,
        sync: action.sync,
        activeId: state.activeId ?? action.conversations[0]?.id ?? null
      }
    case 'session':
      return {
        ...state,
        session: action.session,
        conversations: action.session.status === 'anonymous' ? [] : state.conversations,
        friends: action.session.status === 'anonymous' ? [] : state.friends,
        messages: action.session.status === 'anonymous' ? {} : state.messages,
        activeId: action.session.status === 'anonymous' ? null : state.activeId
      }
    case 'conversations':
      return { ...state, conversations: action.conversations }
    case 'friends':
      return { ...state, friends: action.friends }
    case 'sync':
      return { ...state, sync: action.sync }
    case 'settings':
      return { ...state, settings: action.settings }
    case 'messages': {
      const current = state.messages[action.conversationId] ?? []
      return {
        ...state,
        messages: {
          ...state.messages,
          [action.conversationId]:
            action.mode === 'replace' ? action.messages : mergeMessages(current, action.messages)
        }
      }
    }
    case 'message:upsert': {
      const m = action.message
      const current = state.messages[m.conversationId] ?? []
      return {
        ...state,
        messages: { ...state.messages, [m.conversationId]: mergeMessages(current, [m]) }
      }
    }
    case 'active':
      return { ...state, activeId: action.id, replyTo: null }
    case 'view':
      return { ...state, view: action.view }
    case 'filter':
      return { ...state, filter: action.filter }
    case 'query':
      return { ...state, query: action.query }
    case 'reply':
      return { ...state, replyTo: action.replyTo }
    case 'toast':
      return { ...state, toast: action.toast }
    case 'loading-more':
      return { ...state, loadingMore: action.value }
    default:
      return state
  }
}

let toastSeq = 0

export function useChatApp() {
  const [state, dispatch] = useReducer(reducer, initialState)
  /** 右侧「手机预览」由主进程开独立窗口，这里只保留最近一次打开的内容用于提示 */
  const [peek, setPeek] = useState<SharePeek | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state

  const toast = useCallback((level: 'info' | 'success' | 'warn' | 'error', text: string) => {
    dispatch({ type: 'toast', toast: { id: ++toastSeq, level, text } })
  }, [])

  const refresh = useCallback(async () => {
    const [session, conversations, friends, settings] = await Promise.all([
      window.desktop.auth.session(),
      window.desktop.conversations.list(),
      window.desktop.friends.list(),
      window.desktop.settings.get()
    ])
    if (!session.ok) {
      toast('error', session.error.message)
      return
    }
    dispatch({
      type: 'bootstrap',
      session: session.data,
      conversations: conversations.ok ? conversations.data : [],
      friends: friends.ok ? friends.data : [],
      settings: settings.ok ? settings.data : ({} as AppSettings),
      sync: { phase: 'idle', lastSyncAt: null }
    })
  }, [toast])

  const loadMessages = useCallback(
    async (conversationId: string) => {
      const res = await window.desktop.messages.history({ conversationId, limit: 40 })
      if (res.ok) {
        dispatch({
          type: 'messages',
          conversationId,
          messages: [...res.data].sort((a, b) => a.createdAt - b.createdAt),
          mode: 'replace'
        })
      }
    },
    []
  )

  /**
   * 兜底：bootstrap 会把列表第一项直接设为 activeId（不经过 openConversation），
   * 此时消息区是空的。只要 activeId 指向的会话还没有加载过消息，就补一次加载。
   */
  const loadedConversations = useRef(new Set<string>())
  useEffect(() => {
    const id = state.activeId
    if (!id) return
    if (state.messages[id] !== undefined) return
    if (loadedConversations.current.has(id)) return
    loadedConversations.current.add(id)
    void loadMessages(id)
  }, [state.activeId, state.messages, loadMessages])

  const openConversation = useCallback(
    async (id: string) => {
      dispatch({ type: 'active', id })
      dispatch({ type: 'view', view: 'chats' })
      void window.desktop.conversations.setActive(id)
      await loadMessages(id)
      const res = await window.desktop.conversations.markRead(id)
      if (res.ok) {
        const list = await window.desktop.conversations.list()
        if (list.ok) dispatch({ type: 'conversations', conversations: list.data })
      }
    },
    [loadMessages]
  )

  useEffect(() => {
    void (async () => {
      const [initial, settings] = await Promise.all([
        window.desktop.auth.session(),
        window.desktop.settings.get()
      ])
      if (settings.ok) dispatch({ type: 'settings', settings: settings.data })

      if (initial.ok && initial.data.status !== 'anonymous') {
        await refresh()
        const list = await window.desktop.conversations.list()
        const first = list.ok ? list.data[0] : undefined
        if (first) await openConversation(first.id)
        return
      }

      // 真实模式恢复会话要起隐藏窗口、拉首屏，比渲染进程慢好几秒。
      // 先让界面出来（登录页），再在后台等恢复结果，避免卡在「正在启动…」。
      dispatch({ type: 'ready' })
      void (async () => {
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 1000))
          const next = await window.desktop.auth.session()
          if (next.ok && next.data.status !== 'anonymous') {
            dispatch({ type: 'session', session: next.data })
            await refresh()
            const list = await window.desktop.conversations.list()
            const first = list.ok ? list.data[0] : undefined
            if (first) await openConversation(first.id)
            return
          }
        }
      })()
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const off = window.desktop.onEvent((event: AppEvent) => {
      switch (event.type) {
        case 'conversations:updated':
          dispatch({ type: 'conversations', conversations: event.payload })
          break
        case 'friends:updated':
          dispatch({ type: 'friends', friends: event.payload })
          break
        case 'sync:status':
          dispatch({ type: 'sync', sync: event.payload })
          break
        case 'session:changed':
          dispatch({ type: 'session', session: event.payload })
          if (event.payload.status !== 'anonymous') void refresh()
          break
        case 'messages:new': {
          const activeId = stateRef.current.activeId
          const mine = event.payload.filter((m) => m.conversationId === activeId)
          if (activeId && mine.length) {
            dispatch({ type: 'messages', conversationId: activeId, messages: mine, mode: 'merge' })
            void window.desktop.conversations.markRead(activeId)
          }
          break
        }
        case 'message:updated':
          dispatch({ type: 'message:upsert', message: event.payload })
          break
        case 'ui:open-conversation':
          void openConversation(event.payload.conversationId)
          break
        case 'toast':
          toast(event.payload.level, event.payload.text)
          break
        default:
          break
      }
    })
    return off
  }, [openConversation, refresh, toast])

  useEffect(() => {
    if (!state.toast) return
    const timer = setTimeout(() => dispatch({ type: 'toast', toast: null }), 2800)
    return () => clearTimeout(timer)
  }, [state.toast])

  const send = useCallback(
    async (type: MessageType, content: MessageContent, replyTo?: ReplyRef | null): Promise<boolean> => {
      const activeId = stateRef.current.activeId
      if (!activeId) return false
      const res = await window.desktop.messages.send({
        conversationId: activeId,
        type,
        content,
        replyTo: replyTo ?? undefined
      })
      if (res.ok) {
        dispatch({ type: 'message:upsert', message: res.data })
        return true
      }
      // 失败时把输入内容留在输入框里，别让用户白打一遍
      toast('error', res.error.message)
      return false
    },
    [toast]
  )

  const retry = useCallback(
    async (clientId: string) => {
      const res = await window.desktop.messages.retry(clientId)
      if (!res.ok) toast('error', res.error.message)
    },
    [toast]
  )

  const recall = useCallback(
    async (id: string) => {
      const res = await window.desktop.messages.recall(id)
      if (!res.ok) toast('error', res.error.message)
      else toast('success', '已撤回')
    },
    [toast]
  )

  const loadMore = useCallback(async () => {
    const { activeId, messages } = stateRef.current
    if (!activeId) return
    const oldest = messages[activeId]?.[0]?.createdAt
    dispatch({ type: 'loading-more', value: true })
    const res = await window.desktop.messages.history({ conversationId: activeId, before: oldest, limit: 30 })
    dispatch({ type: 'loading-more', value: false })
    if (res.ok && res.data.length) {
      dispatch({ type: 'messages', conversationId: activeId, messages: res.data, mode: 'merge' })
    }
  }, [])

  const setPinned = useCallback(async (id: string, pinned: boolean) => {
    await window.desktop.conversations.setPinned(id, pinned)
  }, [])

  const setMuted = useCallback(async (id: string, muted: boolean) => {
    await window.desktop.conversations.setMuted(id, muted)
  }, [])

  const updateSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      const res = await window.desktop.settings.update(patch)
      if (res.ok) dispatch({ type: 'settings', settings: res.data })
      else toast('error', res.error.message)
    },
    [toast]
  )

  const saveDraft = useCallback((id: string, text: string) => {
    void window.desktop.conversations.setDraft(id, text)
  }, [])

  const loginWithCookie = useCallback(
    async (cookie: string, userAgent?: string) => {
      const res = await window.desktop.auth.loginWithCookie({ cookie, userAgent })
      if (!res.ok) {
        toast('error', res.error.message)
        return false
      }
      await refresh()
      const list = await window.desktop.conversations.list()
      if (list.ok && list.data[0]) await openConversation(list.data[0].id)
      return true
    },
    [openConversation, refresh, toast]
  )

  const logout = useCallback(async () => {
    await window.desktop.auth.logout()
    dispatch({ type: 'session', session: { status: 'anonymous', account: null, expiresAt: null, mode: 'mock', lastSyncAt: null } })
  }, [])

  const switchAccount = useCallback(
    async (accountId: string) => {
      const res = await window.desktop.auth.switchAccount(accountId)
      if (!res.ok) {
        toast('error', res.error.message)
        return false
      }
      await refresh()
      const list = await window.desktop.conversations.list()
      if (list.ok && list.data[0]) await openConversation(list.data[0].id)
      toast('success', `已切换到 ${res.data.account?.nickname ?? '该账号'}`)
      return true
    },
    [openConversation, refresh, toast]
  )

  const addFriend = useCallback(
    async (userId: string, remark?: string) => {
      const res = await window.desktop.friends.add(userId, remark)
      if (!res.ok) toast('error', res.error.message)
      else toast('success', '已添加好友')
    },
    [toast]
  )

  const addFriendByKeyword = useCallback(
    async (keyword: string) => {
      const found = await window.desktop.friends.search(keyword)
      if (!found.ok || !found.data.length) {
        toast('warn', '未找到匹配的用户')
        return
      }
      await addFriend(found.data[0].id)
    },
    [addFriend, toast]
  )

  const setBlocked = useCallback(
    async (id: string, blocked: boolean) => {
      const res = await window.desktop.friends.setBlocked(id, blocked)
      if (!res.ok) toast('error', res.error.message)
    },
    [toast]
  )

  const setRemark = useCallback(
    async (id: string, remark: string) => {
      const res = await window.desktop.friends.setRemark(id, remark)
      if (!res.ok) toast('error', res.error.message)
    },
    [toast]
  )

  const removeFriend = useCallback(
    async (id: string) => {
      const res = await window.desktop.friends.remove(id)
      if (!res.ok) toast('error', res.error.message)
      else toast('success', '已删除好友')
    },
    [toast]
  )

  const filteredConversations = useMemo(() => {
    const k = state.query.trim().toLowerCase()
    return state.conversations.filter((c) => {
      if (state.filter === 'unread' && c.unreadCount === 0) return false
      if (!k) return true
      return c.title.toLowerCase().includes(k) || c.lastMessagePreview.toLowerCase().includes(k)
    })
  }, [state.conversations, state.filter, state.query])

  const activeConversation = useMemo(
    () => state.conversations.find((c) => c.id === state.activeId) ?? null,
    [state.activeId, state.conversations]
  )

  const totalUnread = useMemo(
    () => state.conversations.reduce((sum, c) => sum + c.unreadCount, 0),
    [state.conversations]
  )

  const selectView = useCallback((view: View) => {
    dispatch({ type: 'view', view })
    void window.desktop.conversations.setActive(view === 'chats' ? stateRef.current.activeId : null)
  }, [])
  const setFilter = useCallback((filter: Filter) => dispatch({ type: 'filter', filter }), [])
  const setQuery = useCallback((query: string) => dispatch({ type: 'query', query }), [])
  const setReply = useCallback((replyTo: ReplyRef | null) => dispatch({ type: 'reply', replyTo }), [])

  return {
    state,
    filteredConversations,
    activeConversation,
    totalUnread,
    peek,
    actions: {
      openPeek: (payload: SharePeek) => {
        setPeek(payload)
        void window.desktop.app.peekOpen(payload.url)
      },
      closePeek: () => {
        setPeek(null)
        void window.desktop.app.peekClose()
      },
      refresh,
      openConversation,
      send,
      retry,
      recall,
      loadMore,
      setPinned,
      setMuted,
      updateSettings,
      saveDraft,
      loginWithCookie,
      logout,
      switchAccount,
      addFriend,
      addFriendByKeyword,
      setBlocked,
      setRemark,
      removeFriend,
      selectView,
      setFilter,
      setQuery,
      setReply,
      toast
    }
  }
}

export interface SharePeek {
  url: string
  title: string
  kind?: string
}

export type ChatApp = ReturnType<typeof useChatApp>
