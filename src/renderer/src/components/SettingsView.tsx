import React, { useCallback, useEffect, useState } from 'react'
import type { Account, AppInfo, AppSettings } from '@shared/types'
import type { ChatApp } from '../store/useChatApp'
import { Avatar } from './Avatar'
import { Icon } from './Icon'

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  return (
    <button className={`switch ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)} aria-pressed={checked}>
      <i />
    </button>
  )
}

export function SettingsView({ app }: { app: ChatApp }): React.JSX.Element {
  const { state, actions } = app
  const settings = state.settings
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])

  const loadAccounts = useCallback(async () => {
    const res = await window.desktop.auth.accounts()
    if (res.ok) setAccounts(res.data)
  }, [])

  useEffect(() => {
    void window.desktop.app.info().then((r) => r.ok && setInfo(r.data))
  }, [])

  useEffect(() => {
    void loadAccounts()
  }, [loadAccounts, state.session?.account?.accountId])

  if (!settings) return <div className="panel-page" />

  const patch = (p: Partial<AppSettings>): void => {
    void actions.updateSettings(p)
  }
  const patchNotify = (p: Partial<AppSettings['notifications']>): void => {
    void actions.updateSettings({ notifications: { ...settings.notifications, ...p } })
  }

  return (
    <div className="panel-page settings-page">
      <header className="page-head">
        <div>
          <h1>设置</h1>
          <p>账号、同步、通知与本地数据</p>
        </div>
      </header>

      <div className="settings-grid">
        <section className="card">
          <div className="card-head">
            <h2>账号</h2>
            <span className={`mode-badge ${settings.mode}`}>{settings.mode === 'mock' ? '演示环境' : '真实抖音'}</span>
          </div>
          {state.session?.account ? (
            <div className="account-row">
              <Avatar src={state.session.account.avatarUrl} name={state.session.account.nickname} size={48} />
              <div>
                <h3>{state.session.account.nickname}</h3>
                <p>@{state.session.account.uniqueId ?? state.session.account.id}</p>
              </div>
              <span className={`status-pill ${state.session.status}`}>
                {state.session.status === 'active' ? '已登录' : state.session.status === 'expired' ? '已失效' : '未登录'}
              </span>
            </div>
          ) : (
            <p className="muted">未登录</p>
          )}
          {accounts.filter((a) => a.accountId !== state.session?.account?.accountId).length > 0 ? (
            <div className="account-list">
              <span className="account-list-label">其他已保存账号</span>
              {accounts
                .filter((a) => a.accountId !== state.session?.account?.accountId)
                .map((a) => (
                  <div className="account-item" key={a.accountId}>
                    <Avatar src={a.avatarUrl} name={a.nickname} size={30} />
                    <div>
                      <strong>{a.nickname}</strong>
                      <em>{a.mode === 'mock' ? '演示环境' : '真实抖音'}</em>
                    </div>
                    <button className="btn small" onClick={() => void actions.switchAccount(a.accountId)}>
                      切换
                    </button>
                  </div>
                ))}
            </div>
          ) : null}
          <div className="card-actions">
            <button className="btn ghost" onClick={() => void actions.logout()}>
              退出登录
            </button>
            <button className="btn ghost" onClick={() => void loadAccounts()}>
              刷新账号
            </button>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>数据源与同步</h2>
          </div>
          <div className="row">
            <div>
              <strong>数据源</strong>
              <p>演示离线运行；真实模式应用内登录，当前为只读同步</p>
            </div>
            <div className="segmented">
              <button className={settings.mode === 'mock' ? 'seg active' : 'seg'} onClick={() => patch({ mode: 'mock' })}>
                演示
              </button>
              <button
                className={settings.mode === 'douyin-web' ? 'seg active' : 'seg'}
                onClick={() => patch({ mode: 'douyin-web' })}
              >
                真实
              </button>
            </div>
          </div>
          <div className="row">
            <div>
              <strong>同步间隔</strong>
              <p>轮询增量拉取新消息</p>
            </div>
            <select
              className="select"
              value={settings.pollIntervalMs}
              onChange={(e) => patch({ pollIntervalMs: Number(e.target.value) })}
            >
              <option value={2000}>2 秒</option>
              <option value={4000}>4 秒</option>
              <option value={8000}>8 秒</option>
              <option value={15000}>15 秒</option>
            </select>
          </div>
          <div className="row">
            <div>
              <strong>历史消息分页</strong>
              <p>每次加载的消息条数</p>
            </div>
            <select
              className="select"
              value={settings.historyPageSize}
              onChange={(e) => patch({ historyPageSize: Number(e.target.value) })}
            >
              <option value={20}>20 条</option>
              <option value={30}>30 条</option>
              <option value={50}>50 条</option>
            </select>
          </div>
          <div className="card-actions">
            <button className="btn ghost" onClick={() => void window.desktop.app.syncNow()}>
              <Icon name="refresh" size={15} /> 立即同步
            </button>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>通知</h2>
          </div>
          <div className="row">
            <div>
              <strong>桌面通知</strong>
              <p>新消息到达时弹出系统通知</p>
            </div>
            <Toggle checked={settings.notifications.enabled} onChange={(v) => patchNotify({ enabled: v })} />
          </div>
          <div className="row">
            <div>
              <strong>提示音</strong>
              <p>通知附带系统提示音</p>
            </div>
            <Toggle checked={settings.notifications.sound} onChange={(v) => patchNotify({ sound: v })} />
          </div>
          <div className="row">
            <div>
              <strong>显示消息内容</strong>
              <p>关闭后仅提示「收到一条新消息」</p>
            </div>
            <Toggle checked={settings.notifications.showPreview} onChange={(v) => patchNotify({ showPreview: v })} />
          </div>
          <div className="row">
            <div>
              <strong>Dock 角标</strong>
              <p>显示未读总数</p>
            </div>
            <Toggle checked={settings.notifications.badge} onChange={(v) => patchNotify({ badge: v })} />
          </div>
          <div className="row">
            <div>
              <strong>免打扰时段</strong>
              <p>该时段内不弹通知，仍累计未读</p>
            </div>
            <Toggle checked={settings.notifications.dndEnabled} onChange={(v) => patchNotify({ dndEnabled: v })} />
          </div>
          {settings.notifications.dndEnabled ? (
            <div className="row dnd-row">
              <input
                className="time-input"
                type="time"
                value={settings.notifications.dndStart}
                onChange={(e) => patchNotify({ dndStart: e.target.value })}
              />
              <span className="muted">至</span>
              <input
                className="time-input"
                type="time"
                value={settings.notifications.dndEnd}
                onChange={(e) => patchNotify({ dndEnd: e.target.value })}
              />
            </div>
          ) : null}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>通用</h2>
          </div>
          <div className="row">
            <div>
              <strong>发送快捷键</strong>
              <p>Enter 直接发送，或 ⌘+Enter 发送</p>
            </div>
            <select
              className="select"
              value={settings.sendKey}
              onChange={(e) => patch({ sendKey: e.target.value as AppSettings['sendKey'] })}
            >
              <option value="enter">Enter 发送</option>
              <option value="cmd+enter">⌘+Enter 发送</option>
            </select>
          </div>
          <div className="row">
            <div>
              <strong>关闭窗口时留在菜单栏</strong>
              <p>保持后台同步与通知</p>
            </div>
            <Toggle checked={settings.closeToTray} onChange={(v) => patch({ closeToTray: v })} />
          </div>
          <div className="row">
            <div>
              <strong>开机自启动</strong>
              <p>登录 macOS 后自动运行</p>
            </div>
            <Toggle checked={settings.autoLaunch} onChange={(v) => patch({ autoLaunch: v })} />
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>关于</h2>
          </div>
          <dl className="kv">
            <div>
              <dt>版本</dt>
              <dd>{info?.version ?? '—'}</dd>
            </div>
            <div>
              <dt>Electron</dt>
              <dd>{info?.electron ?? '—'}</dd>
            </div>
            <div>
              <dt>Chromium</dt>
              <dd>{info?.chrome ?? '—'}</dd>
            </div>
            <div>
              <dt>Node</dt>
              <dd>{info?.node ?? '—'}</dd>
            </div>
            <div>
              <dt>系统</dt>
              <dd>
                {info ? `${info.platform} / ${info.arch}` : '—'}
              </dd>
            </div>
            <div>
              <dt>数据目录</dt>
              <dd className="mono">{info?.dataDir ?? '—'}</dd>
            </div>
          </dl>
          <div className="card-actions">
            <button className="btn ghost" onClick={() => void window.desktop.app.clearCache()}>
              清理缓存
            </button>
            <button className="btn ghost danger" onClick={() => void window.desktop.app.quit()}>
              退出应用
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}
