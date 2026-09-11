/**
 * OpenRouter 额度适配器
 * GET https://openrouter.ai/api/v1/key
 * → { data: { label, usage, limit, limit_remaining, is_free_tier, rate_limit } }
 */
const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export default {
  id: 'openrouter',
  label: 'OpenRouter',
  kind: 'quota',
  homepage: 'https://openrouter.ai/settings/keys',
  keyNames: ['OPENROUTER_API_KEY'],
  defaultBaseUrl: 'https://openrouter.ai/api/v1',
  balanceUrl: (base) => `${String(base || 'https://openrouter.ai/api/v1').replace(/\/$/, '')}/key`,

  match(endpoint) {
    if (/openrouter\.ai/i.test(endpoint.baseUrl || '')) return true
    return this.keyNames.includes(endpoint.keyEnv)
  },

  /** 付费探测(兜底用)。`openrouter/auto` 是官方的自动路由模型,名字较稳。 */
  probe: {
    path: '/chat/completions',
    body: { model: 'openrouter/auto', max_tokens: 1, messages: [{ role: 'user', content: '.' }] },
    cost: 'token',
    verified: false
  },

  async query({ key, baseUrl, fetchJson }) {
    if (!key) return { ok: false, reason: 'unconfigured' }
    const r = await fetchJson(this.balanceUrl(baseUrl), {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }
    })
    if (!r.ok) return { ok: false, reason: 'http', status: r.status, detail: r.text }

    const d = r.data?.data ?? r.data ?? {}
    const limit = num(d.limit)
    const usage = num(d.usage)
    const remaining = num(d.limit_remaining)

    const details = []
    if (usage !== null) details.push({ label: '已用', value: '$' + usage.toFixed(4) })
    if (limit !== null && limit > 0) details.push({ label: '额度上限', value: '$' + limit.toFixed(2) })
    else details.push({ label: '额度', value: '不限(按账户余额)' })
    if (d.is_free_tier) details.push({ label: '等级', value: 'Free tier' })

    const bars = []
    if (limit !== null && limit > 0 && usage !== null) {
      bars.push({ name: 'Key 限额', used: usage, cap: limit, unit: '$' })
    }

    return {
      ok: true,
      currency: 'USD',
      balance: remaining !== null ? remaining : limit !== null ? Math.max(limit - (usage || 0), 0) : null,
      balanceLabel: '剩余额度',
      details,
      bars
    }
  }
}
