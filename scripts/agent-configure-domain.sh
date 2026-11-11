#!/bin/sh
# Serve this agent on a domain over HTTPS:  agent-configure-domain.sh DOMAIN EMAIL
set -eu
umask 077
AEGIS_HERE=$(dirname "$0")
if [ -f "$AEGIS_HERE/src/host-site.sh" ]; then . "$AEGIS_HERE/src/host-site.sh"; else . "$AEGIS_HERE/../src/host-site.sh"; fi
[ "$#" -eq 2 ] || { echo "用法: agent-configure-domain.sh 域名 证书邮箱" >&2; exit 1; }
agent_serve_domain "$1" "$2" || exit 1
