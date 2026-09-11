# hermes-keywatch

给 **Hermes Desktop** 用的多厂商 API 余额 / 用量 / **可用性**仪表盘。

自动发现这台机器上配置过的所有模型服务,把"还剩多少钱"和"现在还能不能用"汇总进一个侧边栏页面。

> 从 `cc-usage`(只盯 CommandCode)升级而来。现在 DeepSeek、智谱 GLM、Kimi、OpenRouter、
> Anthropic、OpenAI、MiniMax、CommandCode bridge、本地 llama.cpp 端点都进来,
> 而且**换机器不用改代码**。

> **命名说明**:项目/仓库叫 `hermes-keywatch`;但装在
> `<HERMES_HOME>/desktop-plugins/cc-usage/` 下的插件 **id 仍保留 `cc-usage`**。
> 因为文件夹名就是插件 id,改名需要重启桌面端重新扫描(否则侧边栏入口会消失)——
> 为了不打扰你,插件 id 沿用了历史值。显示名是「API 余额与用量」。

```
┌ API 余额与用量 ───────────────────────── ● 更新于 11:58 ── [刷新] ┐
│ 自动发现 5 项服务 · 其中 5 项已配置 · 2 项可用   总计 5  可用 2    │
│ ┌────────────────────┐ ┌────────────────────┐ ┌────────────────┐│
│ │ CommandCode   [可用]│ │ DeepSeek     [可用] │ │ 本地端点  [离线]││
│ │ $60.44 USD         │ │ ¥8.61 CNY          │ │ 服务未启动      ││
│ │ 当前余额            │ │ 账户余额            │ │ :8080/v1       ││
│ │ 套餐 individual-goat│ │ 充值余额  ¥8.61     │ └────────────────┘│
│ │ 5 小时窗口 ▓░ 9.5%  │ │ 赠送余额  ¥0.00     │                   │
│ │ 7 天窗口   ▓░ 6.3%  │ │                     │                   │
│ │ 探测:HTTP 200(免费) │ │                     │                   │
│ └────────────────────┘ └────────────────────┘                   │
│ 可接入(本机尚未配置)                                             │
│   智谱 GLM  ZAI_API_KEY  [可查余额]                               │
│   Anthropic ANTHROPIC_API_KEY [仅可用性]                          │
└──────────────────────────────────────────────────────────────────┘
```

---

## 它解决什么

**两个问题,不是一个问题。**

**问题一:余额散落在各家控制台。** DeepSeek 扣预付余额,GLM 是 Coding Plan 的 5 小时 /
7 天滚动窗口,CommandCode 是 GOAT 订阅额度,本地模型没有"余额"只有在线与否。
想看一圈得开四五个网页。

**问题二(更关键):很多厂商根本没有余额查询接口。**
Anthropic、OpenAI、MiniMax 都查不到余额。如果只做余额,这个插件对近一半厂商是**失效的**——
但那半个问题其实有答案:**这个 key 现在还能不能调通,所有厂商都能探。**

所以数据模型分成两条,互不依赖:

| | 回答什么 | 覆盖范围 | 精度 |
|---|---|---|---|
| `balance` | 还剩多少钱 | 只有提供接口的厂商 | 精确 |
| `availability` | 现在能不能用 | **全部厂商** | 定性,但足够做决策 |

### 可用度是九种状态,不是"成功/失败"

关键区分:**429 被限流 ≠ 402 余额耗尽**。前者等一会儿就好,后者要去充值 ——
混成一个"失败"就不知道该怎么办。

| 可用度 | 含义 | 该怎么办 |
|---|---|---|
| `ok` | 一切正常 | — |
| `low` | 余额低于设定阈值,但仍可调用 | 该充值了 |
| `exhausted` | 余额耗尽 | 充值,调用会失败 |
| `invalid_key` | key 被删/过期/抄错 | 换 key |
| `forbidden` | 权限不足或地区限制 | 查账户权限 |
| `rate_limited` | 被限流 | **等一会儿,不是没钱** |
| `upstream_error` | 厂商侧故障(5xx) | 稍后重试 |
| `unreachable` | 超时 / DNS 失败 | 查网络 |
| `config_error` | **本插件自己的探测参数写错了** | 调模型名(不是厂商的问题) |

最后一条是刻意留的:如果 400/404 也混进"厂商不可用",一个探测参数的笔误就会伪装成厂商故障。

## 工作原理

```
                 ┌──────────────────────────────────────────┐
                 │  Hermes Desktop  (Electron renderer)      │
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
                                                    │ 并发(≤4)
                          ┌─────────────┬───────────┼───────────┬─────────────┐
                          ▼             ▼           ▼           ▼             ▼
                      DeepSeek       智谱 GLM    Kimi       OpenRouter   本地 bridge
```

| 层 | 文件 | 职责 |
|---|---|---|
| **探测** | `src/env.mjs` / `src/discover.mjs` | 用 `hermes config get <key> --json` 读 Hermes 配置,加上 `.env` 键名,算出"这台机器有哪些服务" |
| **适配** | `src/providers/*.mjs` | 每个厂商一个文件,知道去哪查、字段怎么解析、怎么探 |
| **服务** | `src/server.mjs` | 只监听 `127.0.0.1:9993`,并发查询 + 缓存,聚合成一份 JSON |

**探测层零依赖**:不解析 YAML,而是调 `hermes config get --json` 让 Hermes 自己解析。
所以 Hermes 改配置格式,这里不会跟着坏。

## 可用度是怎么算出来的(降级链)

按代价从低到高走,**能用免费的就不用付费的**:

```
0) 没配 key              → unconfigured(直接结论,不发请求)
1) 端点自报                → 本地端点用在线状态
2) 余额调用顺带判定         → 余额接口需要鉴权,那次 200 已证明 key 有效 ⇒ 零额外 token
3) 真正的探测              → 前两步给不出结论时才发请求:
     ① cost:'free'  免费且带鉴权的端点(如 bridge 的 GET /v1/models)
     ② cost:'token' 最小 1-token 对话请求(Anthropic / OpenAI / MiniMax)
```

第 2 步是比"无脑发探测请求"更省的做法:DeepSeek 这类有余额接口的厂商,
余额查询本身就把"key 有效 + 账户未欠费"一起证明了,不必再花 token。

**但不是所有余额来源都能证明 key 有效** —— 比如本机 bridge 的 admin 端点无需鉴权,
它返回 200 只说明"bridge 活着"。这类适配器声明 `balanceProvesKey: false`,
强制下沉到第 3 步。

探测结果按 `卡片id + sha256(key)前12位` 缓存 5 分钟,轮换 key 会自动失效。
网络抖动导致的 `unreachable` **不缓存**,免得把瞬时故障固化 5 分钟。

## 支持的厂商

| 厂商 | 余额查询 | 可用性探测 |
|---|---|---|
| **DeepSeek** | ✅ `GET api.deepseek.com/user/balance`(CNY/USD 双币种,含赠金) | 余额调用顺带(零成本) |
| **智谱 GLM** | ✅ Coding Plan 5h/7d 滚动窗口 + 按量余额 | 余额调用顺带 |
| **Kimi / Moonshot** | ✅ 可用余额 / 代金券 / 现金(国内站、国际站 key **不通用**) | 余额调用顺带 |
| **OpenRouter** | ✅ `GET openrouter.ai/api/v1/key`(限额与已用) | 余额调用顺带 |
| **CommandCode** | ✅ bridge `:9992/admin/commandcode/credentials`(订阅额度、滚动窗口、请求数) | **免费探测** `GET /v1/models` |
| **本地端点** | — 没有"余额"这回事 | 在线状态 + 已加载模型 |
| **Anthropic** | ❌ 无公开余额接口(组织成本 API 需 Admin Key) | 1-token 探测 `POST /v1/messages` |
| **OpenAI** | ❌ billing 类接口不接受标准 API Key | 1-token 探测 |
| **MiniMax** | ❌ 官方暂无公开端点(不编造) | 1-token 探测 |

> ⚠️ Anthropic / OpenAI / MiniMax 的**探测端点与模型名未在本机实测**(开发机上没有这三家的 key)。
> 若失效会显示 `config_error` 而不是误导性的"厂商故障"。模型名可用环境变量覆盖,见下节。

### 怎么决定显示哪些

探测层收集三类来源,按优先级匹配适配器:

1. `custom_providers` 里登记的 provider(信息最全)
2. 默认模型 `model.provider` 与 `model_aliases` 里引用的 `custom:<name>`
3. **反向补充**:`.env` 里有已知厂商的 key,但没有 provider 配置

第 3 条是关键 —— 比如你只把 `DEEPSEEK_API_KEY` 写进 `.env`、没在 `config.yaml`
里登记 provider,它照样会被发现并出卡片。匹配同时看 **base_url 域名**和 **key 变量名**。

页面底部还会列一份**「可接入(本机尚未配置)」**,标出每家能看到什么(可查余额 / 仅可用性)
和对应的环境变量名 —— 免得"没配 key"变成"不知道支持它"。

## 快速开始

需要 **Node.js ≥ 18**。零 npm 依赖,不用 `npm install`。

```bash
git clone https://github.com/woaiqiu947/Hermes-Keywatch.git && cd Hermes-Keywatch

# 1) 看看这台机器发现了什么(不打印任何 key 的值)
node src/discover.mjs

# 2) 前台起服务
node src/server.mjs
#    → [hermes-keywatch] listening on http://127.0.0.1:9993

# 3) 验证
curl -s http://127.0.0.1:9993/health
node scripts/verify-live.mjs      # 真机端到端自检(含密钥泄漏断言)
npm test                          # 12 项单元测试

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
bash scripts/install.sh --service                                       # macOS 会直接注册
powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1     # Windows
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
| `API_USAGE_CONCURRENCY` | `4` | 并发查询上限 |
| `API_USAGE_LOW_THRESHOLD` | 未设 | 低余额阈值,如 `10` 或 `CNY:10`(带币种更安全) |
| `API_USAGE_PROBE` | 开 | 设 `0` 完全关闭可用性探测(网络受限或想零调用时) |
| `API_USAGE_PROBE_TTL_MS` | `300000` | 探测结果缓存时长 |
| `API_USAGE_PROBE_TIMEOUT_MS` | `8000` | 单次探测超时 |
| `API_USAGE_PROBE_MODEL` | — | **全局**覆盖探测用模型名 |
| `API_USAGE_ANTHROPIC_MODEL` | `claude-haiku-4-5` | 厂商专属覆盖 |
| `API_USAGE_OPENAI_MODEL` | `gpt-4o-mini` | 厂商专属覆盖 |
| `API_USAGE_MINIMAX_MODEL` | `abab6.5s-chat` | 厂商专属覆盖 |
| `HERMES_HOME` / `HERMES_BIN` | 自动探测 | Hermes 目录与可执行文件 |

低余额阈值由**服务端**判定(不是前端),因为"余额低"是数据结论而非展示偏好;
也便于将来做后台告警。

## 安全

- 服务**只监听环回地址**(`127.0.0.1:9993`),不对外暴露。
- `/balances` 只返回聚合后的余额数字,**永远不回传任何 key**(`key_source` 里只有变量名,
  如 `DEEPSEEK_API_KEY`)。
- **脱敏兜底**(`src/probe.mjs` 的 `scrub()`):厂商的错误响应常常**回显 key 片段**
  (如 DeepSeek 对无效 key 返回 `Your api key: ****0000 is invalid`)。我们不把这件事
  押在厂商的掩码实现上 —— 凡是要进入输出的字符串,一律先抹掉已知 key 值、
  形如 `sk-…` 的 key 词法、以及厂商自带的 `****xxxx` 掩码。**连末四位也不留。**
- 探测缓存只存 `sha256(key)` 的前 12 位作为缓存键,`src/probe.mjs` 里**从不存 key 本身**。
- 测试里有**密钥泄漏断言**:`tests/unit.test.mjs` 断言脱敏函数与缓存键;
  `scripts/verify-live.mjs` 拿本机真实凭证去搜整个快照,确认一个都没漏。
- 仪表盘页面**不含任何 key** —— 它只 `fetch` 本机环回地址。
- 仓库里没有 `.env`,`.gitignore` 已排除。

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 卡片全空、提示"聚合服务未响应" | 服务没起:`node src/server.mjs`,或装常驻 |
| 某卡显示「网络不可达」但网络正常 | 本地端点(`:8080-8082`)没在跑 llama.cpp,属正常 |
| 某厂商显示「未配置 API Key」 | 把该卡片提示的变量名写进 `hermes config env-path` 指向的 `.env` |
| 某厂商「Key 失效」 | key 无效或站点不对(Kimi 国内站/国际站的 key **不通用**) |
| 某厂商「探测配置错误」 | **不是厂商的问题** —— 探测的端点/模型名不对。用 `API_USAGE_<厂商>_MODEL` 指定正确模型名 |
| 智谱返回"令牌已过期" | 该端点对无效 key 也返回 HTTP 200,要看 `success` 字段;并确认是 GLM Coding Plan 还是按量账户 |
| 想临时不发探测请求 | `API_USAGE_PROBE=0`(余额查询照常,只是没有可用度兜底) |
| 侧边栏没有「API 用量」 | 改插件后热加载偶尔不触发,重启一次桌面应用 |
| `Failed to construct 'URL': Invalid URL` | 插件是以 **Blob URL** 被 `import()` 的,`import.meta.url` 不可用 —— 用 `install.sh` 安装(它会注入绝对路径),别手抄 `plugin.js` |
| `schtasks` 报「任务 XML 格式错误 … 无法切换编码」 | 任务 XML **必须**写成 UTF-16LE(带 BOM,声明改成 `UTF-16`)。schtasks 在本机拒收 UTF-8 的任务 XML —— 拿 `commandcode-bridge` 那份已知可用的 XML 对照,同样报错。`install-service.ps1` 已自动转换,别手写 UTF-8 的 XML |
| PowerShell 脚本报「字符串缺少终止符」 | `.ps1` 里**不要写非 ASCII 字符**:PowerShell 5.1 读无 BOM 的 UTF-8 `.ps1` 会按 GBK 解码,中文会破坏引号解析。本仓库的 `.ps1` 一律纯 ASCII(注释也是) |

## 目录结构

```
├── src/
│   ├── env.mjs           # 配置/凭据读取(调 hermes CLI,零依赖)
│   ├── availability.mjs  # 可用度枚举 + 状态码/响应体判定 + 阈值降级
│   ├── probe.mjs         # 可用性探测(免费/付费分级、缓存、脱敏)
│   ├── registry.mjs      # 适配器注册表 + 探测 + 并发查询编排
│   ├── server.mjs        # 聚合 HTTP 服务(:9993)
│   ├── discover.mjs      # 调试:打印发现了什么
│   └── providers/        # 每个厂商一个适配器
├── dashboard/index.html  # 仪表盘页面(iframe 嵌入,不含任何 key)
├── plugin/plugin.js      # Hermes 桌面插件(模板,安装时注入路径)
├── tests/unit.test.mjs   # 单元测试(含密钥泄漏断言)
├── scripts/
│   ├── install.sh                  # 插件 + 仪表盘安装(macOS 可加 --service)
│   ├── verify-live.mjs             # 真机端到端自检
│   ├── install-service.ps1         # Windows:注册计划任务(经 schtasks /XML)
│   ├── watchdog-task.xml.template  # 任务定义模板(占位符,安装时替换)
│   ├── run-hidden.vbs              # 无窗口启动器,避免每分钟闪黑窗
│   └── watchdog.ps1                # 每分钟健康检查,挂了就拉起
└── platforms/            # 各机器的安装笔记
```

## 加一个新厂商

1. 在 `src/providers/` 新建 `yourvendor.mjs`:

   ```js
   export default {
     id: 'yourvendor', label: 'YourVendor', kind: 'balance',
     keyNames: ['YOURVENDOR_API_KEY'],
     defaultBaseUrl: 'https://api.yourvendor.com/v1',

     match(ep) {
       if (/yourvendor\.com/.test(ep.baseUrl || '')) return true
       return this.keyNames.includes(ep.keyEnv)
     },

     // 有余额接口就写 query();余额调用需要鉴权 ⇒ 顺带就证明了 key 有效
     async query({ key, baseUrl, fetchJson }) {
       if (!key) return { ok: false, reason: 'unconfigured' }
       const r = await fetchJson(`${baseUrl}/balance`, { headers: { Authorization: `Bearer ${key}` } })
       if (!r.ok) return { ok: false, reason: 'http', status: r.status, detail: r.text }
       return { ok: true, currency: 'CNY', balance: 12.34, balanceLabel: '账户余额', details: [], bars: [] }
     }
   }
   ```

2. **没有余额接口的厂商**就别写 `query()` 的解析,改成纯探测型:

   ```js
   export default {
     id: 'probeonly', label: 'ProbeOnly', kind: 'probe-only',
     keyNames: ['PROBEONLY_API_KEY'],
     defaultBaseUrl: 'https://api.probeonly.com/v1',
     balanceProvesKey: false,          // query() 是桩函数,不代表 key 有效
     match(ep) { /* ... */ },
     probe: {
       path: '/chat/completions',       // 最小 1-token 请求
       body: { model: 'small-model', max_tokens: 1, messages: [{ role: 'user', content: '.' }] },
       modelEnv: 'API_USAGE_PROBEONLY_MODEL',
       verified: false                  // 未实测就标上,卡片会显示提示
     },
     async query() { return { ok: true, balance: null, unsupported: true, details: [{ label: '说明', value: '无余额接口' }] } }
   }
   ```

3. 在 `src/registry.mjs` 的 `ADAPTERS` 数组里登记(数组顺序 = 匹配优先级)。
4. `node src/discover.mjs` 确认被发现;`npm test` 保证没弄坏别的。

厂商的 `kind` 决定卡片长相:`balance`(余额数字)/ `quota`(带进度条)/
`probe-only`(只报可用度)/ `endpoint`(在线状态)。

## 设计文档

[`hermes-keywatch-design.md`](./hermes-keywatch-design.md) 是一份更完整的目标方案
(声明式注册表、A/B/C 三级降级、schema 校验等)。当前实现与本方案的差异、
以及方案中"M0 阻塞项"的实测结论,见
[`docs/IMPLEMENTATION-STATUS.md`](./docs/IMPLEMENTATION-STATUS.md)。

## License

MIT
