#!/bin/sh
set -eu
umask 077
# Its own place, in full, and then away from wherever it was started: python puts the current
# directory on its module path, and a script run by hand from inside data/ (which belongs to the
# container) must not load what the container left there.
AEGIS_HERE=$(cd "$(dirname "$0")" && pwd)
cd /
# Without the library the request cannot be read safely; it must still not sit there re-triggering
# this unit, and the panel must not wait for an answer that never comes: its `pending` status goes too,
# so the switch can be asked for again. (The panel machine keeps the whole repository, so this takes a
# damaged install.)
[ -f "$AEGIS_HERE/../src/host-site.sh" ] || { rm -rf -- "$AEGIS_HERE/../data/host-domain-request.json" "$AEGIS_HERE/../data/host-domain-status.json" 2>/dev/null || true; echo "src/host-site.sh is missing; run: sudo aegis-relay update" >&2; exit 1; }
. "$AEGIS_HERE/../src/host-site.sh"
INSTALL_DIR=$AEGIS_PANEL_DIR
DATA_DIR="$INSTALL_DIR/data"
REQUEST="$DATA_DIR/host-domain-request.json"
STATUS="$DATA_DIR/host-domain-status.json"

[ "$(id -u)" -eq 0 ] || exit 1
[ -e "$REQUEST" ] || [ -L "$REQUEST" ] || exit 0

REQUEST_ID= DOMAIN= LOG= VALID=0 ANSWERED=0
write_status() {
  STATE=$1 MESSAGE=$2 CURRENT=${3:-}
  python3 - "$STATUS" "$REQUEST_ID" "$STATE" "$DOMAIN" "$CURRENT" "$MESSAGE" <<'PY'
import json,sys,datetime,os,tempfile
file,request_id,state,desired,current,message=sys.argv[1:]
value={"requestId":request_id,"state":state,"desiredDomain":desired,"currentDomain":current,"message":message[:500],"updatedAt":datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')}
# The directory belongs to the container's user: the file is written and made readable through its
# descriptor, never by a name that user could have pointed elsewhere in the meantime.
descriptor,temp=tempfile.mkstemp(prefix='.host-domain-status.',dir=os.path.dirname(file))
try:
  os.fchmod(descriptor,0o644)
  with os.fdopen(descriptor,'w',encoding='utf-8') as stream: json.dump(value,stream,separators=(',',':')); stream.write('\n')
  os.replace(temp,file)
finally:
  if os.path.lexists(temp): os.unlink(temp)
PY
}
SERVED=$(sed -n 's#^LOCAL_PROXY_BASE_URL=https://\([^/]*\)/\{0,1\}$#\1#p' "$INSTALL_DIR/.env" 2>/dev/null | head -n1)
# From here on the request is gone when this script ends, whether a check below turns it away, a step
# fails under `set -e` or the work is done: while it is there the path unit starts the script again.
# (A signal that kills the shell is the exception: the request stays and is acted on after the restart.)
# And a request that got no last word (active or failed) is answered `failed` here, so that the panel
# does not show a switch in progress for ever: one that was turned away names no request.
finish(){
  if [ "$ANSWERED" != 1 ]; then
    if [ "$VALID" = 1 ]; then write_status failed "$HOST_REQUEST_BROKE_OFF" "$SERVED" 2>/dev/null || true
    else REQUEST_ID= DOMAIN=; write_status failed "$HOST_REQUEST_REFUSED" "$SERVED" 2>/dev/null || true; fi
  fi
  host_request_drop "$REQUEST"; [ -z "$LOG" ] || rm -f "$LOG"
}
trap finish EXIT

# The request comes from an unprivileged container, so it is read with care (host_request_fields) and
# every field is re-validated here before it reaches Nginx, certbot or .env. Anything unexpected ends
# the script instead of running the workflow.
FIELDS=$(host_request_fields "$REQUEST" requestId desiredDomain certificateEmail 2>/dev/null) || exit 1
field(){ printf '%s\n' "$FIELDS" | sed -n "$1p"; }
REQUEST_ID=$(field 1)
DOMAIN=$(field 2 | tr '[:upper:]' '[:lower:]')
EMAIL=$(field 3 | tr '[:upper:]' '[:lower:]')
value_matches "$REQUEST_ID" '^[A-Za-z0-9_-]{8,80}$' || exit 1
value_matches "$DOMAIN" '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$' || exit 1
email_ok "$EMAIL" || exit 1
VALID=1

write_status applying "正在申请证书并切换 Nginx" "$SERVED"
LOG=$(mktemp /tmp/aegis-domain.XXXXXX)
if "$INSTALL_DIR/scripts/configure-local-domain.sh" "$DOMAIN" "$EMAIL" >"$LOG" 2>&1; then
  write_status active "双域名配置已生效，旧代理域名已停用" "$DOMAIN"
  ANSWERED=1
  exit 0
fi
ERROR=$(tail -n 8 "$LOG" | tr '\n' ' ' | cut -c1-480)
write_status failed "${ERROR:-域名切换失败，请检查 DNS、Cloudflare 与 80/443 端口}" "$SERVED"
ANSWERED=1
exit 1
