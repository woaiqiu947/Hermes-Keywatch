/**
 * MiniMax 适配器(占位)
 *
 * MiniMax 没有公开、稳定的"账户余额"查询端点到本仓库编写时为止(实测
 * 常见路径均 404)。这里不编造接口,而是诚实地返回"暂不支持自动查询",
 * 并在卡片上给出控制台链接,让用户自己去看。
 *
 * 如果将来官方开放了端点,只需在这里补上 query 实现。
 */
export default {
  id: 'minimax',
  label: 'MiniMax',
  kind: 'unsupported',
  homepage: 'https://platform.minimaxi.com/user-center/basic-information',
  keyNames: ['MINIMAX_API_KEY', 'MINIMAX_CN_API_KEY'],
  defaultBaseUrl: 'https://api.minimax.chat/v1',

  match(endpoint) {
    if (/minimax/i.test(endpoint.baseUrl || '')) return true
    return this.keyNames.includes(endpoint.keyEnv)
  },

  async query({ key }) {
    if (!key) return { ok: false, reason: 'unconfigured' }
    return {
      ok: true,
      balance: null,
      balanceLabel: '余额',
      unsupported: true,
      details: [{ label: '说明', value: '官方暂未提供余额查询 API' }]
    }
  }
}
