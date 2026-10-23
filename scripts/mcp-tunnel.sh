#!/bin/zsh
# 一键把欧享家 MCP 暴露到公网（Cloudflare 免费隧道），供手机端 AI（千问等）云端接入。
# 用法：./scripts/mcp-tunnel.sh
# 停止：Ctrl-C（自动清理本地服务与隧道）
set -e

PORT=5170
# 鉴权口令：已固定（暴露公网必需）。想换就改这里或用环境变量 MCP_KEY 覆盖
KEY="${MCP_KEY:-opple-25f372c8}"

command -v cloudflared >/dev/null || { echo "缺少 cloudflared：brew install cloudflared"; exit 1; }

# 1) 本地 MCP 服务（复用 web 托管进程，内嵌 /mcp）
if lsof -ti tcp:$PORT >/dev/null 2>&1; then
  echo "端口 $PORT 已有服务在跑，直接复用（若它没带 MCP_KEY 鉴权，先停掉再跑本脚本）"
else
  MCP_KEY="$KEY" PORT=$PORT nohup node "$PWD/src/opple/server.js" > /tmp/opple-web.log 2>&1 &
  echo "本地服务已启动 :$PORT（/mcp 带鉴权）"
  sleep 1
fi

# 2) Cloudflare 快速隧道（免费免注册，出站连接无需路由器配置）
echo "正在建立隧道…"
TMPLOG=$(mktemp)
trap 'kill $CF_PID 2>/dev/null; rm -f "$TMPLOG"' EXIT
cloudflared tunnel --url http://localhost:$PORT > "$TMPLOG" 2>&1 &
CF_PID=$!

PUBLIC_URL=""
for i in {1..30}; do
  PUBLIC_URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$TMPLOG" | head -1)
  [ -n "$PUBLIC_URL" ] && break
  sleep 1
done
[ -z "$PUBLIC_URL" ] && { echo "隧道建立失败："; cat "$TMPLOG"; exit 1; }

echo
echo "=============================================================="
echo " 公网 MCP 端点（手机 AI 用这个）:"
echo "   $PUBLIC_URL/mcp?key=$KEY"
echo
echo " 千问 App MCP 配置:"
echo "   名称: opple"
echo "   类型: 远程 / Streamable HTTP"
echo "   URL : $PUBLIC_URL/mcp?key=$KEY"
echo
echo " 本地调试端点（同 Wi-Fi）: http://192.168.0.139:$PORT/mcp"
echo " 停止: Ctrl-C（会关闭隧道，本地服务保留）"
echo "=============================================================="
echo
echo "隧道运行中，保持本窗口开着…"
wait $CF_PID
