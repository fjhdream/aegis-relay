#!/bin/sh
set -eu
umask 077
AEGIS_HERE=$(dirname "$0")
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
# From here on the request is gone however this script ends, by a check below, by a step that fails
# under `set -e`, or at the end of the work: while it is there the path unit starts the script again.
LOG=
finish(){ host_request_drop "$REQUEST"; [ -z "$LOG" ] || rm -f "$LOG"; }
trap finish EXIT

# The request comes from an unprivileged container, so it is read with care (host_request_fields) and
# every field is re-validated here before it reaches Nginx or certbot. Anything unexpected ends the
# script instead of running the workflow.
FIELDS=$(host_request_fields "$REQUEST" requestId desiredDomain certificateEmail 2>/dev/null) || exit 1
field(){ printf '%s\n' "$FIELDS" | sed -n "$1p"; }
REQUEST_ID=$(field 1)
DOMAIN=$(field 2 | tr '[:upper:]' '[:lower:]')
EMAIL=$(field 3 | tr '[:upper:]' '[:lower:]')
value_matches "$REQUEST_ID" '^[A-Za-z0-9_-]{8,80}$' || exit 1
value_matches "$DOMAIN" '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$' || exit 1
value_matches "$EMAIL" '^[^[:space:]@]+@[^[:space:]@]+$' || exit 1

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

CURRENT=$(sed -n 's#^LOCAL_PROXY_BASE_URL=https://\([^/]*\)/\?$#\1#p' "$INSTALL_DIR/.env" | head -n1)
write_status applying "正在申请证书并切换 Nginx" "$CURRENT"
LOG=$(mktemp /tmp/aegis-domain.XXXXXX)
if "$INSTALL_DIR/scripts/configure-local-domain.sh" "$DOMAIN" "$EMAIL" >"$LOG" 2>&1; then
  write_status active "双域名配置已生效，旧代理域名已停用" "$DOMAIN"
  exit 0
fi
ERROR=$(tail -n 8 "$LOG" | tr '\n' ' ' | cut -c1-480)
write_status failed "${ERROR:-域名切换失败，请检查 DNS、Cloudflare 与 80/443 端口}" "$CURRENT"
exit 1
