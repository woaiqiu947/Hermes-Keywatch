/**
 * registry.mjs — 适配器注册表 + 自动探测 + 并发查询编排
 *
 * 这是整个服务的大脑:
 *   1. 从 Hermes 自己的配置(config.yaml via `hermes config get --json`)和
 *      私有 .env 里**自动发现**本机配置了哪些 provider / 哪些 key;
 *   2. 把每个发现到的端点交给能处理它的适配器(providers/*.mjs);
 *   3. 并发查询,汇总成统一的 JSON 给仪表盘。
 *
 * 换机器时**不需要改代码** —— 探测是数据驱动的,新增一个厂商只需加一个
 * 适配器文件 + 在 ADAPTERS 里登记。
 */
import { getConfig, getEnvPath, loadCredentials, readEnvFile } from './env.mjs'
import bridge from './providers/bridge.mjs'
import deepseek from './providers/deepseek.mjs'
import kimi from './providers/kimi.mjs'
import local from './providers/local.mjs'
import minimax from './providers/minimax.mjs'
import openrouter from './providers/openrouter.mjs'
import zhipu from './providers/zhipu.mjs'

/** 匹配优先级 = 数组顺序(本地/专用端点优先于通用厂商名匹配)。 */
export const ADAPTERS = [bridge, deepseek, zhipu, kimi, openrouter, minimax, local]

/** 所有适配器认得的 key 变量名,用于".env 有 key 但没 provider 配置"的补充探测。 */
const KNOWN_KEY_ENVS = new Set(ADAPTERS.flatMap((a) => a.keyNames || []))

// ── HTTP 工具 ──────────────────────────────────────────────────────────

async function request(url, { headers = {}, timeoutMs = 12000, method = 'GET' } = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, { method, headers, signal: ac.signal, redirect: 'follow' })
    const text = await res.text()
    return { ok: res.ok, status: res.status, text, headers: res.headers }
  } catch (e) {
    return { ok: false, status: 0, text: '', error: e?.name === 'AbortError' ? `超时(${timeoutMs}ms)` : String(e?.message || e) }
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
  // provider 配置里硬编码的 key(本地端点的 "local" 也算,但没意义)
  if (endpoint.apiKey && endpoint.apiKey !== 'local') return endpoint.apiKey
  for (const k of adapter.keyNames || []) {
    if (creds[k]) return creds[k]
  }
  return null
}

/**
 * 扫描本机,返回"应该显示哪些卡片"的定义数组(不查询,只发现)。
 * 返回元素:{ id, adapterId, label, kind, homepage, needsKey, configured, endpoint }
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
  // 3) 别名里引用的 custom provider(可能没出现在 custom_providers 里)
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
  //    (例如 DEEPSEEK_API_KEY —— 只有 key,没有 custom_providers 条目)
  for (const keyEnv of Object.keys(fileEnv)) {
    if (KNOWN_KEY_ENVS.has(keyEnv)) {
      endpoints.push({ name: null, baseUrl: null, keyEnv, apiKey: null, source: 'env_key' })
    }
  }

  // 稳定排序:显式配置优先于纯 key 推断
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
      endpoint: ep
    })
  }
  return cards
}

// ── 查询 ───────────────────────────────────────────────────────────────

/** 查一张卡。永远返回一个结构化结果,不抛出。 */
export async function queryCard(card, creds) {
  const adapter = ADAPTERS.find((a) => a.id === card.adapterId)
  const base = {
    id: card.id,
    label: card.label,
    kind: card.kind,
    homepage: card.homepage,
    configured: card.configured,
    key_source: card.keySource,
    fetched_at: new Date().toISOString()
  }
  if (!adapter) return { ...base, status: 'error', error: '适配器缺失' }

  if (!card.configured) {
    return {
      ...base,
      status: 'unconfigured',
      balance: null,
      balance_label: adapter.kind === 'endpoint' ? '状态' : '余额',
      details: [],
      bars: [],
      error: card.needsKey ? '未配置 API Key' : null
    }
  }

  const key = resolveKey(adapter, card.endpoint, creds)
  try {
    const r = await adapter.query({
      key,
      baseUrl: card.endpoint.baseUrl || adapter.defaultBaseUrl,
      endpoint: card.endpoint,
      fetchJson,
      fetchText
    })
    if (!r.ok) {
      const reason = r.reason || 'error'
      return {
        ...base,
        status: reason === 'unconfigured' ? 'unconfigured' : 'error',
        balance: null,
        balance_label: adapter.kind === 'endpoint' ? '状态' : '余额',
        details: [],
        bars: [],
        error:
          reason === 'unconfigured'
            ? '未配置 API Key'
            : reason === 'http'
              ? `HTTP ${r.status}${r.detail ? ' — ' + String(r.detail).slice(0, 160) : ''}`
              : String(r.detail || '无法解析响应')
      }
    }
    return {
      ...base,
      status: 'ok',
      balance: r.balance ?? null,
      balance_label: r.balanceLabel || '余额',
      currency: r.currency || null,
      online: r.online,
      status_badge: r.statusBadge || r.status || null,
      details: r.details || [],
      bars: r.bars || [],
      note: r.note || '',
      unsupported: r.unsupported || false,
      error: null
    }
  } catch (e) {
    return {
      ...base,
      status: 'error',
      balance: null,
      balance_label: '余额',
      details: [],
      bars: [],
      error: String(e?.message || e)
    }
  }
}

/** 探测 + 并发查询,返回给仪表盘的完整载荷。 */
export async function queryAll() {
  const envPath = await getEnvPath()
  const creds = loadCredentials(envPath)
  const cards = await discoverProviders()

  const providers = await Promise.all(cards.map((c) => queryCard(c, creds)))

  // 排序:有问题的在前(需要用户注意),然后按 kind
  const order = { error: 0, unconfigured: 1, ok: 2 }
  providers.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9))

  return {
    object: 'api_usage.snapshot',
    generated_at: new Date().toISOString(),
    env_path: envPath,
    count: providers.length,
    configured_count: providers.filter((p) => p.configured).length,
    providers
  }
}
