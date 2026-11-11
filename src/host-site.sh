#!/bin/sh
# Sourced by the host scripts in scripts/, never run by itself. One place for what every AegisRelay
# machine's host Nginx has in common: the data-plane location that carries Emby traffic to the relay,
# how a site is put in place and taken back, how a value is put into an install's .env, and the whole
# of setting an agent's direct address.
#
# It lives in src/ and not next to the scripts for one reason: an agent's scripts are installed one by
# one from a fixed list, by an installer the panel serves from its own version and an upgrade script
# that may be cached, while the code comes from the newest tarball. Either can be older than the
# scripts it installs. src/ is the one directory every version of both copies whole, so the scripts
# always find this file: at src/ under an agent's install directory, at ../src from the panel's scripts/.

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

# Set KEY=VALUE in an env file, replacing the line if the key is there and adding it if not. Several
# pairs are set together or not at all: the new file is complete before it takes the old one's place,
# so a full disk leaves the old one alone, whichever key it gave out at. A VALUE is written as it is:
# it reaches awk through the environment, where \012 stays four characters (given with -v it would
# become a line break, and a second line in the file).
#   set_env FILE KEY VALUE [KEY VALUE ...]
set_env(){
  aegis_env_file=$1; shift
  cp "$aegis_env_file" "$aegis_env_file.tmp" || { rm -f "$aegis_env_file.tmp"; return 1; }
  while [ "$#" -ge 2 ]; do
    case "$2" in *"
"*) rm -f "$aegis_env_file.tmp"; return 1 ;; esac
    if AEGIS_ENV_VALUE=$2 awk -v key="$1" 'BEGIN{done=0;value=ENVIRON["AEGIS_ENV_VALUE"]} $0 ~ "^"key"=" {print key"="value;done=1;next} {print} END{if(!done)print key"="value}' "$aegis_env_file.tmp" > "$aegis_env_file.next" \
      && mv "$aegis_env_file.next" "$aegis_env_file.tmp"; then shift 2; else rm -f "$aegis_env_file.tmp" "$aegis_env_file.next"; return 1; fi
  done
  if chmod 600 "$aegis_env_file.tmp" && mv "$aegis_env_file.tmp" "$aegis_env_file"; then return 0; fi
  rm -f "$aegis_env_file.tmp"; return 1
}

# Put a site in place: keep a copy of the one it replaces, enable it, and have Nginx check and load it.
# If Nginx refuses it the previous site is put back before this returns. FILE holds the new site; it
# is a file and not standard input on purpose: piping into a shell function runs it in a subshell, and
# site_restore would then not know what to restore.
#   site_install NAME FILE
site_install(){
  aegis_site=$AEGIS_NGINX_DIR/sites-available/$1.conf aegis_enabled=$AEGIS_NGINX_DIR/sites-enabled/$1.conf
  AEGIS_SITE_BACKUP="" AEGIS_SITE_WAS_ENABLED=0
  if [ -e "$aegis_enabled" ] || [ -L "$aegis_enabled" ]; then AEGIS_SITE_WAS_ENABLED=1; fi
  if [ -f "$aegis_site" ]; then AEGIS_SITE_BACKUP="$aegis_site.backup.$(date +%Y%m%d%H%M%S)"; cp "$aegis_site" "$AEGIS_SITE_BACKUP" || return 1; fi
  cp "$2" "$aegis_site" && ln -sfn "$aegis_site" "$aegis_enabled" || { site_restore "$1"; return 1; }
  if ! nginx -t; then site_restore "$1"; echo "Nginx 配置校验失败，已恢复原来的站点。" >&2; return 1; fi
  systemctl enable --now nginx && systemctl reload nginx || { site_restore "$1"; return 1; }
}

# Undo the last site_install of NAME: the site it replaced comes back, or the new one goes if there was
# none, and Nginx loads the result. For a later step that fails (the certificate, say).
#   site_restore NAME
site_restore(){
  aegis_site=$AEGIS_NGINX_DIR/sites-available/$1.conf aegis_enabled=$AEGIS_NGINX_DIR/sites-enabled/$1.conf
  if [ -n "${AEGIS_SITE_BACKUP:-}" ] && [ -f "$AEGIS_SITE_BACKUP" ]; then cp "$AEGIS_SITE_BACKUP" "$aegis_site"; else rm -f "$aegis_site"; fi
  [ "${AEGIS_SITE_WAS_ENABLED:-0}" = 1 ] || rm -f "$aegis_enabled"
  nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
}

# ---------------------------------------------------------------------------------------------------
# Requests. A container cannot touch the host's Nginx or certificates, so it leaves a request file in
# its data directory and a systemd path unit starts a script here, as root, to act on it. That
# directory belongs to the container's user: whatever is at the request's name is that user's doing.

# The request as one line of ASCII JSON, if it is what a request can be: a regular file of at most
# 64 KiB, opened without following a link and without waiting, that holds a JSON object in UTF-8.
# Anything else fails, unread: a link (to a file only root may read, or to /dev/zero), a pipe that
# would keep the unit waiting for ever, a file large enough to exhaust the host's memory. What comes
# out reads the same however it is passed on and whatever the locale: no raw control character, no
# byte that is not ASCII, no line break.
#   host_request_json FILE
host_request_json(){
  python3 - "$1" <<'PY'
import json, os, stat, sys
LIMIT = 65536
try:
    descriptor = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
except OSError:
    sys.exit(1)
try:
    information = os.fstat(descriptor)
    if not stat.S_ISREG(information.st_mode) or information.st_size > LIMIT:
        sys.exit(1)
    text = b''
    while len(text) <= LIMIT:
        piece = os.read(descriptor, LIMIT + 1 - len(text))
        if not piece:
            break
        text += piece
    if len(text) > LIMIT:
        sys.exit(1)
finally:
    os.close(descriptor)
try:
    request = json.loads(text.decode('utf-8'))
except Exception:
    sys.exit(1)
if not isinstance(request, dict):
    sys.exit(1)
print(json.dumps(request))
PY
}

# The named fields of a request, one per line, read once so that all of them come from the same
# request. A field that is missing, not a string, or holds a line break comes out as an empty line
# (a line break would shift every field after it); a request that cannot be read fails.
#   host_request_fields FILE NAME [NAME ...]
host_request_fields(){
  aegis_request_file=$1; shift
  host_request_json "$aegis_request_file" | python3 -c '
import json, sys
request = json.load(sys.stdin)
for name in sys.argv[1:]:
    field = request.get(name, "")
    print(field if isinstance(field, str) and "\n" not in field else "")
' "$@"
}

# What a request is answered with when no switch came of it (the panel shows these).
HOST_REQUEST_REFUSED="宿主机没有执行这个请求：请求无法读取或格式不符。请确认面板与这台机器的版本一致。"
HOST_REQUEST_BROKE_OFF="宿主机脚本中途出错，切换没有完成。请查看这台机器的 systemd 日志后重试。"

# Whether VALUE, all of it, matches PATTERN (an extended regular expression from ^ to $). grep judges
# a line at a time: a value with a line break in it would pass as soon as one of its lines matched,
# and the other lines would go wherever the value goes (an Nginx site, an argument to certbot).
#   value_matches VALUE PATTERN
value_matches(){
  case $1 in *'
'*) return 1 ;; esac
  printf '%s' "$1" | grep -Eq -e "$2"
}

# Whether VALUE is a certificate email this host will hand to certbot and write into .env: at most 254
# characters of plain ASCII from the usual set. Nothing in it is syntax to a shell, to Compose (which
# expands \${…} when it reads .env) or to Nginx. The panel goes by the same rule
# (isCertificateEmail in src/agent-registry.js).
#   email_ok VALUE
email_ok(){ [ "${#1}" -le 254 ] && value_matches "$1" '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$'; }

# Take away whatever is at a request's name, so that the path unit watching it comes to rest. A
# request is a file; if the container put a directory or a link there, that goes too (a link is
# removed, not followed).
#   host_request_drop FILE
host_request_drop(){ rm -rf -- "$1" 2>/dev/null || true; }

# ---------------------------------------------------------------------------------------------------
# An agent's direct address (直连地址, see GLOSSARY.md): the domain (HTTPS) or the public IP (plain
# HTTP) its Nginx answers on, in front of the agent container. Every way of setting it comes through
# agent_serve_domain and agent_serve_ip: the installer, the upgrade, the aegis-relay-agent command and
# the request the panel hands the agent. Whoever asked, a switch that worked leaves the machine in one
# state: Nginx serves the address, the agent's .env names it (AGENT_DOMAIN, AGENT_EMAIL,
# AGENT_PROXY_MODE, AGENT_PROXY_IP), and the status file says `active` with it. The agent reads that
# file on every heartbeat, so the panel learns the new address without the container being restarted;
# the container still has the environment it was started with, which is why every status names the
# address served at that moment (src/domain-control.js servingAddress).
# The functions report failure by their return value and never `exit`, and every step in them is
# checked where it stands: they behave the same under `set -e` and inside an `if` or `||`, where the
# shell ignores it.

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

# rename(2) and nothing else. GNU mv needs -T for that: without it a destination that is a link to a
# directory gets the file moved inside that directory.
host_rename(){ if mv --version >/dev/null 2>&1; then mv -fT "$1" "$2"; else mv -f "$1" "$2"; fi; }

# What the host last did about the agent's direct address, for the agent to report to the panel
# (src/domain-control.js reads it). AEGIS_REQUEST_ID names the panel's request when there is one.
#
# The file goes into data/, which belongs to the agent container's user, so root must never open a name
# there that this user could have turned into a link. The new file is therefore created by the write
# itself, under a name nobody can know beforehand and only if nothing is there (a link to a file is
# refused by noclobber; the check before it also turns away a link to a device or a pipe, which the
# shell would write into), gets its mode from the umask instead of a chmod by name, and is renamed
# into place.
#   agent_address_status STATE MODE DESIRED_DOMAIN CURRENT_ADDRESS MESSAGE
agent_address_status(){
  aegis_status_line=$(printf '{"requestId":"%s","state":"%s","mode":"%s","desiredDomain":"%s","currentDomain":"%s","message":"%s","updatedAt":"%s"}' \
    "$(json_text "${AEGIS_REQUEST_ID:-}")" "$1" "$2" "$(json_text "$3")" "$(json_text "$4")" "$(json_text "$5")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)") || return 1
  aegis_status_random=$(od -An -N8 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')
  [ "${#aegis_status_random}" -eq 16 ] || return 1
  aegis_status_tmp=$AEGIS_AGENT_DIR/data/.host-domain-status.$aegis_status_random
  if [ -e "$aegis_status_tmp" ] || [ -L "$aegis_status_tmp" ]; then return 1; fi
  ( set -C; umask 022; printf '%s\n' "$aegis_status_line" > "$aegis_status_tmp" ) 2>/dev/null || { rm -f "$aegis_status_tmp"; return 1; }
  host_rename "$aegis_status_tmp" "$AEGIS_AGENT_DIR/data/host-domain-status.json" && return 0
  rm -f "$aegis_status_tmp"; return 1
}

# The address in the agent's .env: its domain, or its IP when it has none.
agent_env_address(){
  aegis_address=$(sed -n 's/^AGENT_DOMAIN=//p' "$AEGIS_AGENT_DIR/.env" 2>/dev/null | head -n1)
  [ -n "$aegis_address" ] || aegis_address=$(sed -n 's/^AGENT_PROXY_IP=//p' "$AEGIS_AGENT_DIR/.env" 2>/dev/null | head -n1)
  printf '%s' "$aegis_address"
}

# Run the steps of a switch and leave the outcome where the agent and the operator find it: the steps'
# output on the terminal, and the status file saying applying, then active or failed with the reason.
# Rendering again what is already served (AEGIS_RENDER_AGAIN=1, from agent_serve_current) is not a
# change anybody asked for: only its success is recorded, so a failed one shows no failed switch in the
# panel.
#   agent_switch MODE DESIRED_DOMAIN STEPS [ARGUMENT ...]
agent_switch(){
  aegis_mode=$1 aegis_desired=$2; shift 2
  [ "$(id -u)" -eq 0 ] || { echo "请使用 sudo 运行" >&2; return 1; }
  if [ "$aegis_mode" = ip ]; then aegis_doing="正在切换为 IP 反代（HTTP）" aegis_done="已切换为 IP 反代（HTTP）" aegis_broke="IP 反代切换失败，请检查 80 端口与 Nginx"
  else aegis_doing="正在申请证书并切换 Nginx" aegis_done="域名已切换，证书自动续期已启用" aegis_broke="域名切换失败，请检查 DNS、Cloudflare 与 80/443 端口"; fi
  aegis_before=$(agent_env_address)
  # Whatever stops the switch, a request the panel made gets an answer: the agent files no second one
  # while the first is unanswered.
  aegis_gave_up(){ echo "$1" >&2; [ "${AEGIS_RENDER_AGAIN:-0}" = 1 ] || agent_address_status failed "$aegis_mode" "$aegis_desired" "$aegis_before" "$1" || true; }
  [ -f "$AEGIS_AGENT_DIR/.env" ] || { aegis_gave_up "未找到 Agent 安装"; return 1; }
  # A directory of its own (root only): the marker below must not be a name another user could have
  # put a link at.
  aegis_work=$(mktemp -d "${TMPDIR:-/tmp}/aegis-agent-address.XXXXXX") || { aegis_gave_up "无法创建临时目录"; return 1; }
  aegis_log=$aegis_work/log
  if [ "${AEGIS_RENDER_AGAIN:-0}" != 1 ]; then
    agent_address_status applying "$aegis_mode" "$aegis_desired" "$aegis_before" "$aegis_doing" || { rm -rf "$aegis_work"; echo "无法写入状态文件" >&2; return 1; }
  fi
  # The steps run on the left of a pipe so their output is both shown and kept; a marker file carries
  # their success out of that subshell.
  { "$@" && : > "$aegis_work/ok"; } 2>&1 | tee "$aegis_log" || true
  if [ -f "$aegis_work/ok" ]; then
    rm -rf "$aegis_work"
    agent_address_status active "$aegis_mode" "$aegis_desired" "$(agent_env_address)" "$aegis_done" && return 0
    echo "直连地址已切换，但状态文件写入失败，探针暂时不会上报新地址。" >&2
    return 1
  fi
  aegis_why=$(tail -n 8 "$aegis_log" 2>/dev/null | tr '\n' ' ' | cut -c1-480 | sed 's/ *$//')
  rm -rf "$aegis_work"
  [ "${AEGIS_RENDER_AGAIN:-0}" = 1 ] || agent_address_status failed "$aegis_mode" "$aegis_desired" "$aegis_before" "${aegis_why:-$aegis_broke}" || true
  return 1
}

# Serve the agent on DOMAIN over HTTPS, with a Let's Encrypt certificate registered to EMAIL.
#   agent_serve_domain DOMAIN EMAIL
agent_serve_domain(){
  aegis_domain=$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')
  value_matches "$aegis_domain" '^[A-Za-z0-9.-]+$' || { echo "域名格式无效" >&2; return 1; }
  email_ok "${2:-}" || { echo "邮箱格式无效" >&2; return 1; }
  agent_switch domain "$aegis_domain" agent_domain_steps "$aegis_domain" "$2"
}

# IP 反代模式：以本机公网 IP 作为入口，Nginx 监听 80 端口明文 HTTP 转发到本地 Agent。
#   agent_serve_ip [keep]     keep: do not look the address up again when one is already on record
agent_serve_ip(){ agent_switch ip "" agent_ip_steps "$@"; }

# A switch that fails at any step leaves the machine serving on the address it had: the site Nginx had
# loaded is back in place, .env is untouched.
agent_domain_steps(){
  host_packages nginx certbot python3-certbot-nginx || return 1
  aegis_new=$(mktemp "${TMPDIR:-/tmp}/aegis-agent-site.XXXXXX") || return 1
  if agent_site_for_domain "$1" > "$aegis_new" && site_install aegis-relay-agent "$aegis_new"; then rm -f "$aegis_new"; else rm -f "$aegis_new"; return 1; fi
  if ! certbot --nginx -d "$1" --non-interactive --agree-tos --redirect -m "$2"; then
    site_restore aegis-relay-agent
    echo "证书申请失败，已恢复原来的站点。请检查 DNS、Cloudflare 与 80/443 端口后重试。" >&2
    return 1
  fi
  systemctl enable --now certbot.timer 2>/dev/null || true
  if set_env "$AEGIS_AGENT_DIR/.env" AGENT_DOMAIN "$1" AGENT_EMAIL "$2" AGENT_PROXY_MODE domain; then
    echo "Agent HTTPS 已就绪: https://$1/"
    return 0
  fi
  site_restore aegis-relay-agent
  echo "无法写入 $AEGIS_AGENT_DIR/.env（磁盘已满？），已恢复原来的站点。" >&2
  return 1
}

agent_ip_steps(){
  host_packages nginx || return 1
  aegis_known_ip=$(sed -n 's/^AGENT_PROXY_IP=//p' "$AEGIS_AGENT_DIR/.env" | head -n1)
  if [ "${1:-}" = keep ] && [ -n "$aegis_known_ip" ]; then aegis_ip=$aegis_known_ip
  else
    aegis_ip=$(curl -4fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
    # A lookup that fails says nothing about the address. The one already on record was a public one;
    # the first address of a local interface often is not (NAT), so it is only the last resort.
    [ -n "$aegis_ip" ] || aegis_ip=$aegis_known_ip
    [ -n "$aegis_ip" ] || aegis_ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  fi
  [ -n "$aegis_ip" ] || { echo "无法检测公网 IP" >&2; return 1; }
  aegis_new=$(mktemp "${TMPDIR:-/tmp}/aegis-agent-site.XXXXXX") || return 1
  # The agent becomes the default server, so the distribution's default site has to make way; it comes
  # back if the switch does not go through.
  aegis_default=$AEGIS_NGINX_DIR/sites-enabled/default
  aegis_default_target=$(readlink "$aegis_default" 2>/dev/null || true)
  rm -f "$aegis_default"
  aegis_default_back(){ if [ -n "$aegis_default_target" ]; then ln -sfn "$aegis_default_target" "$aegis_default"; nginx -t >/dev/null 2>&1 && systemctl reload nginx || true; fi; }
  if agent_site_for_ip > "$aegis_new" && site_install aegis-relay-agent "$aegis_new"; then rm -f "$aegis_new"; else rm -f "$aegis_new"; aegis_default_back; return 1; fi
  if set_env "$AEGIS_AGENT_DIR/.env" AGENT_DOMAIN "" AGENT_PROXY_MODE ip AGENT_PROXY_IP "$aegis_ip"; then
    echo "Agent IP 反代已就绪: http://$aegis_ip/"
    return 0
  fi
  site_restore aegis-relay-agent; aegis_default_back
  echo "无法写入 $AEGIS_AGENT_DIR/.env（磁盘已满？），已恢复原来的站点。" >&2
  return 1
}

# Render again the address the agent serves on now, so that an update's Nginx tuning reaches it. What
# Nginx has loaded is the truth about that address: the enabled site's server_name is `_` on the IP
# site and the domain otherwise. Only a machine with no site yet is read from .env. The address itself
# does not change: on its IP the agent keeps the one on record.
#
# Before anything is rendered the status file is made to say what Nginx serves. The agent goes by that
# file, and one left by an older version can name an address the machine has moved away from since
# (those versions did not write it on every switch); if the rendering below then fails, that stale
# address would be what the agent reports. It also means a failed switch on record is forgotten here:
# the agent asks again for a domain the panel still wants.
# Returns 3 when there is nothing to render (no address was ever set up), 1 when rendering failed.
#   agent_serve_current
agent_serve_current(){
  aegis_serving=$(sed -n 's/^[[:space:]]*server_name[[:space:]]\{1,\}\([^;[:space:]]*\).*$/\1/p' "$AEGIS_NGINX_DIR/sites-enabled/aegis-relay-agent.conf" 2>/dev/null | head -n1)
  aegis_env_email=$(sed -n 's/^AGENT_EMAIL=//p' "$AEGIS_AGENT_DIR/.env" 2>/dev/null | head -n1)
  if [ "$aegis_serving" = _ ]; then
    aegis_known_ip=$(sed -n 's/^AGENT_PROXY_IP=//p' "$AEGIS_AGENT_DIR/.env" 2>/dev/null | head -n1)
    [ -z "$aegis_known_ip" ] || agent_address_status active ip "" "$aegis_known_ip" "已切换为 IP 反代（HTTP）" || true
  elif [ -n "$aegis_serving" ]; then
    agent_address_status active domain "$aegis_serving" "$aegis_serving" "域名已切换，证书自动续期已启用" || true
  fi
  if [ -z "$aegis_serving" ]; then
    if [ "$(sed -n 's/^AGENT_PROXY_MODE=//p' "$AEGIS_AGENT_DIR/.env" 2>/dev/null | head -n1)" = ip ]; then aegis_serving=_
    else aegis_serving=$(sed -n 's/^AGENT_DOMAIN=//p' "$AEGIS_AGENT_DIR/.env" 2>/dev/null | head -n1); fi
    [ -n "$aegis_serving" ] || return 3
    [ "$aegis_serving" = _ ] || [ -n "$aegis_env_email" ] || return 3
  fi
  if [ "$aegis_serving" != _ ] && [ -z "$aegis_env_email" ]; then
    echo "Nginx 正在为 $aegis_serving 服务，但 .env 里没有证书邮箱（AGENT_EMAIL），无法重新生成站点。" >&2
    return 1
  fi
  AEGIS_RENDER_AGAIN=1
  if [ "$aegis_serving" = _ ]; then agent_serve_ip keep; else agent_serve_domain "$aegis_serving" "$aegis_env_email"; fi
  aegis_rendered=$?
  AEGIS_RENDER_AGAIN=0
  return "$aegis_rendered"
}
