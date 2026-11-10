import React, { useState } from 'react'
import type { Conversation } from '@shared/types'
import type { ChatApp } from '../store/useChatApp'
import { formatListTime } from '../lib/format'
import { Avatar } from './Avatar'
import { Icon } from './Icon'

export function ConversationList({ app }: { app: ChatApp }): React.JSX.Element {
  const { state, filteredConversations, actions } = app
  const [menuFor, setMenuFor] = useState<string | null>(null)

  return (
    <div className="list-pane">
      <div className="list-search">
        <Icon name="search" size={16} />
        <input
          value={state.query}
          onChange={(e) => actions.setQuery(e.target.value)}
          placeholder="搜索会话或消息内容"
          spellCheck={false}
        />
        {state.query ? (
          <button className="icon-btn tiny" onClick={() => actions.setQuery('')}>
            <Icon name="close" size={13} />
          </button>
        ) : null}
      </div>

      <div className="list-filters">
        <button className={state.filter === 'all' ? 'chip active' : 'chip'} onClick={() => actions.setFilter('all')}>
          全部
        </button>
        <button
          className={state.filter === 'unread' ? 'chip active' : 'chip'}
          onClick={() => actions.setFilter('unread')}
        >
          未读
          {state.conversations.some((c) => c.unreadCount > 0) ? (
            <span className="chip-dot">{state.conversations.reduce((s, c) => s + c.unreadCount, 0)}</span>
          ) : null}
        </button>
      </div>

      <div className="list-scroll">
        {filteredConversations.length === 0 ? (
          <div className="list-empty">
            <Icon name="chat" size={22} />
            <p>{state.query ? '没有匹配的会话' : '暂无会话'}</p>
          </div>
        ) : null}

        {filteredConversations.map((conv) => (
          <ConversationRow
            key={conv.id}
            conv={conv}
            active={conv.id === state.activeId}
            menuOpen={menuFor === conv.id}
            onOpenMenu={() => setMenuFor(menuFor === conv.id ? null : conv.id)}
            onCloseMenu={() => setMenuFor(null)}
            onSelect={() => {
              setMenuFor(null)
              void actions.openConversation(conv.id)
            }}
            app={app}
          />
        ))}
      </div>

      <div className="list-footer">
        <span className={`sync-dot ${state.sync.phase}`} />
        <span>
          {state.sync.phase === 'syncing'
            ? '同步中'
            : state.sync.phase === 'offline'
              ? '离线，重试中'
              : state.sync.phase === 'error'
                ? '同步异常'
                : '已同步'}
        </span>
        <button className="link-btn small" onClick={() => void window.desktop.app.syncNow()}>
          立即同步
        </button>
      </div>
    </div>
  )
}

function ConversationRow({
  conv,
  active,
  app,
  menuOpen,
  onOpenMenu,
  onCloseMenu,
  onSelect
}: {
  conv: Conversation
  active: boolean
  app: ChatApp
  menuOpen: boolean
  onOpenMenu: () => void
  onCloseMenu: () => void
  onSelect: () => void
}): React.JSX.Element {
  return (
    <div
      className={`conv ${active ? 'active' : ''}`}
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault()
        onOpenMenu()
      }}
    >
      <Avatar src={conv.avatarUrl} name={conv.title} size={46} square={conv.type === 'group'} />
      <div className="conv-body">
        <div className="conv-top">
          <span className="conv-title">
            {conv.pinned ? <Icon name="pin" size={12} className="pin-icon" /> : null}
            {conv.title}
            {conv.type === 'group' ? <em className="conv-tag">群</em> : null}
          </span>
          <span className="conv-time">{formatListTime(conv.lastMessageAt)}</span>
        </div>
        <div className="conv-bottom">
          <span className="conv-preview">{conv.lastMessagePreview || '暂无消息'}</span>
          <span className="conv-badges">
            {conv.muted ? <Icon name="bellOff" size={13} className="muted-icon" /> : null}
            {conv.unreadCount > 0 ? (
              <i className={conv.muted ? 'badge muted' : 'badge'}>{conv.unreadCount > 99 ? '99+' : conv.unreadCount}</i>
            ) : null}
          </span>
        </div>
      </div>

      <button
        className="conv-more"
        onClick={(e) => {
          e.stopPropagation()
          onOpenMenu()
        }}
        aria-label="更多"
      >
        <Icon name="more" size={16} />
      </button>

      {menuOpen ? (
        <>
          <div className="menu-backdrop" onClick={onCloseMenu} />
          <div className="context-menu" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => {
                void app.actions.setPinned(conv.id, !conv.pinned)
                onCloseMenu()
              }}
            >
              <Icon name="pin" size={15} /> {conv.pinned ? '取消置顶' : '置顶会话'}
            </button>
            <button
              onClick={() => {
                void app.actions.setMuted(conv.id, !conv.muted)
                onCloseMenu()
              }}
            >
              <Icon name={conv.muted ? 'bell' : 'bellOff'} size={15} /> {conv.muted ? '开启提醒' : '消息免打扰'}
            </button>
            <button
              onClick={() => {
                void window.desktop.conversations.markRead(conv.id)
                onCloseMenu()
              }}
            >
              <Icon name="check" size={15} /> 标为已读
            </button>
            <button
              onClick={() => {
                void window.desktop.app.exportConversation(conv.id)
                onCloseMenu()
              }}
            >
              <Icon name="download" size={15} /> 导出聊天记录
            </button>
          </div>
        </>
      ) : null}
    </div>
  )
}
