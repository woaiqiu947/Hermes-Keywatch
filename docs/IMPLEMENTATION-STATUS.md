# 实现现状 vs 设计文档

> 对照对象:[`hermes-keywatch-design.md`](../hermes-keywatch-design.md)(v1.0 草案)
> 对照日期:2026-09-11
> 一句话结论:**目标已跑通,架构与设计文档不一致;B/C 降级链尚未实现。**

---

## 1. 已经跑通的部分(实机验证)

当前 `main` 上是一份**可运行的纵向切片**,不是纸面设计:

| 能力 | 状态 | 证据 |
|---|---|---|
| 自动发现本机已配置的 provider | ✅ | 实测发现 5 项(3 本地端点 + CommandCode + DeepSeek) |
| DeepSeek 余额 | ✅ | `¥8.63`(充值/赠送明细) |
| CommandCode 订阅额度 | ✅ | `$60.80` 余额 + 5h/7d 滚动窗口 + 请求数 |
| 本地端点在线状态 | ✅ | 8080-8082 正确报"离线" |
| 桌面端呈现 | ✅ | 侧边栏「API 用量」+ ⌘K;插件热加载日志实证 |
| 常驻 + 自愈 | ✅ | 计划任务 `HermesApiUsage`,每分钟健康检查,实测拉起成功 |
| 仓库无私钥 | ✅ | 全量扫描(含身份/路径/邮箱/`sk-` 模式)通过 |

## 2. 与设计文档的偏差

### 2.1 违反 ADR-1(架构性偏差)

| | 设计 | 现状 |
|---|---|---|
| 服务商知识载体 | `providers.yaml`(**数据**) | `src/providers/*.mjs`(**代码**) |
| 新增一家服务商 | 加一段 YAML,零代码改动 | 新建 `.mjs` + 在 `registry.mjs` 登记 |

现状正是设计文档 **ADR-1「被否决方案一:每家服务商一个固定脚本」**。这条是核心决策,应当纠正:
把 `src/providers/*.mjs` 的差异抽成 `providers.yaml`(path/auth/extract),执行器只留一份。

> 注:现状里**确实不适合**放进 YAML 的只有两类——(a) 本地端点探测,(b) CommandCode bridge 的
> 非标准聚合响应。前者可用 `probe` 段表达,后者需要一段 `extract`,都能靠 JSONPath 覆盖。

### 2.2 缺失 ADR-3 的三级降级链(价值性偏差)

设计文档的核心论点:**"五个样本中三家有可用余额接口,两家没有 —— 如果只做余额,这个插件对近一半服务商是失效的。"**

现状**只实现了 A 层**(官方余额),并且:

- ❌ 无 B 层最小探测(1 token) → 无余额接口的厂商(Anthropic/OpenAI 类)现在**根本不出现**;
- ❌ 无 C 层本地账本/`baseline` 估算;
- ❌ 无 `availability` 概念(只有一个笼统的 `status: ok/error/unconfigured`)。

这是与设计差距最大的一块,也是设计里论证最充分的一块。

### 2.3 输出契约不一致(§7)

| 设计字段 | 现状 | 差异 |
|---|---|---|
| `availability`(9 值枚举) | 无 | 需新增 |
| `balance.remain` / `currency` / `source` | `balance` / `currency`(无 `source`) | 缺 `source: official\|estimate\|unknown` |
| `balance.detail` | `details[]` | 形状不同 |
| `latency_ms` | 无 | 需新增 |
| `checked_at`(带时区偏移) | `fetched_at`(`...Z` UTC) | 差时区偏移 |
| `cached` | 有(服务层) | ✅ 兼容 |
| 金额为**字符串** | 用 `Number()` + `toFixed()`(**浮点**) | ⚠️ 违反 §10.3 |

### 2.4 其他未落地的章节

| 章节 | 要求 | 现状 |
|---|---|---|
| §8.2 探测判定矩阵 | 401→`invalid_key`、402→`exhausted`、403→`forbidden`、429→`rate_limited`、5xx→`upstream_error`、超时→`unreachable`、**400→插件自身告警** | 未实现,统一为 `error` + HTTP 文本 |
| §8.3 并发/超时/重试 | 并发上限 4;单请求 5s;整体 15s;仅 5xx/超时重试 1 次 | 并发无上限;12s;无整体预算;无重试 |
| §8.4 缓存 | 默认 5min,60s 硬下限;缓存键含 `key_ref` 哈希以随轮换失效 | 默认 60s;无键哈希 |
| §10.5 阈值 | 注册表 `settings.low_balance_threshold`,支持按 provider 覆盖,触发 `availability: low` | 仅仪表盘 localStorage 里的单一前端阈值 |
| §11 测试 | 7 类(含**密钥泄漏断言**、fixture 回归) | **零测试** |
| §12 验收 #1 / #5 | 新增服务商只改 YAML;余额失败不影响可用度 | **均不满足** |

### 2.5 验收标准记分

| # | 标准 | 结果 |
|---|---|---|
| 1 | 新增服务商只改 `providers.yaml`,零代码 | ❌ |
| 2 | 仓库(含 git 历史)不含真实密钥 | ✅ |
| 3 | 断网时全部标 `unreachable` 而非崩溃 | ⚠️ 不崩溃,但标的是 `error` 而非 `unreachable` |
| 4 | 一家异常不影响其余 | ✅ |
| 5 | 余额失败不影响可用度产出 | ❌(无可用度概念) |

---

## 3. 现状对设计文档的**反向贡献**

现状不只是"偏差",它**实测解掉了 M0 的两个外部未知项**,这是设计文档里标注为唯一阻塞项的部分:

### (a) 插件规范 —— 已有答案 ✅

实测确认(Hermes v0.20.6):

- 插件位置:`<HERMES_HOME>/desktop-plugins/<id>/plugin.js`,**文件夹名 == 插件 id**,保存即热加载;
- 入口:`export default { id, name, register(ctx) }`;
- 贡献面(`@hermes/plugin-sdk`):`ROUTES_AREA`(全页路由)、`SIDEBAR_NAV_AREA`(侧边栏入口)、`PALETTE_AREA`(⌘K 命令),另有 `host.navigate` / `host.openWorkspace` / `host.request` 等;
- 约束:**只能 import `@hermes/plugin-sdk` 与 `react*`**;不能用 JSX 语法(需 `jsx()` 工厂)。

### (b) 密钥交付路径 —— `secret:` 不可行,需改设计 ⚠️

这条是**对设计文档的实质性修正**:

- 插件源码被 loader **包成 Blob URL 再 `import()`** 执行(`runtime-loader.ts`),`import.meta.url` 是 `blob:…`;
- 插件运行在**渲染进程沙箱**里,**没有**读文件/环境变量的门 —— SDK 的 `host` 面上不存在 `secrets`/`env` 一类的出口(已通读 `apps/desktop/src/sdk/index.ts`,1589 行)。

**结论**:§6.3 的 `key_ref: secret:NAME`(由 Hermes 把密钥交给插件)**在现有 Hermes 上无法实现**。
可行的替代是:与插件**同机的**一个本地服务读 `hermes config env-path` 指向的 `.env`(即现状做法),
插件只 fetch 环回地址拿**结果**——密钥不流经插件代码,ADR-2 的意图仍然满足。

**建议**:`key_ref` 保留 `env:NAME` 语义,并在设计文档中把 `secret:` 标为"待 Hermes 开放密钥接口后再启用"。

### (c) 额外已验证的接口事实

| 发现 | 说明 |
|---|---|
| `file://` → 厂商 API 的 CORS **可行** | DeepSeek/智谱/Moonshot/OpenRouter 均返回 `Access-Control-Allow-Origin: null`;实测带真 key 拿到 HTTP 200。故纯前端直连也走得通,本地服务不是唯一解 |
| 智谱 quota 端点的**假 200** | `bigmodel.cn/api/monitor/usage/quota/limit` 对无效 key 也返回 **HTTP 200 + `success:false`**,只看状态码会误判为正常 |
| Kimi 国内站/国际站**隔离** | 账户与 key 互不通用,端点必须与 key 归属匹配 |
| `schtasks` 拒收 UTF-8 任务 XML | 必须 UTF-16LE;已用 bridge 的已知可用 XML 复现确认 |
| PowerShell 5.1 读无 BOM 的 UTF-8 `.ps1` 按 GBK 解码 | `.ps1` 内出现非 ASCII(中文注释)会直接解析失败 |

---

## 4. 建议路径

现状不宜当终态,但也不该丢——它把"能不能成"验证完了。建议:

1. **保留现状作为可运行基线**,在 README 顶部标注"实现早于设计文档 v1.0,存在架构偏差,见本文件";
2. **按 ADR-1 重构**:抽出 `providers.yaml` + 单一执行器;`src/providers/*.mjs` 退化为 YAML 条目,
   仅本地端点与 CommandCode bridge 需要 `extract` 表达能力之外的处理(评估是否可用 JSONPath + 特例段覆盖);
3. **补 B 层探测**(价值最高):1-token 探测 + §8.2 判定矩阵 + `availability` 枚举 —— 这一步才让
   "近一半无余额接口的服务商"进入视野,是设计文档的核心论点;
4. **补 C 层 `baseline`**:允许手工登记充值基线,输出 `source: estimate`,**明确不反推为精确值**;
5. 按 §7 对齐输出契约(金额改字符串、加 `latency_ms`/`checked_at` 偏移/`balance.source`);
6. 按 §11 补测试,优先:**判定矩阵**、**密钥泄漏断言**、**fixture 回归**三项;
7. 按 §10.5 把阈值移入注册表 `settings`。

> M0 既然已被实测解答(见 §3),设计文档可将 M0 标记为完成,并把 `secret:` 一项改为开放问题;
> M1 可以立即动工,且**可以复用现状里已经验证过的接口事实与踩坑记录**(§3c)。
