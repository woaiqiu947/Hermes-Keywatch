/**
 * probe.mjs — 可用性探测:B 层降级链的核心
 *
 * 目的:判定"这个 key 现在还能不能调通",覆盖**所有**厂商 —— 不管厂商有没有
 * 公开的余额查询接口。
 *
 * 成本控制(按优先级选择探测手段,能用免费的就不用付费的):
 *   1. `cost: 'free'`  —— 免费且带鉴权的端点(如本地 bridge 的 GET /v1/models)。
 *                         一次 HTTP,不消耗任何额度。
 *   2. `cost: 'token'` —— 最小 1-token 对话请求。只在没有免费端点时才用。
 *   3. 余额接口复用 —— 有余额接口时,余额调用本身已证明 key 有效(见 availability.mjs),
 *                      连探测都不必发。
 *
 * 探测结果按 `id + key 哈希` 缓存,默认 5 分钟。轮换 key 会自动失效(哈希变了),
 * 且缓存里**永远不存 key 本身**。
 */
import { createHash } from 'node:crypto'
import { classifyResponse } from './availability.mjs'

const PROBE_TTL_MS = Number(process.env.API_USAGE_PROBE_TTL_MS || 300000) // 5 分钟
const PROBE_TIMEOUT_MS = Number(process.env.API_USAGE_PROBE_TIMEOUT_MS || 8000)

/** 探测开关。设 API_USAGE_PROBE=0 可完全关闭(比如网络受限或想零调用)。 */
export const PROBING_ENABLED = process.env.API_USAGE_PROBE !== '0'

/** 缓存:{ 'cardId:keyHash': { at, result } } */
const cache = new Map()

/** key 的短哈希 —— 只用于让缓存随轮换失效,不可反推。 */
function keyHash(key) {
  if (!key) return 'nokey'
  return createHash('sha256').update(String(key)).digest('hex').slice(0, 12)
}

function joinUrl(base, path) {
  if (/^https?:\/\//i.test(path)) return path
  return String(base || '').replace(/\/+$/, '') + '/' + String(path).replace(/^\/+/, '')
}

function authHeaders(auth, key) {
  if (!key || auth === 'none') return {}
  if (auth === 'x-api-key') return { 'x-api-key': key }
  return { Authorization: `Bearer ${key}` }
}

/**
 * 脱敏 —— 这是"绝不输出 key 值"承诺的最后一道防线。
 *
 * 为什么需要:厂商的错误响应里**常常回显 key 片段**,例如 DeepSeek 对无效 key 返回
 *   {"error":{"message":"Authentication Fails, Your api key: ****0000 is invalid"}}
 * 厂商自己做了掩码,但我们不该把"key 是否泄漏"这件事押在别人的实现上。凡是要
 * 进入输出(仪表盘 / 日志)的字符串,一律先过这里:
 *   1) 已知的真实 key 值 —— 整段替换;
 *   2) 形如 sk-/sk-ant-/gsk_ 等常见 key 词法 —— 正则兜底;
 *   3) 厂商自带的掩码片段(****xxxx)—— 连末四位也不留。
 */
export function scrub(text, secret) {
  let s = String(text ?? '')
  if (secret) {
    // 整段、以及"去掉前缀后的主体"都可能出现,一并抹掉
    const body = String(secret).replace(/^[a-zA-Z_-]{2,8}[-_]/, '')
    for (const v of [String(secret), body].filter((x) => x && x.length >= 6)) {
      s = s.split(v).join('[REDACTED]')
    }
  }
  return s
    .replace(/\b(sk|gsk|xai|api|key)[-_][A-Za-z0-9_-]{8,}\b/gi, '[REDACTED]')
    .replace(/\*{2,}[A-Za-z0-9]{2,}/g, '[REDACTED]')
    .slice(0, 180)
}

/**
 * 执行一次探测。
 * @returns {{ attempted: boolean, availability?: string, status?: number, detail?: string,
 *             cost?: string, latencyMs?: number, cached?: boolean }}
 */
export async function probe(card, { key, baseUrl, fetchJson, adapter }) {
  const spec = adapter?.probe
  if (!PROBING_ENABLED || !spec || !spec.path) {
    return { attempted: false }
  }

  const ck = `${card.id}:${keyHash(key)}`
  const hit = cache.get(ck)
  const now = Date.now()
  if (hit && now - hit.at < PROBE_TTL_MS) {
    return { ...hit.result, cached: true }
  }

  // 探测用的请求体。模型名可能随厂商更迭失效,故允许用环境变量覆盖:
  //   例如 API_USAGE_PROBE_MODEL=claude-3-5-haiku-latest
  // 厂商专属覆盖优先 (spec.modelEnv),其次全局 (API_USAGE_PROBE_MODEL)。
  const specBody = spec.body || (spec.model ? { model: spec.model, max_tokens: 1, messages: [{ role: 'user', content: '.' }] } : null)
  const modelOverride =
    (spec.modelEnv && process.env[spec.modelEnv]) || process.env.API_USAGE_PROBE_MODEL || null
  const body = specBody && modelOverride ? { ...specBody, model: modelOverride } : specBody

  const url = joinUrl(baseUrl || adapter.defaultBaseUrl, spec.path)
  const headers = { ...authHeaders(spec.auth || 'bearer', key), ...(spec.headers || {}) }
  const init = { method: spec.method || 'POST', headers, timeoutMs: PROBE_TIMEOUT_MS }
  if (init.method !== 'GET' && body) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json'
    init.body = JSON.stringify(body)
  }

  const t0 = Date.now()
  const r = await fetchJson(url, init)
  const latencyMs = Date.now() - t0

  // 超时/网络失败:fetchJson 会给出 ok:false 且 status:0
  const availability = classifyResponse(r.status, r.text)
  const result = {
    attempted: true,
    availability,
    status: r.status,
    detail: scrub(r.error || r.text, key),
    cost: spec.cost || 'token',
    latencyMs,
    cached: false
  }

  // 只缓存"确定性"结论。网络抖动导致的 unreachable 不缓存,免得把瞬时故障
  // 固化 5 分钟,让人以为线路一直不通。
  if (availability !== 'unreachable') {
    cache.set(ck, { at: now, result })
  }
  return result
}

/** 清空探测缓存(测试与调试用)。 */
export function clearProbeCache() {
  cache.clear()
}

/** 缓存条数(供 /health 观测)。 */
export function probeCacheSize() {
  return cache.size
}

/**
 * 缓存键列表(供测试断言"缓存里不含 key 明文")。
 * 键的形态是 `cardId:sha256前12位`,因此这里返回的内容可以安全外露。
 */
export function probeCacheKeys() {
  return [...cache.keys()]
}
