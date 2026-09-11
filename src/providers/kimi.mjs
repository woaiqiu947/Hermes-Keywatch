/**
 * Kimi / Moonshot 适配器
 *
 * 国内站:GET https://api.moonshot.cn/v1/users/me/balance
 * 国际站:GET https://api.moonshot.ai/v1/users/me/balance
 * → { code, status, data: { available_balance, voucher_balance, cash_balance } }
 *   (部分响应把 data 再包一层,故做宽松解析)
 *
 * 注意:中国站与国际站的账户/Key 完全独立,端点必须与 Key 归属匹配。
 */
const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export default {
  id: 'kimi',
  label: 'Kimi / Moonshot',
  kind: 'balance',
  homepage: 'https://platform.moonshot.cn',
  keyNames: ['KIMI_API_KEY', 'KIMI_CN_API_KEY', 'MOONSHOT_API_KEY'],
  defaultBaseUrl: 'https://api.moonshot.cn/v1',

  match(endpoint) {
    if (/moonshot\.(cn|ai)|kimi\.com/i.test(endpoint.baseUrl || '')) return true
    return this.keyNames.includes(endpoint.keyEnv)
  },

  async query({ key, baseUrl, endpoint, fetchJson }) {
    if (!key) return { ok: false, reason: 'unconfigured' }

    // 端点推导:显式 base_url 优先,其次按 key 变量名猜站点,最后国内站
    const keyEnvName = endpoint?.keyEnv || ''
    const guessIntl = /KIMI_API_KEY$/.test(keyEnvName) && !/^KIMI_CN_/.test(keyEnvName)
    let origin = 'https://api.moonshot.cn'
    if (baseUrl && /moonshot\.ai/i.test(baseUrl)) origin = 'https://api.moonshot.ai'
    else if (baseUrl && /moonshot\.cn/i.test(baseUrl)) origin = 'https://api.moonshot.cn'
    else if (baseUrl && /kimi\.(com|ai)/i.test(baseUrl)) origin = baseUrl.includes('.ai') ? 'https://api.moonshot.ai' : 'https://api.moonshot.cn'
    else if (guessIntl) origin = 'https://api.moonshot.ai'

    const r = await fetchJson(`${origin}/v1/users/me/balance`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }
    })
    if (!r.ok) return { ok: false, reason: 'http', status: r.status, detail: r.text }

    // 宽松取数:data / data.data / 顶层都试一遍
    const d = r.data?.data?.data ?? r.data?.data ?? r.data ?? {}
    const available = num(d.available_balance) ?? num(d.availableBalance)
    const voucher = num(d.voucher_balance) ?? num(d.voucherBalance)
    const cash = num(d.cash_balance) ?? num(d.cashBalance)

    if (available === null && voucher === null && cash === null) {
      return { ok: false, reason: 'shape', detail: '字段未识别: ' + JSON.stringify(r.data).slice(0, 200) }
    }

    const details = []
    if (voucher !== null) details.push({ label: '代金券', value: '¥' + voucher.toFixed(2) })
    if (cash !== null) details.push({ label: '现金', value: '¥' + cash.toFixed(2) })

    return {
      ok: true,
      currency: 'CNY',
      balance: available !== null ? available : (voucher ?? 0) + (cash ?? 0),
      balanceLabel: '可用余额',
      details,
      note: origin.includes('.ai') ? '国际站' : '国内站'
    }
  }
}
