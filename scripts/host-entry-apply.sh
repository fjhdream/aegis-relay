#!/bin/sh
# Serve the steering entry domain the panel asked for (docs/AUTO_STEERING.md §4) on this host. Started by
# a systemd path unit when the panel or agent container drops a request into its data directory:
#
#   host-entry-apply.sh /opt/aegis-relay        (panel machine)
#   host-entry-apply.sh /opt/aegis-relay-agent  (agent machine)
set -eu
umask 077
INSTALL_DIR=${1:-}
case "$INSTALL_DIR" in /opt/aegis-relay|/opt/aegis-relay-agent) ;; *) echo "unknown install directory" >&2; exit 1 ;; esac
REQUEST="$INSTALL_DIR/data/host-entry-request.json"
STATUS="$INSTALL_DIR/data/host-entry-status.json"
CONFIGURE="$INSTALL_DIR/configure-entry-domain.sh"
[ -f "$CONFIGURE" ] || CONFIGURE="$INSTALL_DIR/scripts/configure-entry-domain.sh"

[ "$(id -u)" -eq 0 ] || exit 1
[ -f "$REQUEST" ] || exit 0

# The request comes from an unprivileged container, so every field is re-validated here before it
# reaches Nginx or certbot. Anything unexpected drops the request instead of running the workflow.
FIELDS=$(python3 - "$REQUEST" <<'PY'
import json,re,sys
DOMAIN=re.compile(r'^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$')
try:
  value=json.load(open(sys.argv[1],encoding='utf-8'))
  request_id=value.get('requestId'); entry=str(value.get('entryDomain','')).lower(); email=str(value.get('certificateEmail','')).lower()
  peers=value.get('peers'); attempt=value.get('attempt',1)
  assert isinstance(request_id,str) and re.fullmatch(r'[A-Za-z0-9_-]{8,80}',request_id)
  assert DOMAIN.match(entry)
  assert re.fullmatch(r'[^\s@]+@[^\s@]+',email) and len(email)<=254
  assert isinstance(peers,list) and len(peers)<=16
  peers=[str(peer).lower() for peer in peers]
  assert all(DOMAIN.match(peer) and peer!=entry for peer in peers)
  assert isinstance(attempt,int) and 1<=attempt<=1000
except Exception:
  sys.exit(1)
print(request_id); print(entry); print(email); print(attempt); print(' '.join(peers))
PY
) || { rm -f "$REQUEST"; exit 1; }
REQUEST_ID=$(printf '%s\n' "$FIELDS" | sed -n 1p)
ENTRY=$(printf '%s\n' "$FIELDS" | sed -n 2p)
EMAIL=$(printf '%s\n' "$FIELDS" | sed -n 3p)
ATTEMPT=$(printf '%s\n' "$FIELDS" | sed -n 4p)
PEERS=$(printf '%s\n' "$FIELDS" | sed -n 5p)

write_status() {
  python3 - "$STATUS" "$REQUEST_ID" "$1" "$ENTRY" "$PEERS" "$ATTEMPT" "$2" <<'PY'
import json,sys,datetime,os,tempfile
file,request_id,state,entry,peers,attempt,message=sys.argv[1:]
value={"requestId":request_id,"state":state,"entryDomain":entry,"peers":peers.split(),"attempt":int(attempt),"message":message[:500],"updatedAt":datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')}
descriptor,temp=tempfile.mkstemp(prefix='.host-entry-status.',dir=os.path.dirname(file))
try:
  with os.fdopen(descriptor,'w',encoding='utf-8') as stream: json.dump(value,stream,separators=(',',':')); stream.write('\n')
  os.chmod(temp,0o644); os.replace(temp,file)
finally:
  if os.path.exists(temp): os.unlink(temp)
PY
}

LOG=$(mktemp /tmp/aegis-entry-domain.XXXXXX)
write_status applying "正在配置入口域名并申请证书"
# shellcheck disable=SC2086 # PEERS is a validated, space-separated list of domains
if sh "$CONFIGURE" "$ENTRY" "$EMAIL" $PEERS >"$LOG" 2>&1; then
  write_status active "入口域名已生效，证书自动续期已启用"
  rm -f "$REQUEST" "$LOG"
  exit 0
fi
ERROR=$(tail -n 6 "$LOG" | tr '\n' ' ' | cut -c1-480)
write_status failed "${ERROR:-入口域名配置失败，请检查 DNS 与 80/443 端口}"
rm -f "$REQUEST" "$LOG"
exit 1
