/**
 * availability.mjs — 可用度(availability)判定
 *
 * 这是本项目最有价值的一块:余额接口只有少数厂商提供,但"这个 key 现在还能不能调通"
 * **所有厂商都能探**。于是把两件事分开:
 *
 *   balance      —— 还剩多少钱(少数厂商有,精确)
 *   availability —— 现在能不能用(全部厂商可探)
 *
 * 关键区分(务必保持):
 *   429 被限流 != 402 余额耗尽
 *   前者等一会儿就好,后者要去充值。混成一个"失败"就看不出该怎么办。
 */

/** 可用度枚举。tone 决定前端配色:good / warn / bad / muted。 */
export const AVAILABILITY = {
  ok: { label: '可用', tone: 'good', hint: '一切正常' },
  low: { label: '余额偏低', tone: 'warn', hint: '仍可调用,但余额已低于设定阈值' },
  exhausted: { label: '余额耗尽', tone: 'bad', hint: '需充值;调用会失败' },
  invalid_key: { label: 'Key 失效', tone: 'bad', hint: '被删除、过期或抄写错误' },
  forbidden: { label: '权限受限', tone: 'bad', hint: '权限不足或地区限制' },
  rate_limited: { label: '被限流', tone: 'warn', hint: '等一会儿再试,不代表没钱' },
  upstream_error: { label: '厂商故障', tone: 'warn', hint: '厂商侧问题,稍后重试' },
  unreachable: { label: '网络不可达', tone: 'bad', hint: '超时或 DNS 失败' },
  config_error: { label: '探测配置错误', tone: 'bad', hint: '本插件自己的探测参数写错了,不是厂商的问题' },
  unknown: { label: '无法判定', tone: 'muted', hint: '既没有余额接口,也没能完成探测' },
  unconfigured: { label: '未配置', tone: 'muted', hint: '缺少 API Key' }
}

export const AVAILABILITY_IDS = Object.keys(AVAILABILITY)

/**
 * 从 HTTP 状态码判定可用度。
 *
 * 400 单独归类为 config_error:它几乎总是"我们自己的请求体写错了",
 * 若混进"厂商不可用",一个探测参数的笔误就会伪装成厂商故障(见设计文档 §8.2)。
 */
export function classifyHttp(status) {
  if (status === 200 || status === 201 || status === 202 || status === 204) return 'ok'
  if (status === 400) return 'config_error'
  if (status === 401) return 'invalid_key'
  if (status === 402) return 'exhausted'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'config_error'
  if (status === 429) return 'rate_limited'
  if (status >= 500 && status <= 599) return 'upstream_error'
  if (status === 0) return 'unreachable'
  return 'unknown'
}

/**
 * 响应体里的错误标识可以推翻状态码。
 * 例:有的厂商把"余额不足"塞在 400/403 里(而不是 402),只看状态码会误判。
 */
const BODY_HINTS = [
  { re: /insufficient[_ ]?(quota|balance)|exceeded_current_quota|balance[_ ]not[_ ]enough|余额不足|欠费/i, to: 'exhausted' },
  { re: /invalid[_ ]?api[_ ]?key|invalid[_ ]?authentication|authentication[_ ]?error|令牌已过期|验证不正确/i, to: 'invalid_key' },
  { re: /rate[_ ]?limit|too[_ ]?many[_ ]?requests|请求过于频繁|限流/i, to: 'rate_limited' },
  { re: /permission[_ ]?denied|not[_ ]?authorized|region|地区|权限/i, to: 'forbidden' }
]

/** 综合状态码与响应体文本,给出可用度。 */
export function classifyResponse(status, bodyText) {
  const base = classifyHttp(status)
  // 2xx 不必再看响应体
  if (base === 'ok') return base
  const text = String(bodyText || '')
  for (const h of BODY_HINTS) {
    if (h.re.test(text)) return h.to
  }
  return base
}

/**
 * 余额低于阈值 → 可用度降级为 low(仅当当前判定是 ok)。
 * 阈值必须与余额同币种才有意义,否则不比较(避免拿 ¥ 阈值比 $ 余额)。
 */
export function applyLowBalance(availability, balance, currency, threshold) {
  if (availability !== 'ok') return availability
  if (!threshold) return availability
  const b = Number(balance)
  const t = Number(threshold.amount)
  if (!Number.isFinite(b) || !Number.isFinite(t) || t <= 0) return availability
  if (threshold.currency && currency && threshold.currency !== currency) return availability
  return b < t ? 'low' : availability
}

/** 取展示信息。 */
export function availabilityInfo(id) {
  return AVAILABILITY[id] || AVAILABILITY.unknown
}

/**
 * 可用度的"严重度"排序,用于把需要注意的卡片排到前面。
 * 数字越小越需要注意。
 */
const SEVERITY = {
  exhausted: 0,
  invalid_key: 1,
  forbidden: 2,
  low: 3,
  unreachable: 4,
  upstream_error: 5,
  config_error: 6,
  rate_limited: 7,
  unknown: 8,
  unconfigured: 9,
  ok: 10
}

export function severityOf(id) {
  return SEVERITY[id] ?? 11
}

/**
 * 从余额查询结果里"顺带"判定可用度。
 *
 * 优化点(比设计文档更省):**多数**厂商的余额接口需要凭据,所以那次调用本身
 * 就是一次认证探测 —— 200 已证明 key 有效、账户未欠费(DeepSeek 还直接返回
 * is_available)。这种情况不必再发 1-token 请求,零额外 token 成本。
 *
 * 但**不是所有**余额来源都能证明 key 有效。例如本地 bridge 的 admin 端点无需鉴权,
 * 它 200 只说明"bridge 活着",并不能证明 CommandCode 的 key 可用;这类适配器
 * 声明 `balanceProvesKey: false`,我们返回 null 交给真正的探测。
 *
 * @param {object|null} r  适配器 query() 的返回值
 * @param {{provesKey?: boolean}} [opts]
 * @returns {string|null}  可用度;null 表示"无法据此判定",调用方应回退到探测
 */
export function availabilityFromBalance(r, opts = {}) {
  if (!r) return null
  if (r.ok) {
    if (opts.provesKey === false) return null // 这次调用不能证明 key 有效
    // 厂商明确说不可用(DeepSeek 的 is_available=false)
    if (r.accountUnavailable) return 'exhausted'
    return 'ok'
  }
  if (r.reason === 'unconfigured') return 'unconfigured'
  if (r.reason === 'http') return classifyResponse(r.status, r.detail)
  return null // shape 之类的问题,不该影响可用度判定
}
