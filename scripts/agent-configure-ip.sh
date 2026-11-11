#!/bin/sh
# IP 反代模式：以本机公网 IP 作为入口，Nginx 监听 80 端口明文 HTTP 转发到本地 Agent。
set -eu
umask 077
. "${AEGIS_HOST_SITE_LIB:-$(dirname "$0")/host-site.sh}"
INSTALL_DIR=$AEGIS_AGENT_DIR
[ "$(id -u)" -eq 0 ] || { echo "请使用 sudo 运行" >&2; exit 1; }
[ -f "$INSTALL_DIR/.env" ] || { echo "未找到 Agent 安装" >&2; exit 1; }
# 第三方软件源失效（如 402/GPG 过期）不应中断本脚本：所需软件包通常已安装，
# 真正缺包时下面的 apt-get install 仍会明确报错。
apt-get update || echo "警告：apt 源索引更新失败（常见于机器上某个第三方软件源失效），将沿用现有索引继续。" >&2
DEBIAN_FRONTEND=noninteractive apt-get install -y nginx
PUBLIC_IP=$(curl -4fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
[ -n "$PUBLIC_IP" ] || { echo "无法检测公网 IP" >&2; exit 1; }
SITE=$AEGIS_NGINX_DIR/sites-available/aegis-relay-agent.conf
BACKUP=""
if [ -f "$SITE" ]; then BACKUP="$SITE.backup.$(date +%Y%m%d%H%M%S)"; cp "$SITE" "$BACKUP"; fi
{
  data_plane_upstream aegis_agent_backend aegis_agent_connection_upgrade
  cat <<EOF
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    access_log off;
    client_max_body_size 0;
EOF
  data_plane_location aegis_agent_backend aegis_agent_connection_upgrade
  echo "}"
} > "$SITE"
ln -sfn "$SITE" "$AEGIS_NGINX_DIR/sites-enabled/aegis-relay-agent.conf"
rm -f "$AEGIS_NGINX_DIR/sites-enabled/default"
if ! nginx -t; then
  [ -n "$BACKUP" ] && cp "$BACKUP" "$SITE"
  echo "Nginx 配置校验失败，已回滚。" >&2
  exit 1
fi
systemctl enable --now nginx
systemctl reload nginx
set_env "$INSTALL_DIR/.env" AGENT_DOMAIN ""
set_env "$INSTALL_DIR/.env" AGENT_PROXY_MODE ip
set_env "$INSTALL_DIR/.env" AGENT_PROXY_IP "$PUBLIC_IP"
echo "Agent IP 反代已就绪: http://$PUBLIC_IP/"
