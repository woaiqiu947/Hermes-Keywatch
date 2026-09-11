/**
 * 本地推理端点(llama.cpp / Ollama / LM Studio 等 OpenAI 兼容服务)
 *
 * 没有"余额"概念,所以这里查的是:
 *   - 在线状态(GET /v1/models)
 *   - 已加载的模型
 *   - 累计 token(llama.cpp 的 Prometheus /metrics,拿得到就算)
 *
 * 只探测环回地址,绝不外发。
 */
const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 从 Prometheus 文本里抓一个指标的值(支持带 label 的多行,累加)。 */
function metric(text, name) {
  const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\{[^}]*\\})?\\s+([0-9.eE+-]+)\\s*$`, 'gm')
  let sum = 0
  let found = false
  for (const m of text.matchAll(re)) {
    const v = num(m[1])
    if (v !== null) {
      sum += v
      found = true
    }
  }
  return found ? sum : null
}

export default {
  id: 'local',
  label: '本地模型端点',
  kind: 'endpoint',
  homepage: '',
  keyNames: [],
  /** 本地端点用不上钥匙,只探在线状态 */
  needsKey: false,
  /** 每个本地端点各出一张卡,故 label 由 registry 覆写 */
  perEndpoint: true,

  match(endpoint) {
    const u = endpoint.baseUrl || ''
    if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)/i.test(u)) return false
    // bridge 由自己的适配器接管
    if (/:9992\b/.test(u)) return false
    return true
  },

  async query({ baseUrl, key, fetchJson, fetchText }) {
    const modelsUrl = `${String(baseUrl).replace(/\/$/, '')}/models`
    const headers = key ? { Authorization: `Bearer ${key}` } : {}

    const r = await fetchJson(modelsUrl, { headers, timeoutMs: 4000 })
    if (!r.ok) {
      return {
        ok: true,
        availabilityHint: 'unreachable', // 端口没在跑 = 网络不可达
        online: false,
        balance: null,
        balanceLabel: '状态',
        details: [{ label: '地址', value: baseUrl }]
      }
    }

    const list = r.data?.data || r.data?.models || []
    const names = list.map((m) => m.id || m.name).filter(Boolean)
    const details = [{ label: '地址', value: baseUrl }]
    details.push({ label: '模型数', value: String(names.length) })
    if (names.length) details.push({ label: '已加载', value: names.slice(0, 2).join(', ') + (names.length > 2 ? ' …' : '') })

    // 尽力拿 token 统计(llama.cpp 有 /metrics;没有就跳过)
    const origin = String(baseUrl).replace(/\/v1\/?$/, '')
    const m = await fetchText(`${origin}/metrics`, { timeoutMs: 4000 })
    if (m.ok) {
      const predicted = metric(m.text, 'llamacpp:tokens_predicted_total')
      const prompt = metric(m.text, 'llamacpp:prompt_tokens_total')
      if (prompt !== null) details.push({ label: '累计输入 token', value: Math.round(prompt).toLocaleString('en-US') })
      if (predicted !== null) details.push({ label: '累计输出 token', value: Math.round(predicted).toLocaleString('en-US') })
    }

    return {
      ok: true,
      availabilityHint: 'ok',
      online: true,
      balance: null,
      balanceLabel: '状态',
      statusBadge: '在线',
      details
    }
  }
}
