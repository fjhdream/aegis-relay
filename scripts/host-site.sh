#!/bin/sh
# Sourced by the host scripts, never run by itself. One place for what every AegisRelay machine's host
# Nginx has in common: the data-plane location that carries Emby traffic to the relay, and the way a
# value is put into an install's .env. Installed next to the scripts that source it (the panel machine
# keeps them in /opt/aegis-relay/scripts, an agent in /opt/aegis-relay-agent).

# Where things live on the host. Nothing sets these in production (sudo and systemd both start the
# scripts with a clean environment); the tests point them at a temporary directory.
AEGIS_NGINX_DIR=${AEGIS_NGINX_DIR:-/etc/nginx}
AEGIS_LETSENCRYPT_DIR=${AEGIS_LETSENCRYPT_DIR:-/etc/letsencrypt}
AEGIS_AGENT_DIR=${AEGIS_AGENT_DIR:-/opt/aegis-relay-agent}
AEGIS_PANEL_DIR=${AEGIS_PANEL_DIR:-/opt/aegis-relay}

# The relay behind a site: `map` for WebSocket upgrades and a keep-alive upstream to the local relay.
# Both names are global to Nginx, so every site file passes its own pair:
#   data_plane_upstream BACKEND CONNECTION_VAR
data_plane_upstream(){
  cat <<EOF
map \$http_upgrade \$$2 { default upgrade; '' ''; }
upstream $1 {
    server 127.0.0.1:8080;
    keepalive 64;
}
EOF
}

# The `location /` of a server block that carries Emby traffic, the same on every machine and every
# kind of site. A tuning change is made here and reaches the panel machine, every agent and the
# steering entry domain with the next update.
#   data_plane_location BACKEND CONNECTION_VAR
data_plane_location(){
  cat <<EOF
    location / {
        proxy_pass http://$1;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$$2;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_set_header Range \$http_range;
        proxy_set_header If-Range \$http_if_range;
        proxy_max_temp_file_size 0;
        # With buffering disabled this is the maximum read size per event. The platform default is
        # only one memory page (4K/8K), which creates needless syscall churn on fast media streams.
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
EOF
}

# Set KEY=VALUE in an env file, replacing the line if the key is there and adding it if not.
#   set_env FILE KEY VALUE
set_env(){
  awk -v key="$2" -v value="$3" 'BEGIN{done=0} $0 ~ "^"key"=" {print key"="value;done=1;next} {print} END{if(!done)print key"="value}' "$1" > "$1.tmp"
  chmod 600 "$1.tmp"; mv "$1.tmp" "$1"
}

# ---------------------------------------------------------------------------------------------------
# An agent's direct address (直连地址, see GLOSSARY.md): the domain (HTTPS) or the public IP (plain
# HTTP) its Nginx answers on, in front of the agent container. Every way of setting it comes through
# agent_serve_domain and agent_serve_ip: the installer, the upgrade, the aegis-relay-agent command and
# the request the panel hands the agent. Whoever asked, a switch that worked leaves the machine in one
# state: Nginx serves the address, the agent's .env names it (AGENT_DOMAIN, AGENT_EMAIL,
# AGENT_PROXY_MODE, AGENT_PROXY_IP), and the status file says `active` with it. The agent reads that
# file on every heartbeat, so the panel learns the new address without the container being restarted.
# The functions report failure by their return value and never `exit`, so they work the same called on
# their own line or inside an `if`.

# The agent's site, printed.
#   agent_site_for_domain DOMAIN
agent_site_for_domain(){
  data_plane_upstream aegis_agent_backend aegis_agent_connection_upgrade
  cat <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $1;
    access_log off;
    client_max_body_size 0;
    if (\$host != $1) { return 421; }
EOF
  data_plane_location aegis_agent_backend aegis_agent_connection_upgrade
  echo "}"
}

agent_site_for_ip(){
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
}

# 第三方软件源失效（如 402/GPG 过期）不应中断脚本：所需软件包通常已安装，真正缺包时 apt-get install
# 仍会明确报错。
host_packages(){
  apt-get update || echo "警告：apt 源索引更新失败（常见于机器上某个第三方软件源失效），将沿用现有索引继续。" >&2
  DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
}

# Text as it goes inside a JSON string: one line, no control characters, at most 500 characters.
json_text(){
  printf '%s' "$1" | tr '\n\r\t' '   ' | tr -d '\000-\037' | cut -c1-500 | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# What the host last did about the agent's direct address, for the agent to report to the panel
# (src/domain-control.js reads it). AEGIS_REQUEST_ID names the panel's request when there is one.
#   agent_address_status STATE MODE DESIRED_DOMAIN CURRENT_ADDRESS MESSAGE
agent_address_status(){
  aegis_status_tmp=$(mktemp "$AEGIS_AGENT_DIR/data/.host-domain-status.XXXXXX") || return 1
  if printf '{"requestId":"%s","state":"%s","mode":"%s","desiredDomain":"%s","currentDomain":"%s","message":"%s","updatedAt":"%s"}\n' \
      "$(json_text "${AEGIS_REQUEST_ID:-}")" "$1" "$2" "$(json_text "$3")" "$(json_text "$4")" "$(json_text "$5")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$aegis_status_tmp" \
    && chmod 644 "$aegis_status_tmp" && mv -f "$aegis_status_tmp" "$AEGIS_AGENT_DIR/data/host-domain-status.json"; then return 0; fi
  rm -f "$aegis_status_tmp"; return 1
}

# The address in the agent's .env: its domain, or its IP when it has none.
agent_env_address(){
  aegis_address=$(sed -n 's/^AGENT_DOMAIN=//p' "$AEGIS_AGENT_DIR/.env" | head -n1)
  [ -n "$aegis_address" ] || aegis_address=$(sed -n 's/^AGENT_PROXY_IP=//p' "$AEGIS_AGENT_DIR/.env" | head -n1)
  printf '%s' "$aegis_address"
}

# Run the steps of a switch and leave the outcome where the agent and the operator find it: the steps'
# output on the terminal, and the status file saying applying, then active or failed with the reason.
#   agent_switch MODE DESIRED_DOMAIN STEPS [ARGUMENT ...]
agent_switch(){
  aegis_mode=$1 aegis_desired=$2; shift 2
  [ "$(id -u)" -eq 0 ] || { echo "请使用 sudo 运行" >&2; return 1; }
  [ -f "$AEGIS_AGENT_DIR/.env" ] || { echo "未找到 Agent 安装" >&2; return 1; }
  aegis_before=$(agent_env_address)
  # A directory of its own (root only): the marker below must not be a name another user could have
  # put a link at.
  aegis_work=$(mktemp -d "${TMPDIR:-/tmp}/aegis-agent-address.XXXXXX") || return 1
  aegis_log=$aegis_work/log
  if [ "$aegis_mode" = ip ]; then aegis_doing="正在切换为 IP 反代（HTTP）" aegis_done="已切换为 IP 反代（HTTP）" aegis_broke="IP 反代切换失败，请检查 80 端口与 Nginx"
  else aegis_doing="正在申请证书并切换 Nginx" aegis_done="域名已切换，证书自动续期已启用" aegis_broke="域名切换失败，请检查 DNS、Cloudflare 与 80/443 端口"; fi
  agent_address_status applying "$aegis_mode" "$aegis_desired" "$aegis_before" "$aegis_doing" || { rm -rf "$aegis_work"; return 1; }
  # The steps run on the left of a pipe so their output is both shown and kept; a marker file carries
  # their success out of that subshell.
  { "$@" && : > "$aegis_work/ok"; } 2>&1 | tee "$aegis_log"
  if [ -f "$aegis_work/ok" ]; then
    agent_address_status active "$aegis_mode" "$aegis_desired" "$(agent_env_address)" "$aegis_done"
    rm -rf "$aegis_work"
    return 0
  fi
  aegis_why=$(tail -n 8 "$aegis_log" | tr '\n' ' ' | cut -c1-480 | sed 's/ *$//')
  agent_address_status failed "$aegis_mode" "$aegis_desired" "$aegis_before" "${aegis_why:-$aegis_broke}"
  rm -rf "$aegis_work"
  return 1
}

# Serve the agent on DOMAIN over HTTPS, with a Let's Encrypt certificate registered to EMAIL.
#   agent_serve_domain DOMAIN EMAIL
agent_serve_domain(){
  aegis_domain=$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')
  printf '%s' "$aegis_domain" | grep -Eq '^[A-Za-z0-9.-]+$' || { echo "域名格式无效" >&2; return 1; }
  printf '%s' "${2:-}" | grep -Eq '^[^[:space:]@]+@[^[:space:]@]+$' || { echo "邮箱格式无效" >&2; return 1; }
  agent_switch domain "$aegis_domain" agent_domain_steps "$aegis_domain" "$2"
}

# IP 反代模式：以本机公网 IP 作为入口，Nginx 监听 80 端口明文 HTTP 转发到本地 Agent。
#   agent_serve_ip
agent_serve_ip(){ agent_switch ip "" agent_ip_steps; }

agent_domain_steps(){
  aegis_site=$AEGIS_NGINX_DIR/sites-available/aegis-relay-agent.conf
  host_packages nginx certbot python3-certbot-nginx || return 1
  agent_site_for_domain "$1" > "$aegis_site" || return 1
  ln -sfn "$aegis_site" "$AEGIS_NGINX_DIR/sites-enabled/aegis-relay-agent.conf" || return 1
  nginx -t || return 1
  systemctl enable --now nginx || return 1
  systemctl reload nginx || return 1
  certbot --nginx -d "$1" --non-interactive --agree-tos --redirect -m "$2" || return 1
  systemctl enable --now certbot.timer 2>/dev/null || true
  set_env "$AEGIS_AGENT_DIR/.env" AGENT_DOMAIN "$1" || return 1
  set_env "$AEGIS_AGENT_DIR/.env" AGENT_EMAIL "$2" || return 1
  set_env "$AEGIS_AGENT_DIR/.env" AGENT_PROXY_MODE domain || return 1
  echo "Agent HTTPS 已就绪: https://$1/"
}

agent_ip_steps(){
  aegis_site=$AEGIS_NGINX_DIR/sites-available/aegis-relay-agent.conf
  host_packages nginx || return 1
  aegis_ip=$(curl -4fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
  [ -n "$aegis_ip" ] || { echo "无法检测公网 IP" >&2; return 1; }
  aegis_backup=""
  if [ -f "$aegis_site" ]; then aegis_backup="$aegis_site.backup.$(date +%Y%m%d%H%M%S)"; cp "$aegis_site" "$aegis_backup" || return 1; fi
  agent_site_for_ip > "$aegis_site" || return 1
  ln -sfn "$aegis_site" "$AEGIS_NGINX_DIR/sites-enabled/aegis-relay-agent.conf" || return 1
  rm -f "$AEGIS_NGINX_DIR/sites-enabled/default"
  if ! nginx -t; then
    [ -n "$aegis_backup" ] && cp "$aegis_backup" "$aegis_site"
    echo "Nginx 配置校验失败，已回滚。" >&2
    return 1
  fi
  systemctl enable --now nginx || return 1
  systemctl reload nginx || return 1
  set_env "$AEGIS_AGENT_DIR/.env" AGENT_DOMAIN "" || return 1
  set_env "$AEGIS_AGENT_DIR/.env" AGENT_PROXY_MODE ip || return 1
  set_env "$AEGIS_AGENT_DIR/.env" AGENT_PROXY_IP "$aegis_ip" || return 1
  echo "Agent IP 反代已就绪: http://$aegis_ip/"
}
