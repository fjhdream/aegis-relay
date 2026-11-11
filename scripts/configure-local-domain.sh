#!/bin/sh
set -eu
umask 077
AEGIS_HERE=$(dirname "$0")
if [ -f "$AEGIS_HERE/src/host-site.sh" ]; then . "$AEGIS_HERE/src/host-site.sh"; else . "$AEGIS_HERE/../src/host-site.sh"; fi
INSTALL_DIR=$AEGIS_PANEL_DIR
PROXY_DOMAIN=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
EMAIL=$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')
[ "$(id -u)" -eq 0 ] || { echo "请使用 sudo 运行" >&2; exit 1; }
value_matches "$PROXY_DOMAIN" '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$' || { echo "代理域名格式无效" >&2; exit 1; }
email_ok "$EMAIL" || { echo "证书邮箱格式无效" >&2; exit 1; }
[ -f "$INSTALL_DIR/.env" ] || { echo "未找到 AegisRelay 安装" >&2; exit 1; }
PUBLIC_BASE_URL=$(sed -n 's/^PUBLIC_BASE_URL=//p' "$INSTALL_DIR/.env" | head -n1)
PANEL_DOMAIN=$(printf '%s' "$PUBLIC_BASE_URL" | sed -n 's#^https://\([^/:]*\)/\{0,1\}$#\1#p' | tr '[:upper:]' '[:lower:]')
ADMIN_PATH=$(sed -n 's/^ADMIN_PATH=//p' "$INSTALL_DIR/.env" | head -n1 | sed 's#^/##;s#/$##')
[ -n "$PANEL_DOMAIN" ] || { echo "请先执行 aegis-relay domain 配置 HTTPS 面板域名" >&2; exit 1; }
value_matches "$PANEL_DOMAIN" '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$' || { echo "PUBLIC_BASE_URL 中的面板域名无效" >&2; exit 1; }
[ -n "$ADMIN_PATH" ] || { echo "ADMIN_PATH 缺失" >&2; exit 1; }
[ "$PANEL_DOMAIN" != "$PROXY_DOMAIN" ] || { echo "面板域名与代理域名必须不同" >&2; exit 1; }
# 第三方软件源失效（如 402/GPG 过期）不应中断本脚本：所需软件包通常已安装，
# 真正缺包时下面的 apt-get install 仍会明确报错。
apt-get update || echo "警告：apt 源索引更新失败（常见于机器上某个第三方软件源失效），将沿用现有索引继续。" >&2
DEBIAN_FRONTEND=noninteractive apt-get install -y nginx certbot python3-certbot-nginx
PUBLIC_IP=$(curl -4fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
DNS_IP=$(getent ahostsv4 "$PROXY_DOMAIN" | awk 'NR==1{print $1}')
if [ -n "$PUBLIC_IP" ] && [ -n "$DNS_IP" ] && [ "$PUBLIC_IP" != "$DNS_IP" ]; then
  echo "提示：$PROXY_DOMAIN 可能启用了 CDN/Cloudflare 代理；将继续使用 HTTP-01 验证。"
fi
NEW_SITE=$(mktemp "${TMPDIR:-/tmp}/aegis-panel-site.XXXXXX")
trap 'rm -f "$NEW_SITE"' EXIT
{
  data_plane_upstream aegis_relay_backend aegis_connection_upgrade
  cat <<EOF
upstream aegis_admin_backend {
    server 127.0.0.1:9080;
    keepalive 16;
}

# 控制面：只允许面板、Agent 注册/同步和安装脚本，不承载 Emby 节点。
server {
    listen 80;
    listen [::]:80;
    server_name $PANEL_DOMAIN;
    access_log off;
    client_max_body_size 1m;
    if (\$host != $PANEL_DOMAIN) { return 421; }
    location = /$ADMIN_PATH { return 301 /$ADMIN_PATH/; }
    location ^~ /$ADMIN_PATH/ {
        proxy_pass http://aegis_admin_backend;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_buffering off;
        proxy_buffer_size 64k;
        proxy_buffers 4 64k;
        proxy_busy_buffers_size 128k;
    }
    location / {
        proxy_pass http://aegis_relay_backend;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_buffering off;
        proxy_buffer_size 64k;
        proxy_buffers 4 64k;
        proxy_busy_buffers_size 128k;
    }
}

# 本地数据面：只承载 Emby 网关与播放流量。
server {
    listen 80;
    listen [::]:80;
    server_name $PROXY_DOMAIN;
    access_log off;
    client_max_body_size 0;
    if (\$host != $PROXY_DOMAIN) { return 421; }
EOF
  data_plane_location aegis_relay_backend aegis_connection_upgrade
  echo "}"
} > "$NEW_SITE"
rm -f "$AEGIS_NGINX_DIR/sites-enabled/default"
site_install aegis-relay "$NEW_SITE" || { echo "Nginx 双域名配置校验失败，已回滚。" >&2; exit 1; }
# Interrupted from here on, the panel goes back to the site it had.
trap 'site_restore aegis-relay' HUP INT TERM
if ! certbot --nginx -d "$PANEL_DOMAIN" --non-interactive --agree-tos --redirect -m "$EMAIL"; then site_restore aegis-relay; echo "面板域名证书配置失败，已恢复旧配置。" >&2; exit 1; fi
if ! certbot --nginx -d "$PROXY_DOMAIN" --non-interactive --agree-tos --redirect -m "$EMAIL"; then site_restore aegis-relay; echo "代理域名证书申请失败，已恢复旧配置。请检查 DNS、Cloudflare 和 80/443 端口。" >&2; exit 1; fi
systemctl enable --now certbot.timer 2>/dev/null || true
set_env "$INSTALL_DIR/.env" LOCAL_PROXY_BASE_URL "https://$PROXY_DOMAIN"
set_env "$INSTALL_DIR/.env" CERTIFICATE_EMAIL "$EMAIL"
cd "$INSTALL_DIR"
if docker compose version >/dev/null 2>&1; then docker compose up -d --force-recreate; else docker-compose up -d --force-recreate; fi
nginx -t && systemctl reload nginx
trap - HUP INT TERM
echo "代理域名已切换为 https://$PROXY_DOMAIN/；面板仍为 https://$PANEL_DOMAIN/。"
echo "旧代理域名已从 Nginx 路由移除，不再承载 Emby 流量。"
