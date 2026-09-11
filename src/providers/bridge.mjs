/**
 * CommandCode bridge 适配器(bridge 已在 admin 端点聚合成完整 billing)
 * GET http://127.0.0.1:9992/admin/commandcode/credentials
 *
 * 这个端点是 bridge 自己暴露的,不需要 API key(仅本机可访问)。
 * 结构见 commandcode-hermes-bridge 项目。
 */
const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export default {
  id: 'commandcode',
  label: 'CommandCode',
  kind: 'quota',
  homepage: 'https://commandcode.ai',
  keyNames: [],
  /** bridge 的 admin 端点只对本机开放,不需要凭据 */
  needsKey: false,
  /** bridge 的默认 admin 地址;端口可从 /v1 的 base_url 推 */
  adminUrl: (baseUrl) => {
    try {
      const u = new URL(baseUrl || 'http://127.0.0.1:9992/v1')
      return `${u.protocol}//${u.host}/admin/commandcode/credentials`
    } catch {
      return 'http://127.0.0.1:9992/admin/commandcode/credentials'
    }
  },

  match(endpoint) {
    // bridge 的显著特征:/v1 挂在 9992,且 provider 名/地址里带 commandcode
    if (/commandcode/i.test(endpoint.name || '')) return true
    if (/127\.0\.0\.1:9992|localhost:9992/.test(endpoint.baseUrl || '')) return true
    return false
  },

  async query({ baseUrl, fetchJson }) {
    const r = await fetchJson(this.adminUrl(baseUrl), { headers: { Accept: 'application/json' } })
    if (!r.ok) return { ok: false, reason: 'http', status: r.status, detail: r.text }

    const creds = r.data?.credentials || []
    const c = creds[0]
    if (!c) return { ok: false, reason: 'shape', detail: 'credentials 为空' }
    const b = c.billing || {}
    const m = b.metrics || {}
    const wl = b.windowLimits || {}
    const fh = wl.fiveHour || {}
    const wk = wl.weekly || {}

    const details = [
      { label: '套餐', value: String(b.planId || 'unknown') },
      { label: '本期已花', value: '$' + (num(b.totalCost) ?? 0).toFixed(2) },
      { label: '请求次数', value: String(b.totalCount ?? '—') }
    ]
    if (num(m.daysRemaining) !== null) details.push({ label: '剩余天数', value: num(m.daysRemaining).toFixed(1) })
    if (b.currentPeriodEnd) details.push({ label: '到期', value: String(b.currentPeriodEnd).slice(0, 10) })
    if (num(m.requiredDailyBurn) !== null) details.push({ label: '日均上限', value: '$' + num(m.requiredDailyBurn).toFixed(2) })

    const bars = []
    if (num(fh.cap) > 0) {
      bars.push({ name: '5 小时窗口', used: num(fh.used) ?? 0, cap: num(fh.cap), resetAt: num(fh.resetAt), exceeded: !!fh.exceeded, unit: '$' })
    }
    if (num(wk.cap) > 0) {
      bars.push({ name: '7 天窗口', used: num(wk.used) ?? 0, cap: num(wk.cap), resetAt: num(wk.resetAt), exceeded: !!wk.exceeded, unit: '$' })
    }

    return {
      ok: true,
      currency: 'USD',
      balance: num(m.currentBalance),
      balanceLabel: '当前余额',
      details,
      bars,
      note: b.fetchedAtIso ? '上游数据 ' + String(b.fetchedAtIso).slice(11, 16) + 'Z' : ''
    }
  }
}
