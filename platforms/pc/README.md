# Windows PC 部署笔记

本机环境参考:Windows 11 + Node.js v22。

## 首次部署

```bash
git clone <本仓库> D:/sourceTree/hermes-api-usage
cd /d/sourceTree/hermes-api-usage

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
- Node 必须是 **v18+**(用到全局 `fetch` / `AbortController`)。
- 本地 llama.cpp 端点(8080-8082)没在跑时,卡片显示"离线"是**正常**的,不是 bug。

## 升级

```bash
cd /d/sourceTree/hermes-api-usage
git pull
bash scripts/install.sh          # 重新把 dashboard.html + plugin.js 装进 Hermes
# 服务是每次请求现读代码的,但改了 src/ 后建议重启一次:
powershell -ExecutionPolicy Bypass -File scripts\watchdog.ps1   # 或直接杀掉 node 等它自愈
```
