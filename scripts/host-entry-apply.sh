#!/bin/sh
# Serve the steering entry domain the panel asked for (docs/AUTO_STEERING.md §4) on this host. Started by
# a systemd path unit when the panel or agent container drops a request into its data directory:
#
#   host-entry-apply.sh /opt/aegis-relay        (panel machine)
#   host-entry-apply.sh /opt/aegis-relay-agent  (agent machine)
set -eu
umask 077
INSTALL_DIR=${1:-}
# Its own place, in full, and then away from wherever it was started: python puts the current
# directory on its module path, and a script run by hand from inside data/ (which belongs to the
# container) must not load what the container left there.
AEGIS_HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd /
# The library is in src/ under an agent's install directory and beside the panel's scripts/. Without it
# the request cannot be read safely; it must still not sit there re-triggering this unit, and its
# `pending` status goes too, so that the request is filed again instead of waited for.
if [ -f "$AEGIS_HERE/src/host-site.sh" ]; then . "$AEGIS_HERE/src/host-site.sh"
elif [ -f "$AEGIS_HERE/../src/host-site.sh" ]; then . "$AEGIS_HERE/../src/host-site.sh"
else
  case "$INSTALL_DIR" in /opt/aegis-relay|/opt/aegis-relay-agent) rm -rf -- "$INSTALL_DIR/data/host-entry-request.json" "$INSTALL_DIR/data/host-entry-status.json" 2>/dev/null || true ;; esac
  echo "src/host-site.sh is missing; update this machine" >&2; exit 1
fi
case "$INSTALL_DIR" in "$AEGIS_PANEL_DIR"|"$AEGIS_AGENT_DIR") ;; *) echo "unknown install directory" >&2; exit 1 ;; esac
REQUEST="$INSTALL_DIR/data/host-entry-request.json"
STATUS="$INSTALL_DIR/data/host-entry-status.json"
CONFIGURE="$INSTALL_DIR/configure-entry-domain.sh"
[ -f "$CONFIGURE" ] || CONFIGURE="$INSTALL_DIR/scripts/configure-entry-domain.sh"

[ "$(id -u)" -eq 0 ] || exit 1
[ -e "$REQUEST" ] || [ -L "$REQUEST" ] || exit 0

REQUEST_ID= ENTRY= PEERS= ATTEMPT=1 LOG= VALID=0 ANSWERED=0
write_status() {
  python3 - "$STATUS" "$REQUEST_ID" "$1" "$ENTRY" "$PEERS" "$ATTEMPT" "$2" <<'PY'
import json,sys,datetime,os,tempfile
file,request_id,state,entry,peers,attempt,message=sys.argv[1:]
value={"requestId":request_id,"state":state,"entryDomain":entry,"peers":peers.split(),"attempt":int(attempt),"message":message[:500],"updatedAt":datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')}
# The directory belongs to the container's user: the file is written and made readable through its
# descriptor, never by a name that user could have pointed elsewhere in the meantime.
descriptor,temp=tempfile.mkstemp(prefix='.host-entry-status.',dir=os.path.dirname(file))
try:
  os.fchmod(descriptor,0o644)
  with os.fdopen(descriptor,'w',encoding='utf-8') as stream: json.dump(value,stream,separators=(',',':')); stream.write('\n')
  os.replace(temp,file)
finally:
  if os.path.lexists(temp): os.unlink(temp)
PY
}
# From here on the request is gone when this script ends, whether a check below turns it away, a step
# fails under `set -e` or the work is done: while it is there the path unit starts the script again.
# (A signal that kills the shell is the exception: the request stays and is acted on after the restart.)
# And a request that got no last word (active or failed) is answered `failed` here, so that nobody
# waits for ever for an entry domain that is not being set up: one that was turned away names no
# request and no domain, and is filed again.
finish(){
  if [ "$ANSWERED" != 1 ]; then
    if [ "$VALID" = 1 ]; then write_status failed "$HOST_REQUEST_BROKE_OFF" 2>/dev/null || true
    else REQUEST_ID= ENTRY= PEERS= ATTEMPT=1; write_status failed "$HOST_REQUEST_REFUSED" 2>/dev/null || true; fi
  fi
  host_request_drop "$REQUEST"; [ -z "$LOG" ] || rm -f "$LOG"
}
trap finish EXIT

# The request comes from an unprivileged container, so it is read with care (host_request_json) and
# every field is re-validated here before it reaches Nginx, certbot or .env. Anything unexpected ends
# the script instead of running the workflow. Each value is matched whole (fullmatch: `$` would let a
# trailing line break through, and the fields below are told apart by their lines), and by a check
# that python cannot be told to skip, as it can an assert.
FIELDS=$(host_request_json "$REQUEST" 2>/dev/null | python3 -c '
import json, re, sys
DOMAIN = re.compile(r"(?=.{1,253}\Z)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?")
def need(fine):
    if not fine:
        raise ValueError
try:
    value = json.load(sys.stdin)
    request_id = value.get("requestId"); entry = str(value.get("entryDomain", "")).lower(); email = str(value.get("certificateEmail", "")).lower()
    peers = value.get("peers"); attempt = value.get("attempt", 1)
    need(isinstance(request_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{8,80}", request_id))
    need(DOMAIN.fullmatch(entry))
    need(re.fullmatch(r"[A-Za-z0-9!%&*+/=?^_{|}~.][A-Za-z0-9!#%&\x27*+/=?^_{|}~.-]*@[A-Za-z0-9.-]+", email, re.ASCII) and len(email) <= 254)  # email_ok in src/host-site.sh
    need(isinstance(peers, list) and len(peers) <= 16)
    peers = [str(peer).lower() for peer in peers]
    need(all(DOMAIN.fullmatch(peer) and peer != entry for peer in peers))
    need(type(attempt) is int and 1 <= attempt <= 1000)
except Exception:
    sys.exit(1)
print(request_id); print(entry); print(email); print(attempt); print(" ".join(peers))
') || exit 1
REQUEST_ID=$(printf '%s\n' "$FIELDS" | sed -n 1p)
ENTRY=$(printf '%s\n' "$FIELDS" | sed -n 2p)
EMAIL=$(printf '%s\n' "$FIELDS" | sed -n 3p)
ATTEMPT=$(printf '%s\n' "$FIELDS" | sed -n 4p)
PEERS=$(printf '%s\n' "$FIELDS" | sed -n 5p)
VALID=1

LOG=$(mktemp /tmp/aegis-entry-domain.XXXXXX)
write_status applying "正在配置入口域名并申请证书"
# shellcheck disable=SC2086 # PEERS is a validated, space-separated list of domains
if sh "$CONFIGURE" "$ENTRY" "$EMAIL" $PEERS >"$LOG" 2>&1; then
  SUCCESS=$(tail -n 1 "$LOG")
  write_status active "${SUCCESS:-入口域名已生效}"
  ANSWERED=1
  exit 0
fi
ERROR=$(tail -n 6 "$LOG" | tr '\n' ' ' | cut -c1-480)
write_status failed "${ERROR:-入口域名配置失败，请检查 DNS 与 80/443 端口}"
ANSWERED=1
exit 1
