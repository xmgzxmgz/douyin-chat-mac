import React, { useEffect, useRef, useState } from 'react'
import type { MessageContent, MessageType, ReplyRef } from '@shared/types'
import { Icon } from './Icon'

const EMOJIS = ['😀', '😂', '🥰', '😎', '🤔', '😭', '👍', '🙏', '🔥', '🎉', '❤️', '🍜', '☕️', '🌚', '🐶', '✨']
const MAX_LEN = 2000

export function Composer({
  draft,
  replyTo,
  sendKey,
  disabled,
  onSend,
  onDraftChange,
  onCancelReply
}: {
  draft: string
  replyTo: ReplyRef | null
  sendKey: 'enter' | 'cmd+enter'
  disabled: boolean
  onSend: (type: MessageType, content: MessageContent) => Promise<boolean> | boolean
  onDraftChange: (text: string) => void
  onCancelReply: () => void
}): React.JSX.Element {
  const [text, setText] = useState(draft)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const imageRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setText(draft)
  }, [draft])

  useEffect(() => {
    if (replyTo) areaRef.current?.focus()
  }, [replyTo])

  const resize = (): void => {
    const el = areaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(160, el.scrollHeight)}px`
  }

  const submit = async (): Promise<void> => {
    const value = text.trim()
    if (!value || disabled) return
    const ok = await onSend('text', { text: value })
    if (ok === false) return
    setText('')
    onDraftChange('')
    requestAnimationFrame(() => {
      resize()
      areaRef.current?.focus()
    })
  }

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const withMod = e.metaKey || e.ctrlKey
    if (e.key === 'Enter') {
      if (sendKey === 'enter' && !e.shiftKey && !withMod) {
        e.preventDefault()
        submit()
      } else if (sendKey === 'cmd+enter' && withMod) {
        e.preventDefault()
        submit()
      }
    }
    if (e.key === 'Escape' && replyTo) onCancelReply()
  }

  const pickImage = (file: File | undefined): void => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      onSend('image', { url: String(reader.result), name: file.name, size: file.size, mime: file.type })
    }
    reader.readAsDataURL(file)
  }

  return (
    <div className="composer">
      {replyTo ? (
        <div className="reply-banner">
          <Icon name="reply" size={14} />
          <span>回复 {replyTo.senderName}：{replyTo.preview}</span>
          <button className="icon-btn tiny" onClick={onCancelReply}>
            <Icon name="close" size={13} />
          </button>
        </div>
      ) : null}

      <div className="composer-tools">
        <button className="icon-btn" title="表情" onClick={() => setEmojiOpen((v) => !v)}>
          <Icon name="smile" size={19} />
        </button>
        <button className="icon-btn" title="发送图片" onClick={() => imageRef.current?.click()}>
          <Icon name="image" size={19} />
        </button>
        <button className="icon-btn" title="发送文件" onClick={() => fileRef.current?.click()}>
          <Icon name="download" size={19} />
        </button>
        <span className="composer-hint">{sendKey === 'enter' ? 'Enter 发送 · Shift+Enter 换行' : '⌘+Enter 发送'}</span>
      </div>

      {emojiOpen ? (
        <div className="emoji-pop">
          {EMOJIS.map((e) => (
            <button
              key={e}
              onClick={() => {
                setText((v) => (v + e).slice(0, MAX_LEN))
                setEmojiOpen(false)
                requestAnimationFrame(() => areaRef.current?.focus())
              }}
            >
              {e}
            </button>
          ))}
        </div>
      ) : null}

      <textarea
        ref={areaRef}
        className="composer-input"
        value={text}
        disabled={disabled}
        placeholder={disabled ? '选择一个会话开始聊天' : '说点什么…'}
        rows={1}
        maxLength={MAX_LEN}
        onChange={(e) => {
          setText(e.target.value)
          onDraftChange(e.target.value)
          resize()
        }}
        onKeyDown={handleKey}
      />

      <div className="composer-bottom">
        <span className="counter">{text.length > 0 ? `${text.length}/${MAX_LEN}` : ''}</span>
        <button className="btn primary send-btn" disabled={disabled || !text.trim()} onClick={submit}>
          <Icon name="send" size={15} /> 发送
        </button>
      </div>

      <input
        ref={imageRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          pickImage(e.target.files?.[0])
          e.target.value = ''
        }}
      />
      <input
        ref={fileRef}
        type="file"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onSend('file', { name: f.name, size: f.size, mime: f.type, url: `local://${f.name}` })
          e.target.value = ''
        }}
      />
    </div>
  )
}
