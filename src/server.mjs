/**
 * server.mjs — 余额聚合服务
 *
 * 只监听环回地址(127.0.0.1),只暴露聚合后的**结果**,绝不回传任何 key。
 * 仪表盘(file:// 页面)通过 GET /balances 取数。
 *
 *   PORT=9993 node src/server.mjs
 */
import { createServer } from 'node:http'
import { queryAll } from './registry.mjs'

const PORT = Number(process.env.API_USAGE_PORT || 9993)
const HOST = process.env.API_USAGE_HOST || '127.0.0.1'
const CACHE_MS = Number(process.env.API_USAGE_CACHE_MS || 60000)

let cache = { at: 0, payload: null, inflight: null }

/** 带缓存 + 并发合流(多个请求同时来时只查一次)。 */
async function snapshot({ force = false } = {}) {
  const now = Date.now()
  if (!force && cache.payload && now - cache.at < CACHE_MS) {
    return { ...cache.payload, cached: true, cache_age_ms: now - cache.at }
  }
  if (cache.inflight) return cache.inflight
  cache.inflight = queryAll()
    .then((payload) => {
      cache = { at: Date.now(), payload, inflight: null }
      return { ...payload, cached: false, cache_age_ms: 0 }
    })
    .catch((err) => {
      cache.inflight = null
      throw err
    })
  return cache.inflight
}

function send(res, status, body, extraHeaders = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    ...extraHeaders
  })
  res.end(data)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`)
  if (req.method === 'OPTIONS') return send(res, 204, '')

  try {
    if (url.pathname === '/balances' || url.pathname === '/api/usage') {
      const force = url.searchParams.get('refresh') === '1'
      const payload = await snapshot({ force })
      return send(res, 200, payload)
    }
    if (url.pathname === '/health') {
      return send(res, 200, { ok: true, service: 'hermes-api-usage', port: PORT, uptime_s: Math.round(process.uptime()) })
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return send(
        res,
        200,
        [
          'hermes-api-usage — 多厂商 API 余额/用量聚合服务',
          '',
          `  GET /balances          聚合快照(默认缓存 ${CACHE_MS / 1000}s)`,
          '  GET /balances?refresh=1  强制刷新',
          '  GET /health            存活检查',
          '',
          '仪表盘: dashboard/index.html'
        ].join('\n')
      )
    }
    return send(res, 404, { error: 'not found', path: url.pathname })
  } catch (e) {
    return send(res, 500, { error: String(e?.message || e) })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`[hermes-api-usage] listening on http://${HOST}:${PORT}  (cache ${CACHE_MS / 1000}s)`)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0))
  })
}
