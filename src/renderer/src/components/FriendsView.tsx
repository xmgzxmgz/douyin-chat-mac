import React, { useState } from 'react'
import type { ChatApp } from '../store/useChatApp'
import { Avatar } from './Avatar'
import { Icon } from './Icon'

export function FriendsView({ app }: { app: ChatApp }): React.JSX.Element {
  const { state, actions } = app
  const [keyword, setKeyword] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [remark, setRemark] = useState('')

  const list = state.friends.filter((f) => {
    const k = keyword.trim().toLowerCase()
    if (!k) return true
    return (f.remark ?? f.nickname).toLowerCase().includes(k) || (f.uniqueId ?? '').toLowerCase().includes(k)
  })

  const openChat = (friendId: string): void => {
    const conv = state.conversations.find((c) => c.peerId === friendId)
    if (conv) {
      void actions.openConversation(conv.id)
      actions.selectView('chats')
    } else {
      actions.toast('info', '该好友还没有会话记录')
    }
  }

  return (
    <div className="panel-page">
      <header className="page-head">
        <div>
          <h1>好友</h1>
          <p>{state.friends.length} 位好友 · {state.friends.filter((f) => f.online).length} 人在线</p>
        </div>
        <div className="page-head-actions">
          <div className="inline-search">
            <Icon name="search" size={16} />
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索昵称或抖音号"
              spellCheck={false}
            />
          </div>
          <button
            className="btn ghost"
            onClick={() => {
              const kw = keyword.trim()
              if (!kw) {
                actions.toast('info', '先输入昵称或抖音号，再点击添加')
                return
              }
              void actions.addFriendByKeyword(kw)
            }}
          >
            <Icon name="plus" size={16} /> 添加好友
          </button>
        </div>
      </header>

      <div className="friend-grid">
        {list.map((f) => (
          <div className="friend-card" key={f.id}>
            <Avatar src={f.avatarUrl} name={f.nickname} size={52} online={f.online} />
            <div className="friend-main">
              {editingId === f.id ? (
                <div className="friend-edit">
                  <input
                    autoFocus
                    value={remark}
                    onChange={(e) => setRemark(e.target.value)}
                    placeholder="备注名"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        void actions.setRemark(f.id, remark)
                        setEditingId(null)
                      }
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                  />
                  <button
                    className="icon-btn tiny"
                    onClick={() => {
                      void actions.setRemark(f.id, remark)
                      setEditingId(null)
                    }}
                  >
                    <Icon name="check" size={14} />
                  </button>
                </div>
              ) : (
                <h3>
                  {f.remark ?? f.nickname}
                  {f.blocked ? <em className="tag-danger">已拉黑</em> : null}
                </h3>
              )}
              <p>@{f.uniqueId ?? f.id}</p>
              <span className={f.online ? 'online-text' : 'offline-text'}>{f.online ? '在线' : '离线'}</span>
            </div>
            <div className="friend-actions">
              <button className="btn small" onClick={() => openChat(f.id)}>
                发消息
              </button>
              <button
                className="icon-btn"
                title="备注"
                onClick={() => {
                  setEditingId(f.id)
                  setRemark(f.remark ?? '')
                }}
              >
                <Icon name="reply" size={16} />
              </button>
              <button
                className="icon-btn"
                title={f.blocked ? '解除拉黑' : '拉黑'}
                onClick={() => void actions.setBlocked(f.id, !f.blocked)}
              >
                <Icon name="shield" size={16} />
              </button>
              <button className="icon-btn danger" title="删除好友" onClick={() => void actions.removeFriend(f.id)}>
                <Icon name="trash" size={16} />
              </button>
            </div>
          </div>
        ))}

        {list.length === 0 ? (
          <div className="chat-empty wide">
            <Icon name="users" size={26} />
            <p>没有匹配的好友</p>
          </div>
        ) : null}
      </div>
    </div>
  )
}
