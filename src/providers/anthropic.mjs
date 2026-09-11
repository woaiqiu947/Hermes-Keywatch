/**
 * Anthropic 适配器 —— **纯探测型**(没有公开的余额接口)
 *
 * 这是 B 层降级链最典型的服务商:普通 API Key 查不到余额
 * (组织用量/成本 API 需要 Admin Key,且面向用量而非余额)。
 *
 * 所以本卡片只回答一个问题:**这个 key 现在还能不能调通?**
 * 用最小 1-token 请求拿状态码判定,绝不编造一个"余额数字"。
 */
export default {
  id: 'anthropic',
  label: 'Anthropic',
  kind: 'probe-only',
  homepage: 'https://console.anthropic.com/settings/billing',
  keyNames: ['ANTHROPIC_API_KEY'],
  defaultBaseUrl: 'https://api.anthropic.com',
  /**
   * query() 只是回一句说明,并不真的查余额 —— 所以它的 ok:true **不能**当作
   * "key 有效"的证据(那只是我们自己的桩函数返回了 true)。可用度一律交给探测。
   */
  balanceProvesKey: false,

  match(endpoint) {
    if (/anthropic\.com/i.test(endpoint.baseUrl || '')) return true
    return this.keyNames.includes(endpoint.keyEnv)
  },

  probe: {
    path: '/v1/messages',
    method: 'POST',
    auth: 'x-api-key',
    headers: { 'anthropic-version': '2023-06-01' },
    body: { model: 'claude-haiku-4-5', max_tokens: 1, messages: [{ role: 'user', content: '.' }] },
    modelEnv: 'API_USAGE_ANTHROPIC_MODEL',
    cost: 'token',
    verified: false // 本机无 key,模型名未实测
  },

  /** 无余额接口 —— 直接说明,由探测负责可用度。 */
  async query() {
    return {
      ok: true,
      balance: null,
      balanceLabel: '余额',
      unsupported: true,
      details: [{ label: '说明', value: '无公开余额接口,仅探测可用性' }]
    }
  }
}
