import { writeFileSync } from 'node:fs'
import type { Logger } from './core/notifier'
import { ImWebBridge } from './adapters/douyin/web-bridge'

/**
 * 诊断模式（CHAT_SNIFF_IM=1）：
 * 启动桥接器、等待页面自己发出 IM 请求，然后只输出**数量与结构**——
 * 不输出会话标题、头像和消息正文，便于排查而不泄露隐私。
 * 若设置 CHAT_BRIDGE_REPORT，会把同样的摘要写入该文件。
 */
export async function sniffImRequests(logger: Logger, waitMs = 15000): Promise<void> {
  const bridge = new ImWebBridge({ logger })
  const report: Record<string, unknown> = { at: new Date().toISOString() }
  try {
    await bridge.start()
    await new Promise((r) => setTimeout(r, waitMs))
    const s = bridge.stats()
    const snap = bridge.snapshot()
    logger.info(
      `BRIDGE 诊断：route=${s.route || '(手动)'} payloads=${s.payloads} bytes=${s.bytes} 会话=${s.conversations} 消息=${s.messages} 昵称=${s.names}`
    )
    const byConv = new Map<string, number>()
    for (const m of snap.messages) byConv.set(m.conversationId, (byConv.get(m.conversationId) ?? 0) + 1)
    for (const c of snap.conversations.slice(0, 6)) {
      logger.info(
        `  会话 类型=${c.type} 参与者=${c.memberCount} 消息=${byConv.get(c.id) ?? 0} 标题=${c.title ? '有' : '空'}`
      )
    }
    logger.info('BRIDGE 诊断：以上仅含数量与结构，不含标题、头像与正文')

    if (process.env.CHAT_PROBE_SEND === '1') {
      const probe = await bridge.probeSendEndpoint()
      logger.info(`BRIDGE 发送接口探测：url=${probe.url} 扫描 ${probe.total} 个 JS，命中 ${probe.hits.length}，可编辑框=${JSON.stringify(probe.editables)}`)
      for (const h of probe.hits) logger.info(`BRIDGE 命中 ${h.url}：${h.snip.replace(/\s+/g, ' ').slice(0, 300)}`)
    }

    // 探测昵称来源：把页面刚发过的「用户资料」请求原样重放一次
    if (process.env.CHAT_PROBE_USERINFO === '1') {
      const probe = await bridge.replayUserInfo()
      logger.info(
        `BRIDGE 用户资料重放：ok=${probe.ok} status=${probe.status ?? '-'} keys=${(probe.keys ?? []).join(',') || '-'} named=${probe.named ?? 0} body=${(probe.bodyKeys ?? []).join('|') || '-'}${probe.error ? ` error=${probe.error}` : ''}`
      )
      Object.assign(report, { userInfoProbe: probe })
    }

    // 结构一致性分析：只统计 id 形状与匹配率，不输出任何内容
    const convIds = new Set(snap.conversations.map((c) => c.id))
    const matched = snap.messages.filter((m) => convIds.has(m.conversationId)).length
    const shape = (ids: string[]): Record<string, number> => {
      const out: Record<string, number> = {}
      for (const id of ids) {
        const key = `len${id.length}/seg${id.split(':').length}`
        out[key] = (out[key] ?? 0) + 1
      }
      return out
    }
    const analysis = {
      conversations: snap.conversations.length,
      titled: snap.conversations.filter((c) => c.title).length,
      private: snap.conversations.filter((c) => c.type === 'private').length,
      duplicateIds: snap.conversations.length - convIds.size,
      messages: snap.messages.length,
      messagesMatched: matched,
      messagesUnmatched: snap.messages.length - matched,
      convIdShapes: shape([...convIds]),
      msgConvIdShapes: shape(snap.messages.map((m) => m.conversationId)),
      senderResolved: snap.messages.filter((m) => m.senderName && !/^\d+$/.test(m.senderName)).length
    }
    logger.info(
      `BRIDGE 结构：会话 ${analysis.conversations}（有标题 ${analysis.titled} / 私信 ${analysis.private} / 重复 ${analysis.duplicateIds}）· ` +
        `消息 ${analysis.messages}（匹配会话 ${analysis.messagesMatched} / 发送者已解析 ${analysis.senderResolved}）`
    )
    Object.assign(report, {
      ok: true,
      stats: s,
      analysis,
      requestSample: bridge.imRequestSample(),
      requestHeaderNames: Object.keys(bridge.imRequestHeaders() ?? {}).sort()
    })
  } catch (err) {
    report.error = (err as Error).message
    logger.error(`BRIDGE 诊断失败：${(err as Error).message}`)
  } finally {
    await bridge.stop()
    const target = process.env.CHAT_BRIDGE_REPORT
    if (target) {
      try {
        writeFileSync(target, JSON.stringify(report, null, 2))
      } catch {
        /* 报告写入失败不影响主流程 */
      }
    }
  }
}
