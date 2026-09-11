/**
 * verify-live.mjs — 真机端到端校验
 *
 *   node scripts/verify-live.mjs
 *
 * 单元测试用假数据覆盖了判定逻辑;这个脚本则回答**这台机器上到底行不行**:
 * 真的去发现 provider、真的发探测请求、真的看返回里有没有 key 泄漏。
 *
 * 设计文档 §11 要求"E2E 真实路径验证"—— 这个脚本就是那条路径的入口。
 * 退出码:0 = 全部通过;1 = 有失败项。
 */
import { queryAll } from '../src/registry.mjs'
import { PROBING_ENABLED } from '../src/probe.mjs'
import { loadCredentials } from '../src/env.mjs'
import { getEnvPath } from '../src/env.mjs'

let failed = 0
const ok = (name, detail = '') => console.log(`  \u2713 ${name}${detail ? ' — ' + detail : ''}`)
const bad = (name, detail = '') => {
  failed++
  console.log(`  \u2717 ${name}${detail ? ' — ' + detail : ''}`)
}

console.log('\n== hermes-keywatch 真机校验 ==\n')

// ── 1. 快照可获取 ──────────────────────────────────────────────
let snap
try {
  snap = await queryAll()
  ok('聚合查询完成', `${snap.count} 项 · ${snap.ok_count} 可用`)
} catch (e) {
  bad('聚合查询失败', String(e?.message || e))
  process.exit(1)
}

// ── 2. 结构契约 ────────────────────────────────────────────────
const REQUIRED = ['id', 'label', 'kind', 'availability', 'availability_label', 'availability_tone']
for (const p of snap.providers) {
  const missing = REQUIRED.filter((k) => p[k] === undefined)
  if (missing.length) bad(`卡片 ${p.id} 缺字段`, missing.join(','))
}
if (!snap.providers.some((p) => REQUIRED.every((k) => p[k] !== undefined))) {
  bad('所有卡片都缺少必备字段')
} else {
  ok('卡片结构契约完整', REQUIRED.join('/'))
}

// ── 3. 每张卡都有明确结论(不允许长期"无法判定") ──────────────
const unresolved = snap.providers.filter((p) => p.availability === 'unknown')
if (unresolved.length) {
  bad('有卡片无法判定可用度', unresolved.map((p) => p.label).join(' / '))
} else {
  ok('每张卡都有明确可用度结论')
}

// ── 4. 降级链真的被走过 ────────────────────────────────────────
const srcs = new Set(snap.providers.map((p) => p.availability_source).filter(Boolean))
ok('用到的判定来源', [...srcs].join(' / ') || '(无)')
if (PROBING_ENABLED && !srcs.has('probe') && snap.providers.some((p) => p.kind !== 'endpoint')) {
  console.log('  \u26a0 没有卡片走到探测层(B 层);可能全都由余额接口顺带判定了')
}

// ── 5. 密钥泄漏断言(最重要的安全检查) ────────────────────────
try {
  const envPath = await getEnvPath()
  const creds = loadCredentials(envPath)
  const secrets = Object.values(creds || {}).filter((v) => typeof v === 'string' && v.length >= 8)
  const payload = JSON.stringify(snap)

  let leaked = 0
  for (const s of secrets) {
    if (payload.includes(s)) {
      leaked++
      console.log(`     ! 快照中出现了某个 key 的值(长度 ${s.length})`)
    }
    // 也检查去掉常见前缀后的主体
    const body = String(s).replace(/^[a-zA-Z_-]{2,8}[-_]/, '')
    if (body.length >= 12 && payload.includes(body)) {
      leaked++
      console.log('     ! 快照中出现了某个 key 的主体部分')
    }
  }
  if (leaked) bad('密钥泄漏', `${leaked} 处`)
  else ok('密钥泄漏断言通过', `检查了 ${secrets.length} 个凭证,快照中均未出现`)
} catch (e) {
  bad('密钥检查无法执行', String(e?.message || e))
}

// ── 6. 逐卡打印 ────────────────────────────────────────────────
console.log('\n-- 逐卡结果 --')
for (const p of snap.providers) {
  const bal = p.balance === null || p.balance === undefined ? '—' : `${p.balance} ${p.currency || ''}`
  console.log(
    `  ${String(p.label).padEnd(28)} ${String(p.availability_label).padEnd(10)} ` +
      `来源=${String(p.availability_source || '-').padEnd(9)} 余额=${bal}`
  )
  if (p.error) console.log(`      ! ${p.error}`)
}

console.log(`\n${failed ? `\u2717 失败 ${failed} 项` : '\u2713 全部通过'}\n`)
process.exit(failed ? 1 : 0)
