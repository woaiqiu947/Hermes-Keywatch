/**
 * DeepSeek 官方余额适配器
 * GET https://api.deepseek.com/user/balance
 * → { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
 */

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const SYMBOL = { CNY: '¥', USD: '$' }

export default {
  id: 'deepseek',
  label: 'DeepSeek',
  kind: 'balance',
  homepage: 'https://platform.deepseek.com',
  keyNames: ['DEEPSEEK_API_KEY'],
  defaultBaseUrl: 'https://api.deepseek.com',
  /** 余额接口不在 /v1 下，所以 baseUrl 要剥离尾部 /v1 */
  balanceUrl: (base) => `${String(base || 'https://api.deepseek.com').replace(/\/v1\/?$/, '')}/user/balance`,

  match(endpoint) {
    if (/api\.deepseek\.com/i.test(endpoint.baseUrl || '')) return true
    return this.keyNames.includes(endpoint.keyEnv)
  },

  /** 无余额接口时才会用到的付费探测(本厂商通常用不上:余额调用已顺带证明 key 有效) */
  probe: {
    path: '/chat/completions',
    body: { model: 'deepseek-chat', max_tokens: 1, messages: [{ role: 'user', content: '.' }] },
    cost: 'token',
    verified: true // 实测:HTTP 200
  },

  async query({ key, baseUrl, fetchJson }) {
    if (!key) return { ok: false, reason: 'unconfigured' }
    const r = await fetchJson(this.balanceUrl(baseUrl), {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }
    })
    if (!r.ok) return { ok: false, reason: 'http', status: r.status, detail: r.text }

    const infos = Array.isArray(r.data?.balance_infos) ? r.data.balance_infos : []
    if (!infos.length) return { ok: false, reason: 'shape', detail: 'balance_infos 缺失' }

    // 双币种账户:优先展示 CNY(非零),否则第一条
    const info = infos.find((i) => i.currency === 'CNY' && num(i.total_balance) > 0) || infos[0]
    const total = num(info.total_balance)
    const sym = SYMBOL[info.currency] || ''

    const details = [
      { label: '充值余额', value: sym + (num(info.topped_up_balance) ?? 0).toFixed(2) },
      { label: '赠送余额', value: sym + (num(info.granted_balance) ?? 0).toFixed(2) }
    ]
    // 另一种币种如果非零,一并列出
    for (const other of infos) {
      if (other === info) continue
      const v = num(other.total_balance)
      if (v && v > 0) details.push({ label: `${other.currency} 余额`, value: (SYMBOL[other.currency] || '') + v.toFixed(2) })
    }

    return {
      ok: true,
      currency: info.currency,
      balance: total,
      balanceLabel: '账户余额',
      // DeepSeek 自己会告诉你账户是否可用 —— 直接映射到"余额耗尽"
      accountUnavailable: r.data?.is_available === false,
      details
    }
  }
}
