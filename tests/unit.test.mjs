/**
 * 单元测试 —— 零依赖,用 node:test 内置测试框架。
 *
 *   node --test tests/
 *
 * 重点覆盖三块容易出错、且出错后**很难察觉**的逻辑:
 *   1. 状态码 → 可用度 的映射(搞错了会把"欠费"说成"限流",让人白等)
 *   2. 降级链的判定顺序(余额调用何时"顺带"算数、何时不算)
 *   3. 脱敏 —— 这是安全断言:任何路径都不得把 key 泄进输出
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  applyLowBalance,
  availabilityFromBalance,
  classifyHttp,
  classifyResponse,
  availabilityInfo,
  severityOf
} from '../src/availability.mjs'
import { scrub, probe, clearProbeCache, PROBING_ENABLED } from '../src/probe.mjs'

// ── 1. 状态码映射 ──────────────────────────────────────────────

test('classifyHttp: 各类状态码映射到正确的可用度', () => {
  assert.equal(classifyHttp(200), 'ok')
  assert.equal(classifyHttp(204), 'ok')
  assert.equal(classifyHttp(400), 'config_error') // 我们自己的请求写错了
  assert.equal(classifyHttp(401), 'invalid_key')
  assert.equal(classifyHttp(402), 'exhausted') // 欠费
  assert.equal(classifyHttp(403), 'forbidden')
  assert.equal(classifyHttp(404), 'config_error')
  assert.equal(classifyHttp(429), 'rate_limited') // 限流 != 欠费
  assert.equal(classifyHttp(500), 'upstream_error')
  assert.equal(classifyHttp(503), 'upstream_error')
  assert.equal(classifyHttp(0), 'unreachable')
})

test('限流与欠费必须区分开 —— 这是本项目最核心的一条判定', () => {
  // 429 等一会儿就好,402 要去充值。混为一谈用户就不知道该干什么。
  assert.notEqual(classifyHttp(429), classifyHttp(402))
  assert.equal(availabilityInfo(classifyHttp(429)).tone, 'warn')
  assert.equal(availabilityInfo(classifyHttp(402)).tone, 'bad')
})

test('classifyResponse: 响应体可以推翻状态码', () => {
  // 有的厂商把"余额不足"塞在 400/403 里
  assert.equal(classifyResponse(400, '{"error":"insufficient balance"}'), 'exhausted')
  assert.equal(classifyResponse(400, '{"error":"余额不足"}'), 'exhausted')
  assert.equal(classifyResponse(403, '{"error":"invalid api key"}'), 'invalid_key')
  assert.equal(classifyResponse(400, '{"error":"rate limit exceeded"}'), 'rate_limited')
  // 2xx 不再看响应体(避免把正常响应里出现的词当错误)
  assert.equal(classifyResponse(200, 'insufficient balance'), 'ok')
})

test('severityOf: 需要注意的排在前面', () => {
  assert.ok(severityOf('exhausted') < severityOf('low'))
  assert.ok(severityOf('invalid_key') < severityOf('ok'))
  assert.ok(severityOf('ok') > severityOf('unknown'))
})

// ── 2. 阈值与降级链 ────────────────────────────────────────────

test('applyLowBalance: 只有 ok 才会被降级,且币种必须一致', () => {
  assert.equal(applyLowBalance('ok', 5, 'CNY', { amount: '10', currency: 'CNY' }), 'low')
  assert.equal(applyLowBalance('ok', 50, 'CNY', { amount: '10', currency: 'CNY' }), 'ok')
  // 币种不同不比较:别拿 ¥ 阈值去比 $ 余额
  assert.equal(applyLowBalance('ok', 5, 'USD', { amount: '10', currency: 'CNY' }), 'ok')
  // 非 ok 状态不因余额而改变
  assert.equal(applyLowBalance('invalid_key', 5, 'CNY', { amount: '10', currency: 'CNY' }), 'invalid_key')
  // 没有阈值不改判定
  assert.equal(applyLowBalance('ok', 5, 'CNY', null), 'ok')
})

test('availabilityFromBalance: 余额调用何时能"顺带"证明 key 有效', () => {
  // 默认:余额 200 → 证明 key 有效,零额外探测成本
  assert.equal(availabilityFromBalance({ ok: true }), 'ok')
  // 但余额来源不经鉴权时(如本机 bridge),不能证明 key 有效 → 交给探测
  assert.equal(availabilityFromBalance({ ok: true }, { provesKey: false }), null)
  // 厂商明确说账户不可用
  assert.equal(availabilityFromBalance({ ok: true, accountUnavailable: true }), 'exhausted')
  // 余额接口报错时,拿它当探测结果用
  assert.equal(availabilityFromBalance({ ok: false, reason: 'http', status: 401 }), 'invalid_key')
  assert.equal(availabilityFromBalance({ ok: false, reason: 'http', status: 429 }), 'rate_limited')
  // 解析失败不是厂商的问题,不影响可用度
  assert.equal(availabilityFromBalance({ ok: false, reason: 'shape', detail: 'x' }), null)
  assert.equal(availabilityFromBalance(null), null)
})

// ── 3. 脱敏断言(安全) ─────────────────────────────────────────

const FAKE_KEY = 'sk-abcdefghijklmnopqrstuvwxyz012345'

test('scrub: 任何路径都不得泄漏 key 值', () => {
  // 已知 key 整段出现
  assert.ok(!scrub(`Authorization: Bearer ${FAKE_KEY}`, FAKE_KEY).includes(FAKE_KEY))
  // 去掉前缀后的主体出现
  assert.ok(!scrub(`token abcdefghijklmnopqrstuvwxyz012345`, FAKE_KEY).includes('abcdefghijklmnopqrstuvwxyz012345'))
  // 厂商掩码过的片段也不留
  assert.ok(!scrub('your api key: ****0000 is invalid', '').includes('0000'))
  // 未知 key(没有 secret 可对照)也要被正则兜住
  assert.ok(!scrub('leaked sk-zzzzzzzzzzzzzzzzzzzzzzzz', '').includes('sk-zzzzzzzzzzzzzzzzzzzzzzzz'))
})

test('scrub: 正常文本不被误伤', () => {
  const msg = '余额查询 HTTP 401 — 令牌已过期'
  assert.equal(scrub(msg, FAKE_KEY), msg)
  assert.equal(scrub('', FAKE_KEY), '')
  assert.equal(scrub(null, FAKE_KEY), '')
})

// ── 4. 探测(用假的 fetchJson,不依赖网络) ─────────────────────

test('probe: 401 → invalid_key;429 → rate_limited;200 → ok', async () => {
  const adapter = {
    defaultBaseUrl: 'https://example.test',
    probe: { path: '/v1/messages', method: 'POST', model: 'm', cost: 'token' }
  }
  const card = { id: 't1' }
  const mk = (status, text = '') => async () => ({ ok: status >= 200 && status < 300, status, text })

  clearProbeCache()
  let r = await probe(card, { key: 'k', baseUrl: 'https://example.test', fetchJson: mk(401, 'invalid api key'), adapter })
  assert.equal(r.availability, 'invalid_key')

  // 换一张卡 id,避开上一条的缓存
  r = await probe({ id: 't2' }, { key: 'k', baseUrl: 'https://example.test', fetchJson: mk(429), adapter })
  assert.equal(r.availability, 'rate_limited')

  r = await probe({ id: 't3' }, { key: 'k', baseUrl: 'https://example.test', fetchJson: mk(200, '{}'), adapter })
  assert.equal(r.availability, 'ok')
})

test('probe: 没有探测规格时返回 attempted=false(不静默当成失败)', async () => {
  const r = await probe({ id: 'x' }, { key: 'k', adapter: { probe: null }, fetchJson: async () => ({}) })
  assert.equal(r.attempted, false)
})

test('probe: 探测结果按 key 哈希缓存,换 key 即失效', async () => {
  const adapter = { defaultBaseUrl: 'https://example.test', probe: { path: '/p', method: 'POST', model: 'm' } }
  let calls = 0
  const fetchJson = async () => {
    calls++
    return { ok: true, status: 200, text: '{}' }
  }
  clearProbeCache()
  const card = { id: 'cache-test' }
  await probe(card, { key: 'key-A', baseUrl: 'https://example.test', fetchJson, adapter })
  await probe(card, { key: 'key-A', baseUrl: 'https://example.test', fetchJson, adapter })
  assert.equal(calls, 1, '相同 key 应命中缓存')

  await probe(card, { key: 'key-B', baseUrl: 'https://example.test', fetchJson, adapter })
  assert.equal(calls, 2, '换 key 必须重新探测')
})

test('probe: 缓存键里不得出现 key 明文', async () => {
  const adapter = { defaultBaseUrl: 'https://example.test', probe: { path: '/p', method: 'POST', model: 'm' } }
  clearProbeCache()
  const { probeCacheKeys, probeCacheSize } = await import('../src/probe.mjs')
  await probe({ id: 'nokey-cache' }, {
    key: FAKE_KEY,
    baseUrl: 'https://example.test',
    fetchJson: async () => ({ ok: true, status: 200, text: '{}' }),
    adapter
  })
  assert.equal(probeCacheSize(), 1)
  const keys = probeCacheKeys().join('|')
  assert.ok(!keys.includes(FAKE_KEY), '缓存键泄漏了完整 key')
  assert.ok(!keys.includes('abcdefghijklmnopqrstuvwxyz'), '缓存键泄漏了 key 主体')
  assert.ok(keys.startsWith('nokey-cache:'), '缓存键应以卡片 id 开头')
})
