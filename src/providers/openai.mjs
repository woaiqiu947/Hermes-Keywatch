/**
 * OpenAI 适配器 —— **纯探测型**(余额接口现状未确认)
 *
 * 历史上 OpenAI 的 billing 类接口不接受标准 API Key,故这里不假装能查余额,
 * 只做可用性探测。若将来确认有可用端点,补一个 balance 段即可。
 */
export default {
  id: 'openai',
  label: 'OpenAI',
  kind: 'probe-only',
  homepage: 'https://platform.openai.com/settings/organization/billing',
  keyNames: ['OPENAI_API_KEY'],
  defaultBaseUrl: 'https://api.openai.com/v1',
  /** 同 anthropic:query() 是桩函数,不代表 key 有效,可用度交给探测 */
  balanceProvesKey: false,

  match(endpoint) {
    if (/api\.openai\.com/i.test(endpoint.baseUrl || '')) return true
    return this.keyNames.includes(endpoint.keyEnv)
  },

  probe: {
    path: '/chat/completions',
    body: { model: 'gpt-4o-mini', max_tokens: 1, messages: [{ role: 'user', content: '.' }] },
    modelEnv: 'API_USAGE_OPENAI_MODEL',
    cost: 'token',
    verified: false
  },

  async query() {
    return {
      ok: true,
      balance: null,
      balanceLabel: '余额',
      unsupported: true,
      details: [{ label: '说明', value: '未确认可用余额接口,仅探测可用性' }]
    }
  }
}
