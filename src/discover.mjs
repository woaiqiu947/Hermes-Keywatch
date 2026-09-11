/**
 * discover.mjs — 调试用 CLI:打印本机被发现的 provider 与配置状态。
 * 只输出 key **是否存在**,绝不打印 key 的值。
 *
 *   node src/discover.mjs
 */
import { getEnvPath, loadCredentials } from './env.mjs'
import { discoverProviders } from './registry.mjs'

const envPath = await getEnvPath()
const creds = loadCredentials(envPath)
const cards = await discoverProviders()

console.log('HERMES_HOME env 文件: ' + envPath)
console.log('发现的 .env 键名: ' + Object.keys(creds).filter((k) => /API_KEY|_KEY$|TOKEN/.test(k)).join(', '))
console.log('')
console.log('发现 ' + cards.length + ' 张卡片:')
console.log('')
for (const c of cards) {
  const flag = c.configured ? '✅ 已配置' : c.needsKey ? '⚪ 未配置' : '➖ 免鉴权'
  console.log(`  ${flag}  ${c.id.padEnd(28)} ${c.label}`)
  console.log(`     类型=${c.kind}  来源=${c.endpoint.source}  key=${c.keySource || '—'}`)
  if (c.endpoint.baseUrl) console.log(`     base_url=${c.endpoint.baseUrl}`)
}
