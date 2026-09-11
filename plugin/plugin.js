/**
 * API 余额与用量 — Hermes 桌面插件
 *
 * 提供:侧边栏固定入口 + /api-usage 页面(内嵌 dashboard.html)+ ⌘K 命令
 *
 * 数据来自本机聚合服务 http://127.0.0.1:9993/balances(见仓库 src/server.mjs),
 * 服务负责自动发现本机配置的所有 provider 并聚合它们的余额/额度。
 * 仪表盘页面本身**不含任何 key** —— 它只读环回地址上的聚合结果。
 *
 * 安装位置:<HERMES_HOME>/desktop-plugins/cc-usage/
 *   文件夹名 == 插件 id。这里**沿用历史的 "cc-usage"**,因为改文件夹名等于换一个
 *   插件 id,需要重启桌面端重新扫描才能生效(否则侧边栏入口会消失)。
 *   项目/仓库名是 hermes-keywatch,插件 id 保留 cc-usage 只是为了避免这个重启。
 */
import { host, PALETTE_AREA, ROUTES_AREA, SIDEBAR_NAV_AREA } from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'

const ID = 'cc-usage' // 必须与文件夹同名
const PATH = '/api-usage'
/**
 * 仪表盘页面的绝对地址 —— 由 scripts/install.sh 在安装时把占位符替换成本机
 * 实际路径(同一目录下的 dashboard.html)。
 *
 * 为什么不用 `new URL('./dashboard.html', import.meta.url)`:
 *   Hermes 的运行时插件 loader 是把源码包成 Blob 再 `import(blobUrl)` 执行的
 *   (见 apps/desktop/src/contrib/runtime-loader.ts),所以 import.meta.url 是
 *   `blob:…` 而不是文件路径,拿它当 base 解析相对路径会抛
 *   `TypeError: Failed to construct 'URL': Invalid URL`。安装时注入最稳。
 */
const DASHBOARD_URL = '__DASHBOARD_URL__'

/** 路由页面:内嵌本地仪表盘 HTML */
function UsagePage() {
  return jsx('div', {
    className: 'flex h-full w-full flex-col bg-transparent',
    children: jsx('iframe', {
      src: DASHBOARD_URL,
      className: 'h-full w-full flex-1 border-none',
      style: { background: 'transparent' },
      sandbox: 'allow-scripts allow-same-origin allow-popups',
      title: 'API 余额与用量'
    })
  })
}

export default {
  id: ID,
  name: 'API 余额与用量',
  register(ctx) {
    // 启动日志:排查"插件到底加载了没"时,在 desktop.log 里搜 [api-usage] 即可
    console.log('[api-usage] 已加载,注册路由 ' + PATH + ' (数据源 127.0.0.1:9993)')

    // 1) 全页路由
    ctx.register({
      id: 'page',
      area: ROUTES_AREA,
      data: { path: PATH },
      render: () => jsx(UsagePage, {})
    })

    // 2) 侧边栏固定导航行
    ctx.register({
      id: 'nav',
      area: SIDEBAR_NAV_AREA,
      data: {
        path: PATH,
        label: 'API 用量',
        codicon: 'dashboard'
      }
    })

    // 3) ⌘K 命令直达
    ctx.register({
      id: 'open',
      area: PALETTE_AREA,
      data: {
        id: 'api-usage.open',
        label: '打开 API 余额与用量'
      },
      run: () => host.navigate(PATH)
    })
  }
}
