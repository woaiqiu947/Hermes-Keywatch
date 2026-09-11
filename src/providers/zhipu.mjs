/**
 * 智谱 GLM 适配器(双端点)
 *
 * 智谱有两套账户体系,接口不同,这里都试:
 *   A) 订阅制(GLM Coding Plan)— GET https://bigmodel.cn/api/monitor/usage/quota/limit
 *      → { success, data: { limits: [{ remaining, usage, currentValue, nextResetTime, ... }] } }
 *      limits[0] = 5 小时额度, limits[1] = 7 天额度
 *   B) 按量付费余额 — GET https://open.bigmodel.cn/api/paas/v4/users/me/balance
 *      (字段以官方为准,这里做宽松解析)
 *
 * 认证头:官方文档写 Bearer,但社区实现里也见裸 key,故两种都试。
 */
const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function authHeaders(key) {
  return { Authorization: `Bearer ${key}`, Accept: 'application/json' }
}

export default {
  id: 'zhipu',
  label: '智谱 GLM',
  kind: 'quota',
  homepage: 'https://bigmodel.cn',
  keyNames: ['ZAI_API_KEY', 'ZHIPU_API_KEY', 'GLM_API_KEY', 'ZHIPUAI_API_KEY'],
  defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',

  match(endpoint) {
    if (/bigmodel\.cn|zhipu/i.test(endpoint.baseUrl || '')) return true
    return this.keyNames.includes(endpoint.keyEnv)
  },

  async query({ key, fetchJson }) {
    if (!key) return { ok: false, reason: 'unconfigured' }

    // ── A) 订阅额度(滚动窗口) ─────────────────────────────
    // 注意:该端点对无效/缺失 key 也返回 HTTP 200,必须看 success 字段。
    const q = await fetchJson('https://bigmodel.cn/api/monitor/usage/quota/limit', { headers: authHeaders(key) })
    if (q.ok && q.data?.success !== false) {
      const limits = q.data?.data?.limits
      if (Array.isArray(limits) && limits.length) {
        const bars = limits.map((l, i) => ({
          name: l.planName || (i === 0 ? '5 小时额度' : i === 1 ? '7 天额度' : `额度 ${i + 1}`),
          used: num(l.currentValue) ?? 0,
          cap: num(l.usage),
          remaining: num(l.remaining),
          resetAt: num(l.nextResetTime),
          unit: ''
        })).filter((b) => b.cap > 0)
        const first = limits[0]
        return {
          ok: true,
          kind: 'quota',
          balance: num(first?.remaining),
          balanceLabel: '剩余额度',
          details: [{ label: '套餐', value: 'GLM Coding Plan' }],
          bars
        }
      }
    }

    // ── B) 按量付费余额 ───────────────────────────────────
    const bal = await fetchJson('https://open.bigmodel.cn/api/paas/v4/users/me/balance', { headers: authHeaders(key) })
    if (bal.ok) {
      const d = bal.data?.data ?? bal.data ?? {}
      const remaining =
        num(d.balance) ?? num(d.available_balance) ?? num(d.total_balance) ?? num(d.remaining) ?? null
      if (remaining !== null) {
        const details = []
        const used = num(d.used) ?? num(d.used_amount) ?? num(d.total_used)
        if (used !== null) details.push({ label: '已用', value: '¥' + used.toFixed(2) })
        const granted = num(d.granted_balance) ?? num(d.free_balance)
        if (granted !== null) details.push({ label: '赠送', value: '¥' + granted.toFixed(2) })
        return { ok: true, currency: 'CNY', balance: remaining, balanceLabel: '账户余额', details }
      }
      return { ok: false, reason: 'shape', detail: '余额字段未识别: ' + JSON.stringify(bal.data).slice(0, 200) }
    }

    return { ok: false, reason: 'http', status: bal.status, detail: bal.text }
  }
}
