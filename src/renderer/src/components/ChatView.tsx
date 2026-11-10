import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { Conversation, Message } from '@shared/types'
import type { ChatApp } from '../store/useChatApp'
import { dayLabel, formatListTime } from '../lib/format'
import { Avatar } from './Avatar'
import { Composer } from './Composer'
import { Icon } from './Icon'
import { MessageItem } from './MessageItem'

export function ChatView({ app, conversation }: { app: ChatApp; conversation: Conversation }): React.JSX.Element {
  const { state, actions } = app
  const messages = state.messages[conversation.id] ?? []
  const scrollRef = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  const [showInfo, setShowInfo] = useState(false)

  const groups = useMemo(() => {
    const out: Array<{ label: string; items: Message[] }> = []
    for (const m of messages) {
      const label = dayLabel(m.createdAt)
      const last = out[out.length - 1]
      if (last && last.label === label) last.items.push(m)
      else out.push({ label, items: [m] })
    }
    return out
  }, [messages])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (nearBottom.current) el.scrollTop = el.scrollHeight
  }, [messages.length, conversation.id])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }

  return (
    <div className="chat-pane">
      <header className="chat-head">
        <div className="chat-head-left">
          <Avatar
            src={conversation.avatarUrl}
            name={conversation.title}
            size={38}
            square={conversation.type === 'group'}
          />
          <div>
            <h2>
              {conversation.title}
              {conversation.type === 'group' ? <em className="conv-tag">群</em> : null}
            </h2>
            <p>
              {conversation.type === 'group'
                ? `${conversation.memberCount ?? 0} 位成员`
                : `最近活跃 ${formatListTime(conversation.lastMessageAt)}`}
              {conversation.muted ? ' · 已静音' : ''}
            </p>
          </div>
        </div>

        <div className="chat-head-actions">
          <button
            className={`icon-btn ${conversation.pinned ? 'on' : ''}`}
            title={conversation.pinned ? '取消置顶' : '置顶会话'}
            onClick={() => void actions.setPinned(conversation.id, !conversation.pinned)}
          >
            <Icon name="pin" size={18} />
          </button>
          <button
            className={`icon-btn ${conversation.muted ? 'on' : ''}`}
            title={conversation.muted ? '开启提醒' : '消息免打扰'}
            onClick={() => void actions.setMuted(conversation.id, !conversation.muted)}
          >
            <Icon name={conversation.muted ? 'bellOff' : 'bell'} size={18} />
          </button>
          <button
            className="icon-btn"
            title="导出聊天记录"
            onClick={() => void window.desktop.app.exportConversation(conversation.id)}
          >
            <Icon name="download" size={18} />
          </button>
          <button
            className={`icon-btn ${showInfo ? 'on' : ''}`}
            title="会话信息"
            onClick={() => setShowInfo((v) => !v)}
          >
            <Icon name="more" size={18} />
          </button>
        </div>
      </header>

      <div className="chat-body">
        <div className="msg-scroll" ref={scrollRef} onScroll={onScroll}>
          <div className="msg-top">
            <button className="link-btn" disabled={state.loadingMore} onClick={() => void actions.loadMore()}>
              {state.loadingMore ? '加载中…' : '加载更早的消息'}
            </button>
          </div>

          {/* 消息不足一屏时把内容压到底部，避免上方大片留白 */}
          <div className="msg-spacer" />

          {messages.length === 0 ? (
            <div className="chat-empty">
              <Icon name="chat" size={26} />
              <p>还没有消息，打个招呼吧</p>
            </div>
          ) : null}

          {groups.map((group) => (
            <div key={group.label}>
              <div className="day-divider">
                <span>{group.label}</span>
              </div>
              {group.items.map((m) => (
                <MessageItem
                  peerTitle={conversation.type === 'private' ? conversation.title : undefined}
                  onOpenShare={(payload) => actions.openPeek(payload)}
                  key={m.clientId || m.id}
                  message={m}
                  onReply={(msg) =>
                    actions.setReply({
                      messageId: msg.id,
                      senderName: msg.isSelf ? '我' : msg.senderName,
                      preview:
                        msg.type === 'text'
                          ? (msg.content.text ?? '').slice(0, 40)
                          : msg.type === 'image'
                            ? '[图片]'
                            : msg.type === 'file'
                              ? `[文件] ${msg.content.name ?? ''}`
                              : '[消息]'
                    })
                  }
                  onRecall={(msg) => void actions.recall(msg.id)}
                  onDelete={(msg) => void window.desktop.messages.deleteLocal(msg.id)}
                  onRetry={(msg) => void actions.retry(msg.clientId)}
                />
              ))}
            </div>
          ))}
          <div className="msg-bottom-space" />
        </div>

        {showInfo ? (
          <aside className="chat-info">
            <Avatar
              src={conversation.avatarUrl}
              name={conversation.title}
              size={64}
              square={conversation.type === 'group'}
            />
            <h3>{conversation.title}</h3>
            <p className="chat-info-sub">{conversation.type === 'group' ? '群聊' : '私信会话'}</p>
            <dl>
              <div>
                <dt>会话 ID</dt>
                <dd>{conversation.id}</dd>
              </div>
              <div>
                <dt>未读</dt>
                <dd>{conversation.unreadCount}</dd>
              </div>
              <div>
                <dt>提醒</dt>
                <dd>{conversation.muted ? '免打扰' : '正常'}</dd>
              </div>
              <div>
                <dt>置顶</dt>
                <dd>{conversation.pinned ? '是' : '否'}</dd>
              </div>
            </dl>
          </aside>
        ) : null}
      </div>

      <Composer
        key={conversation.id}
        draft={conversation.draft}
        replyTo={state.replyTo}
        sendKey={state.settings?.sendKey ?? 'enter'}
        disabled={false}
        onSend={(type, content) => actions.send(type, content, state.replyTo)}
        onDraftChange={(text) => actions.saveDraft(conversation.id, text)}
        onCancelReply={() => actions.setReply(null)}
      />
    </div>
  )
}
