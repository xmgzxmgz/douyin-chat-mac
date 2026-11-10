import React from 'react'
import type { ChatApp } from './store/useChatApp'
import { useChatApp } from './store/useChatApp'
import { Avatar } from './components/Avatar'
import { ChatView } from './components/ChatView'
import { ConversationList } from './components/ConversationList'
import { FriendsView } from './components/FriendsView'
import { Icon } from './components/Icon'
import { LoginScreen } from './components/LoginScreen'
import { SettingsView } from './components/SettingsView'

export default function App(): React.JSX.Element {
  const app = useChatApp()
  const { state } = app
  const anonymous = !state.session || state.session.status === 'anonymous'

  if (!state.ready) {
    return (
      <div className="app">
        <div className="splash">
          <span className="brand-dot big" />
          <p>正在启动…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <div className="titlebar">
        <div className="titlebar-title">抖音桌面聊天</div>
        {!anonymous ? (
          <div className={`titlebar-status ${state.sync.phase}`}>
            <span className={`sync-dot ${state.sync.phase}`} />
            {state.sync.phase === 'syncing'
              ? '同步中'
              : state.sync.phase === 'offline'
                ? '网络异常，自动重试中'
                : state.sync.phase === 'connecting'
                  ? '连接中'
                  : state.sync.lastSyncAt
                    ? `已同步 · ${new Date(state.sync.lastSyncAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
                    : '待同步'}
          </div>
        ) : null}
      </div>

      {anonymous ? (
        <LoginScreen app={app} />
      ) : (
        <div className="app-body">
          <NavRail app={app} />
          {state.view === 'chats' ? (
            <>
              <ConversationList app={app} />
              {app.activeConversation ? (
                <ChatView app={app} conversation={app.activeConversation} />
              ) : (
                <div className="chat-pane empty">
                  <div className="chat-empty">
                    <Icon name="chat" size={30} />
                    <p>选择一个会话开始聊天</p>
                    <span>支持文字、图片、文件、表情与消息撤回</span>
                  </div>
                </div>
              )}
            </>
          ) : state.view === 'friends' ? (
            <FriendsView app={app} />
          ) : (
            <SettingsView app={app} />
          )}
        </div>
      )}

      {state.toast ? (
        <div className={`toast ${state.toast.level}`} key={state.toast.id}>
          <Icon
            name={state.toast.level === 'error' ? 'alert' : state.toast.level === 'success' ? 'check' : 'chat'}
            size={15}
          />
          {state.toast.text}
        </div>
      ) : null}
    </div>
  )
}

function NavRail({ app }: { app: ChatApp }): React.JSX.Element {
  const { state, totalUnread, actions } = app
  const account = state.session?.account

  return (
    <nav className="rail">
      <div className="rail-logo">
        <span className="brand-dot" />
      </div>

      <div className="rail-items">
        <button
          className={`rail-btn ${state.view === 'chats' ? 'active' : ''}`}
          onClick={() => actions.selectView('chats')}
          title="消息"
        >
          <Icon name="chat" size={21} />
          {totalUnread > 0 ? <i className="rail-badge">{totalUnread > 99 ? '99+' : totalUnread}</i> : null}
        </button>
        <button
          className={`rail-btn ${state.view === 'friends' ? 'active' : ''}`}
          onClick={() => actions.selectView('friends')}
          title="好友"
        >
          <Icon name="users" size={21} />
        </button>
        <button
          className={`rail-btn ${state.view === 'settings' ? 'active' : ''}`}
          onClick={() => actions.selectView('settings')}
          title="设置"
        >
          <Icon name="settings" size={21} />
        </button>
      </div>

      <button className="rail-avatar" onClick={() => actions.selectView('settings')} title={account?.nickname}>
        <Avatar src={account?.avatarUrl} name={account?.nickname ?? '我'} size={34} />
      </button>
    </nav>
  )
}
