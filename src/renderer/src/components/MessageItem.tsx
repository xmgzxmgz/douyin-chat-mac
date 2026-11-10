import React, { useEffect, useRef, useState } from 'react'
import type { Message } from '@shared/types'
import { formatMessageTime, formatFileSize } from '../lib/format'
import { Avatar } from './Avatar'
import { Icon } from './Icon'

export function MessageItem({
  message,
  peerTitle,
  onOpenShare,
  onReply,
  onRecall,
  onDelete,
  onRetry
}: {
  message: Message
  /** 私聊里对方就是唯一的发送者，直接用它替代可能过期的 senderName */
  peerTitle?: string
  /** 打开右侧手机框预览；不传则退化为用浏览器打开 */
  onOpenShare?: (payload: { url: string; title: string; kind?: string }) => void
  onReply: (m: Message) => void
  onRecall: (m: Message) => void
  onDelete: (m: Message) => void
  onRetry: (m: Message) => void
}): React.JSX.Element {
  if (message.type === 'system') {
    return <div className="msg-system">{message.content.text}</div>
  }

  const self = message.isSelf
  const senderLabel = !self && peerTitle ? peerTitle : message.senderName

  if (message.status === 'recalled') {
    return <div className="msg-system">{self ? '你' : senderLabel} 撤回了一条消息</div>
  }

  return (
    <div className={`msg ${self ? 'self' : 'other'}`}>
      {!self ? <Avatar src={message.senderAvatar} name={senderLabel} size={34} /> : null}

      <div className="msg-main">
        {!self ? <div className="msg-sender">{senderLabel}</div> : null}

        {message.replyTo ? (
          <div className="msg-quote">
            <span>{message.replyTo.senderName}</span>
            <p>{message.replyTo.preview}</p>
          </div>
        ) : null}

        <div className={`bubble bubble-${message.type}`}>
          <Content message={message} onOpenShare={onOpenShare} />
        </div>

        <div className="msg-meta">
          <span>{formatMessageTime(message.createdAt)}</span>
          {self && message.status === 'sending' ? <span className="msg-state">发送中…</span> : null}
          {self && message.status === 'failed' ? (
            <button className="msg-failed" onClick={() => onRetry(message)}>
              <Icon name="alert" size={12} /> 发送失败，重试
            </button>
          ) : null}
        </div>
      </div>

      <div className="msg-tools">
        <button onClick={() => onReply(message)} title="回复">
          <Icon name="reply" size={14} />
        </button>
        {message.type === 'text' ? (
          <button
            onClick={() => void navigator.clipboard.writeText(message.content.text ?? '')}
            title="复制"
          >
            <Icon name="check" size={14} />
          </button>
        ) : null}
        {self ? (
          <button onClick={() => onRecall(message)} title="撤回">
            <Icon name="refresh" size={14} />
          </button>
        ) : null}
        <button onClick={() => onDelete(message)} title="删除本地记录">
          <Icon name="trash" size={14} />
        </button>
      </div>
    </div>
  )
}

/**
 * 抖音的表情在消息里是 [捂脸] 这样的文本标记。
 * 拿不到官方表情图的情况下，把它渲染成小标签，至少不会像一串方括号乱码。
 */
function renderTextWithEmoji(text: string): React.ReactNode {
  if (!text.includes('[')) return text
  return text.split(/(\[[^\]]{1,8}\])/g).map((part, i) =>
    /^\[[^\]]{1,8}\]$/.test(part) ? (
      <span className="emoji-token" key={i}>
        {part.slice(1, -1)}
      </span>
    ) : (
      <React.Fragment key={i}>{part}</React.Fragment>
    )
  )
}

const openExternal = (url?: string): void => {
  if (!url || !/^(https?:\/\/|data:)/.test(url)) return
  if (/^data:/.test(url)) return
  void window.desktop.app.openExternal(url)
}

function Content({
  message,
  onOpenShare
}: {
  message: Message
  onOpenShare?: (payload: { url: string; title: string; kind?: string }) => void
}): React.JSX.Element {
  const c = message.content
  // 语音：用原生 Audio 播放 CDN 上的 mpeg/m4a；转写文本来自消息体的 ai_audio_text
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  useEffect(() => {
    const audio = audioRef.current
    return () => {
      audio?.pause()
    }
  }, [])

  const toggleVoice = (url: string): void => {
    if (!url) return
    if (!audioRef.current) {
      const audio = new Audio(url)
      audio.onended = () => setPlaying(false)
      audio.onerror = () => setPlaying(false)
      audioRef.current = audio
    }
    const audio = audioRef.current
    if (playing) {
      audio.pause()
      setPlaying(false)
      return
    }
    void audio
      .play()
      .then(() => setPlaying(true))
      .catch(() => setPlaying(false))
  }

  switch (message.type) {
    case 'image': {
      // 原图是 ImageX 加密流，渲染不了；优先用消息自带的内联预览图（未加密的 WebP）
      const preview = c.thumbUrl || (/^https?:|^data:/.test(c.url ?? '') ? c.url : '')
      return preview ? (
        <img
          className="bubble-image"
          src={preview}
          alt={c.name ?? '图片'}
          draggable={false}
          title={c.thumbUrl ? '这是消息自带的预览图' : '点击在浏览器中查看大图'}
          onClick={() => {
            // 只有非内联预览（真实 http 地址）才值得外部打开
            if (!c.thumbUrl && c.url) openExternal(c.url)
          }}
        />
      ) : (
        <div className="bubble-file">
          <span className="file-ico">
            <Icon name="image" size={18} />
          </span>
          <div>
            <strong>图片</strong>
            <em>{c.width && c.height ? `${c.width} × ${c.height}` : '已收到图片'}</em>
          </div>
        </div>
      )
    }

    case 'emoji':
      // 抖音表情是图片消息，自带 CDN 地址；拿不到地址时退化成文本标记
      return c.url ? (
        <img
          className="bubble-emoji-img"
          src={c.url}
          alt={c.emojiName ?? '表情'}
          draggable={false}
          style={
            c.width && c.height
              ? { maxWidth: Math.min(140, c.width), maxHeight: Math.min(140, c.height) }
              : undefined
          }
        />
      ) : (
        <span className="bubble-emoji">{c.emojiName ?? '表情'}</span>
      )

    case 'voice':
      return (
        <div className={`bubble-voice${c.text ? ' has-text' : ''}`}>
          <button
            type="button"
            className={`voice-play${playing ? ' playing' : ''}`}
            onClick={() => toggleVoice(c.url ?? '')}
            disabled={!c.url}
            title={c.url ? '播放语音' : '缺少音频地址'}
          >
            <Icon name={playing ? 'pause' : 'play'} size={14} />
          </button>
          <span className="wave">
            {(c.wave?.length ? c.wave : [0.4, 0.7, 1, 0.6, 0.9, 0.5]).map((v, i) => (
              <i key={i} style={{ height: 6 + Math.round(Math.min(1, Math.abs(v)) * 16) }} />
            ))}
          </span>
          <span>{c.duration ?? 0}&quot;</span>
          {c.text ? <p className="voice-text">{c.text}</p> : null}
        </div>
      )

    case 'file':
      return (
        <div className="bubble-file">
          <span className="file-ico">
            <Icon name="download" size={18} />
          </span>
          <div>
            <strong>{c.name ?? '文件'}</strong>
            <em>{formatFileSize(c.size)}</em>
          </div>
        </div>
      )

    case 'share':
      // 视频 / 图文 / 评论 / 直播卡片：封面 + 标题 + 来源，点击打开原始链接
      return (
        <div
          className={`bubble-card ${c.url ? 'clickable' : ''}`}
          onClick={() => {
            if (!c.url) return
            if (onOpenShare) onOpenShare({ url: c.url, title: c.title ?? '分享内容', kind: c.kind })
            else openExternal(c.url)
          }}
          title={c.url ? '点击在右侧预览' : undefined}
        >
          {c.coverUrl ? (
            <img className="card-cover" src={c.coverUrl} alt="" loading="lazy" draggable={false} />
          ) : (
            <span className="card-cover placeholder">
              <Icon name="image" size={20} />
            </span>
          )}
          <div className="card-body">
            <strong className="card-title">{c.title ?? '分享内容'}</strong>
            {c.desc ? <p className="card-desc">{c.desc}</p> : null}
            <em className="card-meta">
              {c.kind ?? '分享'}
              {c.author ? ` · ${c.author}` : ''}
            </em>
          </div>
        </div>
      )

    default:
      return <span className="bubble-text">{renderTextWithEmoji(c.text ?? '')}</span>
  }
}
