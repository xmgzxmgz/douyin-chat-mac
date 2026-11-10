import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { QrLoginTicket } from '@shared/types'
import type { ChatApp } from '../store/useChatApp'
import { Icon } from './Icon'

type Tab = 'qr' | 'cookie'

export function LoginScreen({ app }: { app: ChatApp }): React.JSX.Element {
  const mode = app.state.settings?.mode ?? 'mock'
  const [tab, setTab] = useState<Tab>('qr')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cookie, setCookie] = useState('')
  const [userAgent, setUserAgent] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [ticket, setTicket] = useState<QrLoginTicket | null>(null)
  const [qrState, setQrState] = useState<'pending' | 'scanned' | 'confirmed' | 'expired' | 'error'>('pending')
  const [appBusy, setAppBusy] = useState(false)
  const pollRef = useRef<number | null>(null)

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const startQr = useCallback(async () => {
    stopPolling()
    setError(null)
    setQrState('pending')
    setTicket(null)
    const res = await window.desktop.auth.createQrLogin()
    if (!res.ok) {
      setQrState('error')
      setError(res.error.message)
      return
    }
    setTicket(res.data)
    pollRef.current = window.setInterval(async () => {
      const poll = await window.desktop.auth.pollQr(res.data.qrId)
      if (!poll.ok) {
        setQrState('error')
        setError(poll.error.message)
        stopPolling()
        return
      }
      if (poll.data.state === 'scanned') setQrState('scanned')
      if (poll.data.state === 'expired') {
        setQrState('expired')
        stopPolling()
      }
      if (poll.data.state === 'confirmed') {
        setQrState('confirmed')
        stopPolling()
        await app.actions.refresh()
      }
    }, 800)
  }, [app.actions, stopPolling])

  useEffect(() => {
    if (mode === 'mock' && tab === 'qr') void startQr()
    return stopPolling
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, mode])

  const submitCookie = async (value: string, ua?: string) => {
    if (!value.trim()) {
      setError('请先粘贴包含 sessionid 的 Cookie')
      return
    }
    setBusy(true)
    setError(null)
    const ok = await app.actions.loginWithCookie(value.trim(), ua?.trim() || undefined)
    setBusy(false)
    if (!ok) setError('登录失败，请检查 Cookie 是否完整、是否已过期')
  }

  const loginInApp = async () => {
    setError(null)
    if (mode !== 'douyin-web') await app.actions.updateSettings({ mode: 'douyin-web' })
    setAppBusy(true)
    const res = await window.desktop.auth.loginInApp()
    setAppBusy(false)
    if (!res.ok) {
      setError(res.error.message)
      return
    }
    await app.actions.refresh()
  }

  const demoLogin = async () => {
    if (mode !== 'mock') {
      await app.actions.updateSettings({ mode: 'mock' })
    }
    await submitCookie('sessionid=mock_demo_session; ttwid=mock_ttwid; odin_tt=demo')
  }

  return (
    <div className="login">
      <div className="login-brand">
        <div className="login-brand-glow" />
        <div className="brand-mark">
          <span className="brand-dot" />
          抖音桌面聊天
        </div>
        <h1>
          在 Mac 上，
          <br />
          把私信聊得顺手一点。
        </h1>
        <p className="login-sub">
          基于 Web 端会话的多闪风格桌面客户端。会话、消息、好友、通知一站收拢，支持多账号与离线缓存。
        </p>
        <ul className="login-points">
          <li>
            <Icon name="chat" size={18} /> 三栏布局 · 未读聚合 · 消息撤回与重发
          </li>
          <li>
            <Icon name="bell" size={18} /> 原生通知 · Dock 角标 · 免打扰时段
          </li>
          <li>
            <Icon name="shield" size={18} /> Cookie 存于系统钥匙串，渲染进程零接触
          </li>
          <li>
            <Icon name="wifi" size={18} /> 轮询增量同步 · 断网自动退避重连
          </li>
        </ul>
        <div className="login-mode">
          <span className="login-mode-label">当前数据源</span>
          <div className="segmented">
            <button
              className={mode === 'mock' ? 'seg active' : 'seg'}
              onClick={() => void app.actions.updateSettings({ mode: 'mock' })}
            >
              演示环境
            </button>
            <button
              className={mode === 'douyin-web' ? 'seg active' : 'seg'}
              onClick={() => void app.actions.updateSettings({ mode: 'douyin-web' })}
            >
              真实抖音
            </button>
          </div>
        </div>
        <p className="login-fineprint">
          演示环境完全离线；真实模式在应用内登录后直连 imapi 的 protobuf 接口，当前为只读同步（发送待验证）。
          属未公开接口，存在账号风险，详见项目 README「合规与风险」。
        </p>
      </div>

      <div className="login-panel">
        <div className="login-card">
          <div className="login-card-head">
            <h2>登录</h2>
            <p>选择一种方式接入你的会话</p>
          </div>

          <div className="tabs">
            <button className={tab === 'qr' ? 'tab active' : 'tab'} onClick={() => setTab('qr')}>
              <Icon name="qr" size={16} /> 扫码登录
            </button>
            <button className={tab === 'cookie' ? 'tab active' : 'tab'} onClick={() => setTab('cookie')}>
              <Icon name="key" size={16} /> Cookie 导入
            </button>
          </div>

          {tab === 'qr' ? (
            <div className="qr-area">
              {mode === 'mock' ? (
                <>
                  <div className={`qr-frame ${qrState === 'expired' ? 'dim' : ''}`}>
                    {ticket ? <img src={ticket.imageDataUrl} alt="登录二维码" /> : <div className="qr-skeleton" />}
                    {qrState === 'scanned' ? <div className="qr-overlay">已扫码，请在手机上确认</div> : null}
                    {qrState === 'expired' ? <div className="qr-overlay">二维码已过期</div> : null}
                  </div>
                  <p className="qr-hint">
                    {qrState === 'pending' && '演示环境：打开后约 3 秒自动完成登录'}
                    {qrState === 'scanned' && '已扫码，等待确认…'}
                    {qrState === 'confirmed' && '登录成功，正在进入…'}
                    {qrState === 'expired' && '有效期 90 秒，请刷新重试'}
                  </p>
                  <button className="btn ghost" onClick={() => void startQr()}>
                    <Icon name="refresh" size={16} /> 刷新二维码
                  </button>
                </>
              ) : (
                <div className="empty-block">
                  <Icon name="alert" size={26} />
                  <p>真实模式未接入扫码登录</p>
                  <span>真实模式请用下方按钮在应用内登录，成功后窗口会自动关闭并接入。</span>
                  <button className="btn primary" onClick={() => void loginInApp()} disabled={appBusy}>
                    {appBusy ? '等待登录完成…' : '在应用内登录抖音'}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="cookie-area">
              <div className="app-login">
                <button className="btn primary block" disabled={appBusy} onClick={() => void loginInApp()}>
                  {appBusy ? '等待登录完成…' : '在应用内登录抖音（自动获取会话）'}
                </button>
                <span>打开抖音网页扫码登录，成功后自动关闭窗口并接入，无需手动复制 Cookie</span>
              </div>
              <div className="divider">
                <span>或手动导入 Cookie</span>
              </div>
              <label className="field">
                <span>登录 Cookie</span>
                <textarea
                  value={cookie}
                  onChange={(e) => setCookie(e.target.value)}
                  placeholder="在浏览器打开 douyin.com 并登录 → 开发者工具 → Network → 任意请求 → 复制 Request Headers 中的 cookie 整行"
                  rows={6}
                  spellCheck={false}
                />
              </label>
              <button className="link-btn" onClick={() => setAdvanced((v) => !v)}>
                {advanced ? '收起高级选项' : '高级选项（自定义 UA）'}
              </button>
              {advanced ? (
                <label className="field">
                  <span>User-Agent（可选，需与获取 Cookie 的浏览器一致）</span>
                  <input value={userAgent} onChange={(e) => setUserAgent(e.target.value)} placeholder="Mozilla/5.0 ..." />
                </label>
              ) : null}
              <button className="btn primary block" disabled={busy} onClick={() => void submitCookie(cookie, userAgent)}>
                {busy ? '正在登录…' : '登录'}
              </button>
              <div className="divider">
                <span>或</span>
              </div>
              <button className="btn ghost block" onClick={() => void demoLogin()}>
                使用演示账号快速体验
              </button>
            </div>
          )}

          {error ? (
            <div className="inline-error">
              <Icon name="alert" size={16} /> {error}
            </div>
          ) : null}

          <p className="login-tip">
            <Icon name="shield" size={14} />
            Cookie 仅保存在本机钥匙串，不上传任何第三方服务器。
          </p>
        </div>
      </div>
    </div>
  )
}
