#!/bin/sh
# Serve the shared steering entry domain on this machine, next to its own direct domain
# (docs/AUTO_STEERING.md §4). Run the command the panel shows on EVERY participating machine; re-run
# it on all of them whenever a machine joins or leaves.
#
#   configure-entry-domain.sh ENTRY_DOMAIN EMAIL [OTHER_MACHINE_DIRECT_DOMAIN ...]
#
# The entry domain resolves to different machines for different resolvers, so Let's Encrypt's HTTP-01
# check may land on a machine that did not ask for it. Every machine therefore answers ACME challenges
# for the entry domain from its own webroot first and otherwise asks the other machines once (marked
# with a hop header so the question is never passed on again). Each machine issues and keeps its own
# certificate; no DNS API token is needed and no private key ever leaves a machine.
set -eu
umask 022
usage(){ echo "用法: configure-entry-domain.sh 入口域名 证书邮箱 [其他机器的直连域名 ...]" >&2; }
[ "$#" -ge 2 ] || { usage; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "请使用 sudo 运行" >&2; exit 1; }
ENTRY=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
EMAIL=$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')
shift 2
DOMAIN_RE='^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
printf '%s' "$ENTRY" | grep -Eq "$DOMAIN_RE" || { echo "入口域名格式无效: $ENTRY" >&2; exit 1; }
printf '%s' "$EMAIL" | grep -Eq '^[^[:space:]@]+@[^[:space:]@]+$' || { echo "证书邮箱格式无效" >&2; exit 1; }

# This machine's own (direct) domain must differ from the entry domain: a steering redirect targets the
# direct domain precisely because it always reaches this one machine.
OWN=""
[ -f /opt/aegis-relay-agent/.env ] && OWN="$OWN $(sed -n 's/^AGENT_DOMAIN=//p' /opt/aegis-relay-agent/.env | head -n1)"
[ -f /opt/aegis-relay/.env ] && OWN="$OWN $(sed -n 's#^\(LOCAL_PROXY_BASE_URL\|PUBLIC_BASE_URL\)=https://\([^/:]*\).*#\2#p' /opt/aegis-relay/.env | tr '\n' ' ')"
for own in $OWN; do
  if [ "$(printf '%s' "$own" | tr '[:upper:]' '[:lower:]')" = "$ENTRY" ]; then
    echo "入口域名 $ENTRY 目前就是这台机器的直连域名。请先在面板「代理机器」里给这台机器换一个只解析到它自己的域名，再执行本命令。" >&2
    exit 1
  fi
done

# A wildcard certificate or an existing operator-managed vhost already serves this entry. Peer-list
# changes must not create a competing vhost or replace that deployment's certificate renewal.
if command -v nginx >/dev/null 2>&1 && command -v curl >/dev/null 2>&1 && nginx -t >/dev/null 2>&1; then
  VERIFY_DIR=$(mktemp -d /tmp/aegis-entry-verify.XXXXXX)
  if curl -fsS --noproxy '*' --retry 2 --retry-connrefused --retry-delay 1 --connect-timeout 3 --max-time 8 \
      --resolve "$ENTRY:443:127.0.0.1" "https://$ENTRY/" -o "$VERIFY_DIR/entry" 2>/dev/null \
    && curl -fsS --noproxy '*' --retry 2 --retry-connrefused --retry-delay 1 --connect-timeout 3 --max-time 8 \
      -H "Host: $ENTRY" http://127.0.0.1:8080/ -o "$VERIFY_DIR/relay" 2>/dev/null \
    && grep -q 'AegisRelay' "$VERIFY_DIR/relay" && cmp -s "$VERIFY_DIR/entry" "$VERIFY_DIR/relay"; then
    rm -rf "$VERIFY_DIR"
    echo "入口域名 https://$ENTRY/ 已生效，沿用现有 HTTPS 配置与证书续期。"
    exit 0
  fi
  rm -rf "$VERIFY_DIR"
fi

PEERS=""
for peer in "$@"; do
  peer=$(printf '%s' "$peer" | tr '[:upper:]' '[:lower:]')
  printf '%s' "$peer" | grep -Eq "$DOMAIN_RE" || { echo "跳过格式无效的机器域名: $peer" >&2; continue; }
  [ "$peer" != "$ENTRY" ] || continue
  # Nginx refuses to start with an upstream it cannot resolve, so leave such a peer out (with a warning).
  if ! getent hosts "$peer" >/dev/null 2>&1; then echo "警告：$peer 暂时无法解析，本次不转发证书验证到它。" >&2; continue; fi
  case " $PEERS " in *" $peer "*) ;; *) PEERS="$PEERS $peer";; esac
done

if ! command -v nginx >/dev/null 2>&1 || ! command -v certbot >/dev/null 2>&1; then
  apt-get update || echo "警告：apt 源索引更新失败，将沿用现有索引继续。" >&2
  DEBIAN_FRONTEND=noninteractive apt-get install -y nginx certbot
fi

ACME_ROOT=/var/lib/aegis-relay/acme
mkdir -p "$ACME_ROOT/.well-known/acme-challenge"
chmod 755 /var/lib/aegis-relay "$ACME_ROOT" "$ACME_ROOT/.well-known" "$ACME_ROOT/.well-known/acme-challenge"
SITE=/etc/nginx/sites-available/aegis-relay-entry.conf
ENABLED=/etc/nginx/sites-enabled/aegis-relay-entry.conf
CERT="/etc/letsencrypt/live/$ENTRY/fullchain.pem"
KEY="/etc/letsencrypt/live/$ENTRY/privkey.pem"

write_site(){
  TLS=$1
  {
    cat <<EOF
map \$http_upgrade \$aegis_entry_connection_upgrade { default upgrade; '' ''; }
upstream aegis_entry_backend {
    server 127.0.0.1:8080;
    keepalive 64;
}
EOF
    if [ -n "$PEERS" ]; then
      echo "upstream aegis_acme_peers {"
      for peer in $PEERS; do echo "    server $peer:80;"; done
      echo "}"
    fi
    cat <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $ENTRY;
    access_log off;
    if (\$host != $ENTRY) { return 421; }
    location ^~ /.well-known/acme-challenge/ {
        root $ACME_ROOT;
        try_files \$uri @aegis_acme_peers;
    }
    location @aegis_acme_peers {
EOF
    if [ -n "$PEERS" ]; then
      cat <<EOF
        # Asked on behalf of another machine already: answer from here or not at all, never pass it on.
        if (\$http_x_aegis_acme_hop) { return 404; }
        proxy_set_header Host \$host;
        proxy_set_header X-Aegis-Acme-Hop 1;
        proxy_connect_timeout 5s;
        proxy_read_timeout 10s;
        proxy_next_upstream error timeout http_404;
        proxy_pass http://aegis_acme_peers;
EOF
    else
      echo "        return 404;"
    fi
    cat <<EOF
    }
    location / { return 301 https://\$host\$request_uri; }
}
EOF
    [ "$TLS" = 1 ] || return 0
    cat <<EOF
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $ENTRY;
    access_log off;
    client_max_body_size 0;
    ssl_certificate $CERT;
    ssl_certificate_key $KEY;
EOF
    [ -f /etc/letsencrypt/options-ssl-nginx.conf ] && echo "    include /etc/letsencrypt/options-ssl-nginx.conf;"
    cat <<EOF
    if (\$host != $ENTRY) { return 421; }
    location / {
        proxy_pass http://aegis_entry_backend;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$aegis_entry_connection_upgrade;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_set_header Range \$http_range;
        proxy_set_header If-Range \$http_if_range;
        proxy_max_temp_file_size 0;
        proxy_buffer_size 256k;
        proxy_buffers 4 256k;
        proxy_busy_buffers_size 512k;
        proxy_ignore_headers X-Accel-Buffering X-Accel-Limit-Rate;
        proxy_socket_keepalive on;
        proxy_limit_rate 0;
        limit_rate 0;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        send_timeout 3600s;
    }
}
EOF
  } > "$SITE"
}

BACKUP=""
if [ -f "$SITE" ]; then BACKUP="$SITE.backup.$(date +%Y%m%d%H%M%S)"; cp "$SITE" "$BACKUP"; fi
restore_site(){
  if [ -n "$BACKUP" ] && [ -f "$BACKUP" ]; then cp "$BACKUP" "$SITE"; else rm -f "$SITE" "$ENABLED"; fi
  nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
}
apply_site(){
  write_site "$1"
  ln -sfn "$SITE" "$ENABLED"
  if ! nginx -t; then restore_site; echo "入口域名的 Nginx 配置校验失败，已回滚。" >&2; exit 1; fi
  systemctl enable --now nginx >/dev/null 2>&1 || true
  systemctl reload nginx
}

if [ -f "$CERT" ] && [ -f "$KEY" ]; then
  # Already issued: refresh the configuration (e.g. a new list of machines) and keep the certificate.
  apply_site 1
else
  # Challenge answering (and forwarding for the other machines) has to be live before asking for the
  # certificate, on every machine — so it goes in even if this machine's own issuance fails below.
  apply_site 0
  if ! certbot certonly --webroot -w "$ACME_ROOT" -d "$ENTRY" --cert-name "$ENTRY" --non-interactive --agree-tos -m "$EMAIL" --deploy-hook "systemctl reload nginx"; then
    echo "入口域名证书暂未签发成功：证书验证请求可能被解析到了还没执行本命令的机器。" >&2
    echo "请在所有参与切流的机器上都执行一遍面板给出的命令后，再回到这台机器重新执行。" >&2
    exit 1
  fi
  apply_site 1
fi
systemctl enable --now certbot.timer 2>/dev/null || true
echo "入口域名 https://$ENTRY/ 已在本机生效；证书由 certbot.timer 自动续期。"
