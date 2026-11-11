#!/bin/sh
set -eu
umask 077
AEGIS_HERE=$(dirname "$0")
# Without the library nothing can be done about a request (every installer copies src/, so this takes
# a damaged install, or the instant an upgrade replaces src/). The request must not sit there
# re-triggering this unit, and the agent must not wait for an answer that never comes: its `pending`
# status goes too, so it files the request again on its next heartbeat.
[ -f "$AEGIS_HERE/src/host-site.sh" ] || { rm -f "$AEGIS_HERE/data/host-domain-request.json" "$AEGIS_HERE/data/host-domain-status.json"; echo "src/host-site.sh is missing; run: sudo aegis-relay-agent update" >&2; exit 1; }
. "$AEGIS_HERE/src/host-site.sh"
DATA_DIR="$AEGIS_AGENT_DIR/data"
REQUEST="$DATA_DIR/host-domain-request.json"

[ "$(id -u)" -eq 0 ] || exit 1
[ -e "$REQUEST" ] || [ -L "$REQUEST" ] || exit 0

# The request comes from an unprivileged container, so it is read with care (host_request_fields) and
# every field is re-validated here before it reaches Nginx or certbot. Anything unexpected drops the
# request instead of running the workflow.
FIELDS=$(host_request_fields "$REQUEST" requestId mode desiredDomain certificateEmail 2>/dev/null) || { host_request_drop "$REQUEST"; exit 1; }
field(){ printf '%s\n' "$FIELDS" | sed -n "$1p"; }
REQUEST_ID=$(field 1)
MODE=$(field 2)
[ -n "$MODE" ] || MODE=domain
DOMAIN=$(field 3 | tr '[:upper:]' '[:lower:]')
EMAIL=$(field 4 | tr '[:upper:]' '[:lower:]')
printf '%s' "$REQUEST_ID" | grep -Eq '^[A-Za-z0-9_-]{8,80}$' || { host_request_drop "$REQUEST"; exit 1; }
case "$MODE" in
  domain)
    printf '%s' "$DOMAIN" | grep -Eq '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$' || { host_request_drop "$REQUEST"; exit 1; }
    printf '%s' "$EMAIL" | grep -Eq '^[^[:space:]@]+@[^[:space:]@]+$' || { host_request_drop "$REQUEST"; exit 1; }
    ;;
  ip) DOMAIN="" ;;
  *) host_request_drop "$REQUEST"; exit 1 ;;
esac

# The switch itself reports to the status file (applying, then active or failed), named after this request.
AEGIS_REQUEST_ID=$REQUEST_ID
RESULT=0
if [ "$MODE" = ip ]; then agent_serve_ip || RESULT=1; else agent_serve_domain "$DOMAIN" "$EMAIL" || RESULT=1; fi
host_request_drop "$REQUEST"
exit "$RESULT"
