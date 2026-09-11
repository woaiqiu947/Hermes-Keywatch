# hermes-api-usage

> **⚠️ 实现状态**:本仓库当前代码早于 [`hermes-keywatch-design.md`](./hermes-keywatch-design.md)(方案文档 v1.0),
> 是一份**已验证可运行的纵向切片**,但架构与方案不完全一致(未采用"声明式注册表",且未实现可用度探测降级链)。
> 逐条差异、以及方案 M0 阻塞项的实测解答,见 [`docs/IMPLEMENTATION-STATUS.md`](./docs/IMPLEMENTATION-STATUS.md)。

给 **Hermes Desktop** 用的多厂商 API 余额 / 用量仪表盘。
自动发现这台机器上配置过的所有模型服务,把它们的余额、订阅额度、在线状态汇总进一个侧边栏页面。

> 从 `cc-usage`(只盯 CommandCode)升级而来 —— 现在 DeepSeek、智谱 GLM、Kimi、
> OpenRouter、CommandCode bridge、本地 llama.cpp 端点都进来,而且**换机器不用改代码**。

装好之后,侧边栏会出现「API 用量」,点开是这样一页:

```
┌ API 余额与用量 ────────────────────── ● 更新于 11:17 ── [刷新] ┐
│ 自动发现 5 项服务 · 其中 5 项已配置      总计 5   正常 5         │
│ ⚠ DeepSeek ¥8.63 已低于阈值 ¥10                                │
│ ┌───────────────────┐ ┌───────────────────┐ ┌────────────────┐ │
│ │ DeepSeek    余额   │ │ CommandCode  额度  │ │ 本地端点  离线  │ │
│ │ ¥8.63 CNY         │ │ $61.24 USD        │ │ 服务未启动      │ │
│ │ 账户余额           │ │ 当前余额           │ │ :8080/v1       │ │
│ │ 充值余额  ¥8.63    │ │ 本期已花  $8.69    │ └────────────────┘ │
│ │ 赠送余额  ¥0.00    │ │ 请求次数  1940     │                    │
│ └───────────────────┘ │ 5h窗口 ▓░░░░ 3.8% │                    │
│                       │ 7d窗口 ▓░░░░ 4.0% │                    │
│                       └───────────────────┘                    │
└── 低余额告警阈值: [10] [保存] ────────────────────────────────┘
```

---

## 它解决什么

多机器、多厂商的时候,余额散落在各家控制台里:DeepSeek 扣的是预付余额,GLM 是
Coding Plan 的 5 小时 / 7 天滚动窗口,CommandCode 是 GOAT 订阅额度,本地模型没有
"余额"只有在线与否。想看一圈得开四五个网页。

这个项目把它们收进一个页面,并且**自己发现**该显示哪些 —— 你只要在 Hermes 里配过
provider 或者 `.env` 里有 key,它就会出现。

## 工作原理

```
                 ┌──────────────────────────────────────────┐
                 │  Hermes Desktop  (Electron renderer)      │
                 │                                          │
   侧边栏「API 用量」 → │  plugin.js  ──iframe──▶ dashboard.html  │
                 │       │                        │          │
                 └───────┼────────────────────────┼──────────┘
                         │ 注册路由/入口           │ fetch(环回)
                         ▼                        ▼
       ┌────────────────────────────┐   ┌──────────────────────────┐
       │ Hermes config.yaml + .env  │   │  聚合服务 :9993           │
       │  (探测层读它)               │──▶│  src/server.mjs           │
       └────────────────────────────┘   │   ├─ registry.mjs 匹配     │
                                        │   └─ providers/*.mjs 查询  │
                                        └───────────┬──────────────┘
                                                    │ 并发请求
                          ┌─────────────┬───────────┼───────────┬─────────────┐
                          ▼             ▼           ▼           ▼             ▼
                      DeepSeek       智谱 GLM    Kimi       OpenRouter   本地 bridge
```

三层,各管一件事:

| 层 | 文件 | 职责 |
|---|---|---|
| **探测** | `src/env.mjs` / `src/discover.mjs` | 用 `hermes config get <key> --json` 读 Hermes 配置,加上 `.env` 键名,算出"这台机器有哪些服务" |
| **适配** | `src/providers/*.mjs` | 每个厂商一个文件,知道去哪查、字段怎么解析 |
| **服务** | `src/server.mjs` | 只监听 `127.0.0.1:9993`,并发查询 + 缓存,聚合成一份 JSON |

**探测层零依赖**:不解析 YAML,而是调 `hermes config get --json` 让 Hermes 自己解析。
所以 Hermes 改配置格式,这里不会跟着坏。

## 支持的厂商

| 厂商 | 查询方式 | 数据 |
|---|---|---|
| **DeepSeek** | `GET api.deepseek.com/user/balance` | 预付余额(CNY/USD 双币种,含赠金) |
| **智谱 GLM** | `bigmodel.cn/api/monitor/usage/quota/limit` + 余额端点 | Coding Plan 5h/7d 滚动窗口,或按量余额 |
| **Kimi / Moonshot** | `GET {国内/国际站}/v1/users/me/balance` | 可用余额 / 代金券 / 现金 |
| **OpenRouter** | `GET openrouter.ai/api/v1/key` | Key 限额与已用 |
| **CommandCode** | bridge `:9992/admin/commandcode/credentials` | 订阅额度、滚动窗口、请求数 |
| **本地端点** | `GET /v1/models` + `/metrics` | 在线状态、已加载模型、累计 token |
| **MiniMax** | — | 官方暂无公开余额 API,卡片会标注并给控制台链接 |

### 怎么决定显示哪些

探测层收集三类来源,按优先级匹配适配器:

1. `custom_providers` 里登记的 provider(信息最全)
2. 默认模型 `model.provider` 与 `model_aliases` 里引用的 `custom:<name>`
3. **反向补充**:`.env` 里有已知厂商的 key,但没有 provider 配置

第 3 条是关键 —— 比如你只把 `DEEPSEEK_API_KEY` 写进 `.env`、没在 `config.yaml`
里登记 provider,它照样会被发现并出卡片。匹配同时看 **base_url 域名**和 **key 变量名**。

同时也会反向出卡:发现了 provider 但没配 key → 卡片显示「未配置 API Key」,
并告诉你该往 `.env` 里写哪个变量名,填上就自动点亮。

## 快速开始

需要 **Node.js ≥ 18**。零 npm 依赖,不用 `npm install`。

```bash
git clone https://github.com/woaiqiu947/Hermes-Keywatch.git && cd Hermes-Keywatch

# 1) 看看这台机器发现了什么(不打印任何 key 的值)
node src/discover.mjs

# 2) 前台起服务
node src/server.mjs
#    → [hermes-api-usage] listening on http://127.0.0.1:9993

# 3) 验证
curl -s http://127.0.0.1:9993/health
curl -s http://127.0.0.1:9993/balances | head -c 400

# 4) 装插件进 Hermes 桌面
bash scripts/install.sh
```

装完在 Hermes 侧边栏点「API 用量」,或 `⌘K` → `打开 API 余额与用量`。
仪表盘也可以直接在浏览器里打开:`dashboard/index.html`。

## 常驻运行

插件只负责显示,**查询靠 `src/server.mjs` 这个本地服务**。服务没起时仪表盘会提示。

```bash
# 前台
node src/server.mjs

# 装成常驻 + 自愈(Windows:计划任务每分钟健康检查;macOS:LaunchAgent KeepAlive)
bash scripts/install.sh --service                       # macOS 会直接注册
powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1   # Windows
powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1 -Remove   # 卸载
```

Windows 用计划任务 + `scripts/watchdog.ps1`(每分钟探一次 `/health`,挂了就拉起),
和 `commandcode-bridge` 是同一套模式。

## 换机器 / 多机部署

这个仓库本身就是为多机设计的,新机器上只要两步:

```bash
git clone https://github.com/woaiqiu947/Hermes-Keywatch.git
cd Hermes-Keywatch
bash scripts/install.sh --service
```

**没有需要手改的配置文件** —— 探测层读的是那台机器自己的 Hermes 配置和 `.env`,
装完自动显示它自己的服务清单。`install.sh` 会把仪表盘的真实路径烧进 `plugin.js`
(原因见下节),所以路径不同也不影响。

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `API_USAGE_PORT` | `9993` | 服务端口 |
| `API_USAGE_HOST` | `127.0.0.1` | 监听地址(不建议改) |
| `API_USAGE_CACHE_MS` | `60000` | 结果缓存时长 |
| `HERMES_HOME` | 自动探测 | Hermes 目录 |
| `HERMES_BIN` | 自动探测 | hermes 可执行文件路径 |

## 安全

- 服务**只监听环回地址**,不对外暴露。
- `/balances` 只返回聚合后的余额数字,**永远不回传任何 key**(`key_source` 里只有变量名,
  如 `DEEPSEEK_API_KEY`)。
- `discover.mjs` 同样只报告 key "存在与否"。
- 仪表盘页面**不含任何 key** —— 它只 `fetch` 本机环回地址。
- 仓库里没有 `.env`,`.gitignore` 已排除。

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 卡片全空、提示"聚合服务未响应" | 服务没起:`node src/server.mjs`,或装常驻 |
| 某个厂商显示「未配置 API Key」 | 把该卡片提示的变量名写进 `hermes config env-path` 指向的 `.env` |
| 某厂商 `HTTP 401` | key 无效或站点不对(Kimi 国内站/国际站的 key **不通用**) |
| 智谱返回"令牌已过期" | 该端点对无效 key 也返回 HTTP 200,看 `success` 字段;确认是 GLM Coding Plan 还是按量账户 |
| 侧边栏没有「API 用量」 | 改插件后热加载偶尔不触发,重启一次桌面应用 |
| `Failed to construct 'URL': Invalid URL` | 插件是以 **Blob URL** 被 `import()` 的,`import.meta.url` 不可用 —— 用 `install.sh` 安装(它会注入绝对路径),别手抄 `plugin.js` |
| `schtasks` 报「任务 XML 格式错误 … 无法切换编码」 | 任务 XML **必须**写成 UTF-16LE(带 BOM,声明改成 `UTF-16`)。schtasks 在本机拒收 UTF-8 的任务 XML——拿 `commandcode-bridge` 那份已知可用的 XML 对照,同样报错。`install-service.ps1` 已自动转换,别手写 UTF-8 的 XML |
| PowerShell 脚本报「字符串缺少终止符」 | `.ps1` 里**不要写非 ASCII 字符**:PowerShell 5.1 读无 BOM 的 UTF-8 `.ps1` 会按 GBK 解码,中文会破坏引号解析。本仓库的 `.ps1` 一律纯 ASCII(注释也是) |
| 本地端点显示"离线" | 该端口没在跑 llama.cpp,属正常 |

## 目录结构

```
├── src/
│   ├── env.mjs           # 配置/凭据读取(调 hermes CLI,零依赖)
│   ├── registry.mjs      # 适配器注册表 + 探测 + 并发查询编排
│   ├── server.mjs        # 聚合 HTTP 服务
│   ├── discover.mjs      # 调试:打印发现了什么
│   └── providers/        # 每个厂商一个适配器
├── dashboard/index.html  # 仪表盘页面(iframe 嵌入,不含任何 key)
├── plugin/plugin.js      # Hermes 桌面插件(模板,安装时注入路径)
├── scripts/
│   ├── install.sh              # 插件 + 仪表盘安装(macOS 可加 --service)
│   ├── install-service.ps1     # Windows:注册计划任务(经 schtasks /XML)
│   ├── watchdog-task.xml.template  # 任务定义模板(占位符,安装时替换)
│   ├── run-hidden.vbs          # 无窗口启动器,避免每分钟闪黑窗
│   └── watchdog.ps1            # 每分钟健康检查,挂了就拉起
└── platforms/            # 各机器的安装笔记
```

## 加一个新厂商

1. 在 `src/providers/` 新建 `yourvendor.mjs`,导出一个对象:
   ```js
   export default {
     id: 'yourvendor', label: 'YourVendor', kind: 'balance',
     keyNames: ['YOURVENDOR_API_KEY'],
     defaultBaseUrl: 'https://api.yourvendor.com/v1',
     match: (ep) => /yourvendor\.com/.test(ep.baseUrl || '') || this.keyNames.includes(ep.keyEnv),
     async query({ key, baseUrl, fetchJson }) {
       if (!key) return { ok: false, reason: 'unconfigured' }
       const r = await fetchJson('...', { headers: { Authorization: `Bearer ${key}` } })
       if (!r.ok) return { ok: false, reason: 'http', status: r.status, detail: r.text }
       return { ok: true, currency: 'CNY', balance: 12.34, balanceLabel: '账户余额',
                details: [{ label: '已用', value: '¥1.00' }], bars: [] }
     }
   }
   ```
2. 在 `src/registry.mjs` 的 `ADAPTERS` 数组里登记(数组顺序 = 匹配优先级)。
3. `node src/discover.mjs` 确认被发现。

厂商的 `kind` 决定卡片长相:`balance`(余额数字)/ `quota`(带进度条)/
`endpoint`(在线状态)/ `unsupported`(只给控制台链接)。

## License

MIT
