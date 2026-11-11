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
