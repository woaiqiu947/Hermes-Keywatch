#!/usr/bin/env bash
# install.sh — 把插件 + 仪表盘装到 Hermes 桌面,并可选地把聚合服务做成常驻。
#
#   bash scripts/install.sh          # 安装插件(复制 plugin.js + dashboard.html)
#   bash scripts/install.sh --service # 额外注册 Windows 计划任务 / macOS LaunchAgent
#
# 幂等:可反复执行,只覆盖插件文件,不动你的 .env / config.yaml。
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_ID="cc-usage"   # 沿用历史文件夹名,桌面端无需重启重扫
WITH_SERVICE=0
[ "${1:-}" = "--service" ] && WITH_SERVICE=1

# ── 定位 HERMES_HOME ────────────────────────────────────────────────
if [ -n "${HERMES_HOME:-}" ] && [ -d "$HERMES_HOME" ]; then
  HH="$HERMES_HOME"
elif [ -d "$LOCALAPPDATA/hermes" ]; then
  HH="$LOCALAPPDATA/hermes"                       # Windows
elif [ -d "$HOME/AppData/Local/hermes" ]; then
  HH="$HOME/AppData/Local/hermes"                 # Windows (git-bash, LOCALAPPDATA 未导出时)
elif [ -d "$HOME/.hermes" ]; then
  HH="$HOME/.hermes"                              # macOS / Linux
elif [ -d "$HOME/.config/hermes" ]; then
  HH="$HOME/.config/hermes"
else
  echo "✗ 找不到 Hermes 目录。请显式指定: HERMES_HOME=/path/to/hermes bash scripts/install.sh" >&2
  exit 1
fi

PLUGIN_DIR="$HH/desktop-plugins/$PLUGIN_ID"
echo "Hermes 目录 : $HH"
echo "插件目标目录 : $PLUGIN_DIR"

# ── 安装插件 ────────────────────────────────────────────────────────
mkdir -p "$PLUGIN_DIR"
cp "$REPO_DIR/dashboard/index.html"  "$PLUGIN_DIR/dashboard.html"

# 仪表盘地址要烧进 plugin.js:运行时插件是以 Blob URL 被 import 的,
# import.meta.url 不可用,只能靠安装时注入绝对路径(见 plugin/plugin.js 注释)。
if command -v cygpath >/dev/null 2>&1; then
  PLUGIN_DIR_NATIVE="$(cygpath -m "$PLUGIN_DIR")"     # → C:/Users/... (正斜杠)
else
  PLUGIN_DIR_NATIVE="$PLUGIN_DIR"
fi
DASH_URL="file:///${PLUGIN_DIR_NATIVE#/}/dashboard.html"

# 用 bash 参数替换(而不是 sed),避免路径里的 & | 等字符被当成元字符
PLUGIN_SRC="$(cat "$REPO_DIR/plugin/plugin.js")"
printf '%s' "${PLUGIN_SRC//__DASHBOARD_URL__/$DASH_URL}" > "$PLUGIN_DIR/plugin.js"

if grep -q '__DASHBOARD_URL__' "$PLUGIN_DIR/plugin.js"; then
  echo "✗ 占位符替换失败,plugin.js 里仍是 __DASHBOARD_URL__" >&2
  exit 1
fi
echo "✓ 已安装 plugin.js(仪表盘 → $DASH_URL) + dashboard.html"
echo "  桌面端保存即热加载;若侧边栏没出现「API 用量」,重启一次桌面应用即可。"

# ── 常驻服务 ────────────────────────────────────────────────────────
if [ "$WITH_SERVICE" = "1" ]; then
  NODE_BIN="$(command -v node || true)"
  [ -z "$NODE_BIN" ] && { echo "✗ 找不到 node,无法注册常驻服务" >&2; exit 1; }

  if [ "$(uname -s)" = "Darwin" ]; then
    PLIST="$HOME/Library/LaunchAgents/com.hermes.api-usage.plist"
    mkdir -p "$(dirname "$PLIST")"
    cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.hermes.api-usage</string>
  <key>ProgramArguments</key>
  <array><string>$NODE_BIN</string><string>$REPO_DIR/src/server.mjs</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$REPO_DIR/service.log</string>
  <key>StandardErrorPath</key><string>$REPO_DIR/service.err.log</string>
</dict></plist>
PLISTEOF
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    echo "✓ 已注册 macOS LaunchAgent: $PLIST"
  else
    echo "→ Windows:请以管理员身份运行 PowerShell 注册计划任务:"
    echo "    powershell -ExecutionPolicy Bypass -File \"$REPO_DIR/scripts/install-service.ps1\""
  fi
fi

echo ""
echo "下一步:"
echo "  1) 前台试跑   : node \"$REPO_DIR/src/server.mjs\""
echo "  2) 自检       : curl -s http://127.0.0.1:9993/health"
echo "  3) 看发现结果 : node \"$REPO_DIR/src/discover.mjs\""
echo "  4) 桌面打开   : 侧边栏「API 用量」或 ⌘K → 打开 API 余额与用量"
