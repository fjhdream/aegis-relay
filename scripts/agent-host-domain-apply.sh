#!/bin/sh
set -eu
umask 077
. "${AEGIS_HOST_SITE_LIB:-$(dirname "$0")/host-site.sh}"
DATA_DIR="$AEGIS_AGENT_DIR/data"
REQUEST="$DATA_DIR/host-domain-request.json"

[ "$(id -u)" -eq 0 ] || exit 1
[ -f "$REQUEST" ] || exit 0

# The request comes from an unprivileged container, so every field is re-validated here before it
# reaches Nginx or certbot. Anything unexpected drops the request instead of running the workflow.
read_field() {
  python3 -c 'import json,sys; value=json.load(open(sys.argv[1],encoding="utf-8")).get(sys.argv[2],""); print(value if isinstance(value,str) else "")' "$REQUEST" "$1"
}
REQUEST_ID=$(read_field requestId 2>/dev/null || true)
MODE=$(read_field mode 2>/dev/null || true)
[ -n "$MODE" ] || MODE=domain
DOMAIN=$(read_field desiredDomain | tr '[:upper:]' '[:lower:]')
EMAIL=$(read_field certificateEmail | tr '[:upper:]' '[:lower:]')
printf '%s' "$REQUEST_ID" | grep -Eq '^[A-Za-z0-9_-]{8,80}$' || { rm -f "$REQUEST"; exit 1; }
case "$MODE" in
  domain)
    printf '%s' "$DOMAIN" | grep -Eq '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$' || { rm -f "$REQUEST"; exit 1; }
    printf '%s' "$EMAIL" | grep -Eq '^[^[:space:]@]+@[^[:space:]@]+$' || { rm -f "$REQUEST"; exit 1; }
    ;;
  ip) DOMAIN="" ;;
  *) rm -f "$REQUEST"; exit 1 ;;
esac

# The switch itself reports to the status file (applying, then active or failed), named after this request.
AEGIS_REQUEST_ID=$REQUEST_ID
RESULT=0
if [ "$MODE" = ip ]; then agent_serve_ip || RESULT=1; else agent_serve_domain "$DOMAIN" "$EMAIL" || RESULT=1; fi
rm -f "$REQUEST"
exit "$RESULT"
