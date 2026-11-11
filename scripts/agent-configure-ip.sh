#!/bin/sh
# Serve this agent on its public IP over plain HTTP:  agent-configure-ip.sh
set -eu
umask 077
AEGIS_HERE=$(dirname "$0")
if [ -f "$AEGIS_HERE/src/host-site.sh" ]; then . "$AEGIS_HERE/src/host-site.sh"; else . "$AEGIS_HERE/../src/host-site.sh"; fi
agent_serve_ip || exit 1
