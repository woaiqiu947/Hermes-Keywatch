# Windows PC 部署笔记

本机环境参考:Windows 11 + Node.js v22。

## 首次部署

```bash
git clone https://github.com/woaiqiu947/Hermes-Keywatch.git D:/sourceTree/Hermes-Keywatch
cd /d/sourceTree/Hermes-Keywatch

# 1) 先看看这台机器发现了什么
node src/discover.mjs

# 2) 起服务(前台试跑)
node src/server.mjs
#   另一个窗口: curl -s http://127.0.0.1:9993/health

# 3) 装插件
bash scripts/install.sh
```

Hermes 目录会自动定位到 `%LOCALAPPDATA%\hermes`(git-bash 里 `$LOCALAPPDATA` 通常是
`C:\Users\<你>\AppData\Local`;定位不到时脚本会退回 `$HOME/AppData/Local/hermes`)。

## 装常驻服务(计划任务 + 看门狗)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1
```

注册名为 `HermesApiUsage` 的计划任务:

- **登录时**启动一次
- 之后**每分钟**跑一次 `scripts/watchdog.ps1` 做健康检查
- `/health` 不通、且没有 `node ... src/server.mjs` 进程 → 隐藏窗口拉起

查看/卸载:

```powershell
Get-ScheduledTask -TaskName HermesApiUsage | Get-ScheduledTaskInfo
powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1 -Remove
```

日志在仓库根目录的 `watchdog.log`(超过 512KB 自动只留尾部 200 行)。

## 本机已知的坑

- **git-bash 调 PowerShell 引号会被破坏** —— 一律把逻辑写成 `.ps1` 文件再用 `-File`
  执行,不要用 `powershell -Command "...$var..."`。
- **端口 9992 是 commandcode-bridge,9993 才是本项目**,别搞混;`registry.mjs` 明确
  把 9992 交给 bridge 适配器。
- **`.ps1` 一律纯 ASCII** —— PowerShell 5.1 读无 BOM 的 UTF-8 脚本会按 GBK 解码,
  中文注释会破坏引号解析,报"字符串缺少终止符"。
- **schtasks 拒收 UTF-8 任务 XML** —— 必须 UTF-16LE(带 BOM)。`install-service.ps1`
  已自动转换;手写 XML 必踩。
- Node 必须是 **v18+**(用到全局 `fetch` / `AbortController`)。
- 本地 llama.cpp 端点(8080-8082)没在跑时,卡片显示"网络不可达"是**正常**的,不是 bug。

## 验证

```bash
npm test                       # 12 项单元测试(含密钥泄漏断言)
node scripts/verify-live.mjs   # 真机 E2E:真发现、真探测、真搜 key 泄漏
curl -s http://127.0.0.1:9993/balances | head -c 500
```

`verify-live.mjs` 会打印每张卡的 `可用度 + 判定来源`。三种来源都出现才说明降级链完整:

| 来源 | 含义 |
|---|---|
| `endpoint` | 端点自报(本地端点的在线状态) |
| `balance` | 余额调用顺带证明 key 有效(零额外 token) |
| `probe` | 真正发了探测请求(免费端点或 1-token) |

## 升级

```bash
cd /d/sourceTree/Hermes-Keywatch
git pull
bash scripts/install.sh          # 重新把 dashboard.html + plugin.js 装进 Hermes

# 改了 src/ 之后**必须重启服务** —— Node 的 ESM 模块只求值一次,
# 不像某些脚本语言每次请求重读文件。
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\watchdog.ps1
# 或者杀掉进程,等计划任务在 1 分钟内自愈:
#   Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
#     Where-Object { $_.CommandLine -match 'server\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```
