#!/bin/sh
set -eu
umask 077
. "${AEGIS_HOST_SITE_LIB:-$(dirname "$0")/host-site.sh}"
INSTALL_DIR=$AEGIS_AGENT_DIR
DOMAIN=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
EMAIL=$2
[ "$(id -u)" -eq 0 ] || { echo "请使用 sudo 运行" >&2; exit 1; }
printf '%s' "$DOMAIN" | grep -Eq '^[A-Za-z0-9.-]+$' || { echo "域名格式无效" >&2; exit 1; }
printf '%s' "$EMAIL" | grep -Eq '^[^[:space:]@]+@[^[:space:]@]+$' || { echo "邮箱格式无效" >&2; exit 1; }
# 第三方软件源失效（如 402/GPG 过期）不应中断本脚本：所需软件包通常已安装，
# 真正缺包时下面的 apt-get install 仍会明确报错。
apt-get update || echo "警告：apt 源索引更新失败（常见于机器上某个第三方软件源失效），将沿用现有索引继续。" >&2
DEBIAN_FRONTEND=noninteractive apt-get install -y nginx certbot python3-certbot-nginx
SITE=$AEGIS_NGINX_DIR/sites-available/aegis-relay-agent.conf
{
  data_plane_upstream aegis_agent_backend aegis_agent_connection_upgrade
  cat <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    access_log off;
    client_max_body_size 0;
    if (\$host != $DOMAIN) { return 421; }
EOF
  data_plane_location aegis_agent_backend aegis_agent_connection_upgrade
  echo "}"
} > "$SITE"
ln -sfn "$SITE" "$AEGIS_NGINX_DIR/sites-enabled/aegis-relay-agent.conf"
nginx -t
systemctl enable --now nginx
systemctl reload nginx
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect -m "$EMAIL"
systemctl enable --now certbot.timer 2>/dev/null || true
set_env "$INSTALL_DIR/.env" AGENT_DOMAIN "$DOMAIN"
set_env "$INSTALL_DIR/.env" AGENT_EMAIL "$EMAIL"
echo "Agent HTTPS 已就绪: https://$DOMAIN/"
