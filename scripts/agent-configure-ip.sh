#!/bin/sh
# Serve this agent on its public IP over plain HTTP:  agent-configure-ip.sh
set -eu
umask 077
. "${AEGIS_HOST_SITE_LIB:-$(dirname "$0")/host-site.sh}"
agent_serve_ip
