/**
 * registry.mjs — 适配器注册表 + 自动探测 + 并发查询编排
 *
 * 这是整个服务的大脑:
 *   1. 从 Hermes 自己的配置(config.yaml via `hermes config get --json`)和
 *      私有 .env 里**自动发现**本机配置了哪些 provider / 哪些 key;
 *   2. 把每个发现到的端点交给能处理它的适配器(providers/*.mjs);
 *   3. 并发查询,汇总成统一的 JSON 给仪表盘。
 *
 * 换机器时**不需要改代码** —— 探测是数据驱动的。
 */
import { applyLowBalance, availabilityFromBalance, availabilityInfo, severityOf } from './availability.mjs'
import { getConfig, getEnvPath, loadCredentials, readEnvFile } from './env.mjs'
import { probe, PROBING_ENABLED, probeCacheSize, scrub } from './probe.mjs'
import anthropic from './providers/anthropic.mjs'
import bridge from './providers/bridge.mjs'
import deepseek from './providers/deepseek.mjs'
import kimi from './providers/kimi.mjs'
import local from './providers/local.mjs'
import minimax from './providers/minimax.mjs'
import openai from './providers/openai.mjs'
import openrouter from './providers/openrouter.mjs'
import zhipu from './providers/zhipu.mjs'

/** 匹配优先级 = 数组顺序(特定厂商优先于本地/通用匹配)。 */
export const ADAPTERS = [bridge, deepseek, zhipu, kimi, openrouter, minimax, anthropic, openai, local]

/** 所有适配器认得的 key 变量名,用于".env 有 key 但没 provider 配置"的补充探测。 */
const KNOWN_KEY_ENVS = new Set(ADAPTERS.flatMap((a) => a.keyNames || []))

/** 声明了余额接口(而非纯探测)的适配器 —— 用于给用户提示"接上能看到什么"。 */
const ADAPTERS_BALANCE = new Set(ADAPTERS.filter((a) => a.kind === 'balance' || a.kind === 'quota').map((a) => a.id))

/**
 * 默认低余额阈值。注册表未指定时的兜底。
 * 可通过环境变量覆盖,例如 API_USAGE_LOW_THRESHOLD=20 或 API_USAGE_LOW_THRESHOLD=CNY:20。
 */
function defaultThreshold() {
  const raw = process.env.API_USAGE_LOW_THRESHOLD
  if (!raw) return null
  const m = String(raw).match(/^(?:([A-Z]{3}):)?\s*([0-9.]+)$/)
  if (!m) return null
  return { amount: m[2], currency: m[1] || null }
}

// ── HTTP 工具 ──────────────────────────────────────────────────────────

async function request(url, { headers = {}, timeoutMs = 12000, method = 'GET', body } = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, { method, headers, body, signal: ac.signal, redirect: 'follow' })
    const text = await res.text()
    return { ok: res.ok, status: res.status, text, headers: res.headers }
  } catch (e) {
    return {
      ok: false,
      status: 0,
      text: '',
      error: e?.name === 'AbortError' ? `超时(${timeoutMs}ms)` : String(e?.message || e)
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchJson(url, opts = {}) {
  const r = await request(url, opts)
  let data = null
  let parseError = null
  if (r.text) {
    try {
      data = JSON.parse(r.text)
    } catch (e) {
      parseError = e.message
    }
  }
  return { ...r, data, parseError }
}

export async function fetchText(url, opts = {}) {
  return request(url, opts)
}

// ── 探测 ───────────────────────────────────────────────────────────────

/** 解析某个端点可用的凭据(不把它写进任何响应里)。 */
function resolveKey(adapter, endpoint, creds) {
  if (endpoint.keyEnv && creds[endpoint.keyEnv]) return creds[endpoint.keyEnv]
  if (endpoint.apiKey && endpoint.apiKey !== 'local') return endpoint.apiKey
  for (const k of adapter.keyNames || []) {
    if (creds[k]) return creds[k]
  }
  return null
}

/**
 * 扫描本机,返回"应该显示哪些卡片"的定义数组(不查询,只发现)。
 */
export async function discoverProviders() {
  const envPath = await getEnvPath()
  const fileEnv = readEnvFile(envPath)
  const creds = loadCredentials(envPath)

  const customProviders = (await getConfig('custom_providers', [])) || []
  const modelCfg = (await getConfig('model', {})) || {}
  const aliases = (await getConfig('model_aliases', {})) || {}

  /** @type {Array<{name:string|null, baseUrl:string|null, keyEnv:string|null, apiKey:string|null, source:string}>} */
  const endpoints = []

  // 1) custom_providers —— 本机显式登记的 provider(信息最全,优先级最高)
  for (const p of Array.isArray(customProviders) ? customProviders : []) {
    endpoints.push({
      name: p.name || null,
      baseUrl: p.base_url || p.baseUrl || null,
      keyEnv: p.key_env || p.keyEnv || null,
      apiKey: p.api_key || p.apiKey || null,
      source: 'custom_provider'
    })
  }
  // 2) 默认模型指向的 provider
  if (modelCfg.provider) {
    endpoints.push({
      name: String(modelCfg.provider).replace(/^custom:/, '') || null,
      baseUrl: modelCfg.base_url || null,
      keyEnv: modelCfg.key_env || null,
      apiKey: modelCfg.api_key || null,
      source: 'custom_provider'
    })
  }
  // 3) 别名里引用的 custom provider
  for (const cfg of Object.values(aliases || {})) {
    const prov = cfg?.provider
    if (prov && String(prov).startsWith('custom:')) {
      endpoints.push({
        name: String(prov).slice('custom:'.length),
        baseUrl: cfg.base_url || null,
        keyEnv: cfg.key_env || null,
        apiKey: cfg.api_key || null,
        source: 'alias'
      })
    }
  }
  // 4) 反向补充:.env 里有已知厂商的 key,但没登记 provider
  for (const keyEnv of Object.keys(fileEnv)) {
    if (KNOWN_KEY_ENVS.has(keyEnv)) {
      endpoints.push({ name: null, baseUrl: null, keyEnv, apiKey: null, source: 'env_key' })
    }
  }

  const rank = { custom_provider: 0, alias: 1, env_key: 2 }
  endpoints.sort((a, b) => (rank[a.source] ?? 9) - (rank[b.source] ?? 9))

  const seen = new Set()
  const cards = []
  for (const ep of endpoints) {
    const adapter = ADAPTERS.find((a) => a.match(ep))
    if (!adapter) continue

    const id = adapter.perEndpoint ? `${adapter.id}:${ep.name || ep.baseUrl}` : adapter.id
    if (seen.has(id)) continue
    seen.add(id)

    const needsKey = adapter.needsKey !== false
    const key = resolveKey(adapter, ep, creds)
    const configured = needsKey ? Boolean(key) : true

    cards.push({
      id,
      adapterId: adapter.id,
      label: adapter.perEndpoint && ep.name ? `${adapter.label} · ${ep.name}` : adapter.label,
      kind: adapter.kind || 'balance',
      homepage: adapter.homepage || '',
      needsKey,
      configured,
      keySource: ep.keyEnv || (ep.apiKey ? '(config)' : null),
      balanceProvesKey: adapter.balanceProvesKey !== false,
      hasProbe: Boolean(adapter.probe?.path),
      /** 探测端点/模型名是否已在本机实测过。false → 卡片上标注,避免误导。 */
      probeVerified: adapter.probe ? adapter.probe.verified !== false : null,
      endpoint: ep
    })
  }
  return cards
}

// ── 查询 ───────────────────────────────────────────────────────────────

/**
 * 查一张卡。永远返回一个结构化结果,不抛出。
 *
 * 可用度的判定顺序(降级链,见 availability.mjs):
 *   0) 未配置 key            → unconfigured
 *   1) 端点自己给的判定       → (本地端点用它的在线状态)
 *   2) 余额调用顺带判定       → 有余额接口时零额外成本拿到 key 有效性
 *   3) 真正的探测             → 前两者都给不出结论时才发探测请求
 */
export async function queryCard(card, creds) {
  const adapter = ADAPTERS.find((a) => a.id === card.adapterId)
  const t0 = Date.now()
  const base = {
    id: card.id,
    adapterId: card.adapterId, // 必须有:queryAll 据此判断"哪些厂商已被本机接入"
    label: card.label,
    kind: card.kind,
    homepage: card.homepage,
    configured: card.configured,
    key_source: card.keySource,
    fetched_at: new Date().toISOString()
  }
  if (!adapter) return { ...base, status: 'error', availability: 'unknown', error: '适配器缺失' }

  const finish = (extra) => {
    const info = availabilityInfo(extra.availability)
    return {
      ...base,
      balance: null,
      balance_label: '余额',
      details: [],
      bars: [],
      error: null,
      ...extra,
      availability_label: info.label,
      availability_hint: info.hint,
      availability_tone: info.tone,
      latency_ms: extra.latency_ms ?? Date.now() - t0
    }
  }

  if (!card.configured) {
    return finish({
      status: 'unconfigured',
      availability: 'unconfigured',
      balance_label: card.kind === 'endpoint' ? '状态' : '余额',
      error: card.needsKey ? '未配置 API Key' : null
    })
  }

  const key = resolveKey(adapter, card.endpoint, creds)
  const baseUrl = card.endpoint.baseUrl || adapter.defaultBaseUrl

  // ── 余额查询 ──────────────────────────────────────────────
  // 所有适配器的 query() 都调用:有余额接口的去取余额,纯探测型的只回一句说明
  // (它们的 availabilityHint/balanceProvesKey 决定这个结果是否算数)。
  let balanceOutcome = null
  try {
    balanceOutcome = await adapter.query({ key, baseUrl, endpoint: card.endpoint, fetchJson, fetchText })
  } catch (e) {
    balanceOutcome = { ok: false, reason: 'error', detail: String(e?.message || e) }
  }

  // ── 可用度判定 ────────────────────────────────────────────
  const threshold = defaultThreshold()
  let availability = null
  let availabilitySource = null
  let probeInfo = null

  // 1) 端点自报(本地端点的在线状态)
  if (balanceOutcome?.availabilityHint) {
    availability = balanceOutcome.availabilityHint
    availabilitySource = 'endpoint'
  }
  // 2) 余额调用顺带判定
  if (!availability) {
    const fromBalance = availabilityFromBalance(balanceOutcome, { provesKey: card.balanceProvesKey })
    if (fromBalance) {
      availability = fromBalance
      availabilitySource = 'balance'
    }
  }
  // 3) 探测兜底
  if (!availability && PROBING_ENABLED) {
    const p = await probe(card, { key, baseUrl, fetchJson, adapter })
    if (p.attempted) {
      availability = p.availability
      availabilitySource = 'probe'
      probeInfo = p
    }
  }
  if (!availability) availability = 'unknown'

  // 余额低于阈值 → 降级为 low(仅当当前是 ok,且币种一致)
  availability = applyLowBalance(availability, balanceOutcome?.balance, balanceOutcome?.currency, threshold)

  // ── 组装输出 ──────────────────────────────────────────────
  const balanceOk = Boolean(balanceOutcome?.ok)

  // 余额这条路失败,但可用度另有结论(比如探测说 key 有效)—— 要如实说明"余额拿不到"
  let error = null
  if (!balanceOk) {
    const r = balanceOutcome || {}
    error =
      r.reason === 'http'
        ? `余额查询 HTTP ${r.status}${r.detail ? ' — ' + String(r.detail).slice(0, 160) : ''}`
        : r.reason === 'shape'
          ? String(r.detail || '无法解析余额响应')
          : String(r.detail || '余额查询失败')
  }

  const probeNote = probeInfo
    ? `探测:HTTP ${probeInfo.status}${probeInfo.cost === 'free' ? '(免费)' : '(1 token)'}${probeInfo.cached ? ' 缓存' : ''}${card.probeVerified === false ? ' · 探测端点未实测' : ''}`
    : card.hasProbe && card.probeVerified === false
      ? '探测端点未实测,若报「探测配置错误」请用 API_USAGE_PROBE_MODEL 指定模型'
      : ''

  // status 是给前端选卡片样式用的粗粒度分类,由可用度推导
  const status =
    availability === 'unconfigured' ? 'unconfigured' : availability === 'ok' || availability === 'low' ? 'ok' : 'warn'

  return finish({
    status,
    availability,
    availability_source: availabilitySource,
    balance: balanceOk ? (balanceOutcome.balance ?? null) : null,
    balance_label: balanceOutcome?.balanceLabel || (card.kind === 'endpoint' ? '状态' : '余额'),
    currency: balanceOk ? (balanceOutcome.currency || null) : null,
    online: balanceOutcome?.online,
    status_badge: scrub(balanceOutcome?.statusBadge || '', key) || null,
    details: (balanceOutcome?.details || []).map((d) => ({
      label: scrub(d?.label || '', key),
      value: scrub(d?.value ?? '', key)
    })),
    bars: balanceOutcome?.bars || [],
    note: scrub([balanceOutcome?.note, probeNote].filter(Boolean).join(' · '), key),
    unsupported: Boolean(balanceOutcome?.unsupported),
    latency_ms: Date.now() - t0,
    error: error ? scrub(error, key) : null
  })
}

/** 探测 + 并发查询,返回给仪表盘的完整载荷。 */
export async function queryAll() {
  const envPath = await getEnvPath()
  const creds = loadCredentials(envPath)
  const cards = await discoverProviders()

  // 并发上限:避免同时打太多家触发风控
  const limit = Math.max(1, Number(process.env.API_USAGE_CONCURRENCY || 4))
  const providers = []
  for (let i = 0; i < cards.length; i += limit) {
    const chunk = cards.slice(i, i + limit)
    providers.push(...(await Promise.all(chunk.map((c) => queryCard(c, creds)))))
  }

  // 排序:需要注意的排前面,正常/未配置沉底。
  // 本地端点的"离线"只是没在跑 llama.cpp,不是需要处理的问题,故整体压到后面。
  const severityOfCard = (p) => (p.kind === 'endpoint' ? 9.5 : severityOf(p.availability))
  providers.sort((a, b) => {
    const d = severityOfCard(a) - severityOfCard(b)
    return d !== 0 ? d : String(a.label).localeCompare(String(b.label), 'zh')
  })

  // ── 可接入但本机尚未配置的厂商 ─────────────────────────────
  // 设计意图:别让"你没配 key"变成"你不知道支持它"。这是纯信息展示,不发任何请求。
  const activeAdapters = new Set(providers.map((p) => p.adapterId))
  const suggestions = ADAPTERS.filter(
    (a) => !activeAdapters.has(a.id) && (a.keyNames || []).length > 0 && a.kind !== 'endpoint'
  ).map((a) => ({
    id: a.id,
    label: a.label,
    homepage: a.homepage || '',
    key_env: a.keyNames[0],
    kind: a.kind || 'balance',
    /** 有余额接口 → 加上就能看到具体余额;否则只能看"能不能用" */
    has_balance_api: ADAPTERS_BALANCE.has(a.id)
  }))

  return {
    object: 'api_usage.snapshot',
    generated_at: new Date().toISOString(),
    env_path: envPath,
    probing_enabled: PROBING_ENABLED,
    probe_cache_size: probeCacheSize(),
    count: providers.length,
    configured_count: providers.filter((p) => p.configured).length,
    ok_count: providers.filter((p) => p.availability === 'ok' || p.availability === 'low').length,
    /** 需要处理的数量(失效/欠费/限流)—— 仪表盘用它决定是否弹告警横幅 */
    attention_count: providers.filter((p) =>
      ['invalid_key', 'exhausted', 'rate_limited', 'low'].includes(p.availability)
    ).length,
    suggestions,
    providers
  }
}
