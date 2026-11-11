#!/bin/sh
set -eu
umask 077
# Its own place, in full, and then away from wherever it was started: python puts the current
# directory on its module path, and a script run by hand from inside data/ (which belongs to the
# container) must not load what the container left there.
AEGIS_HERE=$(cd "$(dirname "$0")" && pwd)
cd /
# Without the library nothing can be done about a request (every installer copies src/, so this takes
# a damaged install, or the instant an upgrade replaces src/). The request must not sit there
# re-triggering this unit. The status stays: it is also the agent's record of the address it serves,
# and `aegis-relay-agent update`, which the message asks for, writes it anew.
[ -f "$AEGIS_HERE/src/host-site.sh" ] || { rm -rf -- "$AEGIS_HERE/data/host-domain-request.json" 2>/dev/null || true; echo "src/host-site.sh is missing; run: sudo aegis-relay-agent update" >&2; exit 1; }
. "$AEGIS_HERE/src/host-site.sh"
DATA_DIR="$AEGIS_AGENT_DIR/data"
REQUEST="$DATA_DIR/host-domain-request.json"

[ "$(id -u)" -eq 0 ] || exit 1
[ -e "$REQUEST" ] || [ -L "$REQUEST" ] || exit 0
# From here on the request is gone when this script ends, whether a check below turns it away, a step
# fails under `set -e` or the work is done: while it is there the path unit starts the script again.
# (A signal that kills the shell is the exception: the request stays and is acted on after the restart.)
# And a request that was turned away is answered `failed`, naming no request, so that the agent does
# not wait for ever for a switch nobody is making: it asks again on a later heartbeat.
ANSWERED=0 MODE=
finish(){
  [ "$ANSWERED" = 1 ] || agent_address_status failed "$([ "$MODE" = ip ] && echo ip || echo domain)" "" "$(agent_env_address)" "$HOST_REQUEST_REFUSED" || true
  host_request_drop "$REQUEST"
}
trap finish EXIT

# The request comes from an unprivileged container, so it is read with care (host_request_fields) and
# every field is re-validated here before it reaches Nginx, certbot or .env. Anything unexpected ends
# the script instead of running the workflow.
FIELDS=$(host_request_fields "$REQUEST" requestId mode desiredDomain certificateEmail 2>/dev/null) || exit 1
field(){ printf '%s\n' "$FIELDS" | sed -n "$1p"; }
REQUEST_ID=$(field 1)
MODE=$(field 2)
[ -n "$MODE" ] || MODE=domain
DOMAIN=$(field 3 | tr '[:upper:]' '[:lower:]')
EMAIL=$(field 4 | tr '[:upper:]' '[:lower:]')
value_matches "$REQUEST_ID" '^[A-Za-z0-9_-]{8,80}$' || exit 1
case "$MODE" in
  domain)
    value_matches "$DOMAIN" '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$' || exit 1
    email_ok "$EMAIL" || exit 1
    ;;
  ip) DOMAIN="" ;;
  *) exit 1 ;;
esac

# The switch itself reports to the status file (applying, then active or failed), named after this request.
AEGIS_REQUEST_ID=$REQUEST_ID
ANSWERED=1
RESULT=0
if [ "$MODE" = ip ]; then agent_serve_ip || RESULT=1; else agent_serve_domain "$DOMAIN" "$EMAIL" || RESULT=1; fi
exit "$RESULT"
