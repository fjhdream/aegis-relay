import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { pipeline, Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import dnsPromises from 'node:dns/promises';
import { isPrivateIP } from './security.js';
import { isRouteAuthKey, matchRouteChannel } from './route-auth.js';
import { ThrottleTransform } from './metrics.js';
import { itemOf, relayedEgress, stripSteerParam } from './steering.js';
import { answerLineRequest, lineSyncAuthPath } from './line-sync.js';
import { hopFree, MEDIA_REUSED_PROBATION_MS, MEDIA_STALL_TIMEOUT_MS, RELAY_HIGH_WATER_MARK, routeUpstreams, streamRewriteDomains, UpstreamExchange } from './upstream-exchange.js';

// The relay's request policy: which node a request is for, whether it may be served (key, quota),
// where it goes (steering, line sync, continuations), and what the client gets back (redirect and
// stream-URL rewriting, speed limits, the invisible media resume). How a request reaches the upstream
// is upstream-exchange.js's business.

const RELAY_REDIRECT_SEGMENT = '.aegis-relay';
// Front/back-split Emby servers hand the client a stream URL on a *different* domain than the one it
// logged in through. We rewrite those absolute URLs in text/API responses to route through this
// relay under a dedicated path so the client never leaves our domain, and proxy the path back to the
// real stream domain. Only operator-declared stream hosts are ever reachable through it (SSRF guard).
const RELAY_VOD_SEGMENT = '.aegis-vod';
export const RELAY_SERVER_OPTIONS=Object.freeze({highWaterMark:RELAY_HIGH_WATER_MARK,noDelay:true,keepAlive:true,keepAliveInitialDelay:15_000});
// Who is using a node — for the operator to spot a relay that has been redistributed. The real client
// IP comes from the X-Real-IP the fronting Nginx sets (the relay strips it before going upstream, so
// the upstream never sees it); the device fields come from the Emby headers / auth line / query.
const clipText=(v,n=80)=>String(v||'').replace(/[\r\n\0]/g,'').trim().slice(0,n);
const firstForwarded=v=>String(v||'').split(',')[0].trim();
function hasViewerIdentity(req,incoming){ const h=req.headers,q=incoming.searchParams; return !!(h['x-emby-authorization']||h['x-emby-token']||h.authorization||q.get('api_key')||q.get('X-Emby-Token')||q.get('X-MediaBrowser-Token')); }
function accessInfoFrom(req,incoming){
  const h=req.headers;
  const ip=firstForwarded(h['x-real-ip'])||firstForwarded(h['x-forwarded-for'])||String(req.socket?.remoteAddress||'').replace(/^::ffff:/,'');
  if(!ip)return null;
  const auth=String(h['x-emby-authorization']||h.authorization||''),q=incoming.searchParams;
  const field=re=>{const m=auth.match(re);return m?m[1]:'';};
  return { ip:clipText(ip,45),
    deviceName:clipText(h['x-emby-device-name']||field(/Device="([^"]*)"/i)||q.get('X-Emby-Device-Name')||''),
    client:clipText(h['x-emby-client']||field(/Client="([^"]*)"/i)||q.get('X-Emby-Client')||''),
    deviceId:clipText(h['x-emby-device-id']||field(/DeviceId="([^"]*)"/i)||q.get('X-Emby-Device-Id')||q.get('DeviceId')||''),
    ua:clipText(h['user-agent']||'',160) };
}
// The first slice of a body is the ramp-up window where "only a few dozen KiB then it won't speed up"
// shows itself; past it a reused socket has proven healthy and reverts to the normal stall timeout.
const MEDIA_STARTUP_BYTES=512*1024;
// Consecutive resume attempts allowed *without meaningful forward progress*. The budget is refunded
// only after the stream advances at least MEDIA_RESUME_PROGRESS_BYTES (see deliverResumable), so a long
// movie tolerates unlimited real hiccups while an origin that trickles a few bytes per socket cannot
// spin the resume loop forever.
const MEDIA_RESUME_ATTEMPTS=3;
const MEDIA_RESUME_PROGRESS_BYTES=512*1024;
// Absolute safety rails independent of progress, all scoped to a single client playback request: bound
// the resume frequency and the lifetime total so even an origin advancing >512 KiB each time cannot
// reopen sockets without limit.
const MEDIA_RESUME_PER_MINUTE=8;
const MEDIA_RESUME_TOTAL_CAP=48;

const safeMethod = method => method === 'GET' || method === 'HEAD';
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const routesFrom = source => typeof source?.getRoutes==='function'?source.getRoutes():source?.data?.routes||[];

export function stripAdminSetCookies(headers) {
  const current=headers['set-cookie'];
  if(!current)return headers;
  const safe=(Array.isArray(current)?current:[current]).filter(value=>!/^\s*aegis_session=/i.test(String(value)));
  if(!safe.length)delete headers['set-cookie'];else headers['set-cookie']=safe;
  return headers;
}

function parseUpstreamList(value) {
  const values = (Array.isArray(value) ? value : String(value || '').split(/[;\n]+/)).map(v => String(v).trim()).filter(Boolean);
  if (!values.length) throw new Error('at least one upstream is required');
  if (values.length > 8) throw new Error('a node supports at most 8 upstreams');
  return [...new Set(values)];
}

export async function validateUpstream(value, allowPrivate = false) {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('upstream must be http(s) without credentials');
  if (u.search || u.hash) throw new Error('upstream must not include a query or fragment');
  const answers = await dnsPromises.lookup(u.hostname, { all: true });
  if (!answers.length) throw new Error('upstream DNS has no records');
  if (!allowPrivate && answers.some(a => isPrivateIP(a.address))) throw new Error('private, loopback and link-local upstreams are blocked');
  return u.toString().replace(/\/$/, '');
}

export async function validateUpstreamList(value, allowPrivate = false) {
  const list = parseUpstreamList(value), result = [];
  for (const item of list) result.push(await validateUpstream(item, allowPrivate));
  return result;
}

function isPlaybackPath(pathname) {
  return /\/(?:emby\/)?(?:Videos|Audio|LiveTV)\//i.test(pathname) || !!itemOf(pathname);
}

function contentRange(value) {
  const match=/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value||'').trim());
  if(!match)return null;
  const start=Number(match[1]),end=Number(match[2]),total=match[3]==='*'?null:Number(match[3]);
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end<start||total!==null&&(!Number.isSafeInteger(total)||total<=end))return null;
  return {start,end,total};
}

// A response can be resumed invisibly only when its exact remaining byte interval is known. We keep
// the original downstream headers/status and append validated 206 bodies behind them.
function mediaResumePlan(method,status,headers) {
  if(String(method).toUpperCase()!=='GET'||![200,206].includes(status))return null;
  const length=Number(headers['content-length']);
  if(!Number.isSafeInteger(length)||length<=0||String(headers['content-encoding']||'identity').toLowerCase()!=='identity')return null;
  if(status===206){
    const range=contentRange(headers['content-range']);
    if(!range||range.end-range.start+1!==length)return null;
    return {...range,length,validator:String(headers.etag||headers['last-modified']||'')};
  }
  return {start:0,end:length-1,total:length,length,validator:String(headers.etag||headers['last-modified']||'')};
}

function compatibleResume(status,headers,plan,next) {
  const range=contentRange(headers['content-range']),length=Number(headers['content-length']);
  if(status!==206||!range||range.start!==next||range.end>plan.end||!Number.isSafeInteger(length)||length!==range.end-range.start+1)return false;
  if(plan.validator){const current=String(headers.etag||headers['last-modified']||'');if(current&&current!==plan.validator)return false;}
  return true;
}

// stall is the idle-watchdog duration for this leg; a function so the caller can shorten it during the
// reused-socket startup window and widen it once the stream has proven healthy.
function waitForDrain(res,source,stall) {
  return new Promise((resolve,reject)=>{
    const restore=(typeof stall==='function'?stall():stall)??MEDIA_STALL_TIMEOUT_MS;
    const cleanup=()=>{res.off('drain',drain);res.off('close',closed);res.off('error',failed)};
    const drain=()=>{cleanup();source?.socket?.setTimeout?.(restore);resolve()};
    const closed=()=>{cleanup();reject(Object.assign(new Error('client closed'),{code:'ECLIENTGONE'}))};
    const failed=error=>{cleanup();reject(error)};
    // A paused/slow client is legitimate backpressure, not an upstream stall. Suspend the source
    // idle watchdog until Nginx/the client can accept more bytes.
    source?.socket?.setTimeout?.(0);
    res.once('drain',drain);res.once('close',closed);res.once('error',failed);
  });
}

async function pumpMedia(source,res,onBytes,stall) {
  let armed;
  // Re-arm only when the phase value actually changes (setTimeout on every chunk would be wasteful).
  const arm=()=>{ const v=typeof stall==='function'?stall():stall; if(v!==undefined&&v!==armed){armed=v;source?.socket?.setTimeout?.(v);} };
  arm();
  for await (const chunk of source) {
    if(res.destroyed)throw Object.assign(new Error('client closed'),{code:'ECLIENTGONE'});
    if(!chunk.length)continue;
    if(!res.write(chunk))await waitForDrain(res,source,stall);
    onBytes(chunk.length);
    arm();
  }
}

function accessPrefix(route, suppliedKey = '') {
  return route.accessMode === 'alias_only' ? `/${route.alias}` : `/${route.alias}/${suppliedKey}`;
}

function routeFor(pathname, routes, key) {
  const parts = pathname.split('/').filter(Boolean);
  const offset = parts[0] === 'r' ? 1 : 0;
  const route = routes.find(r => r.enabled && r.alias === parts[offset]);
  if (!route) return null;
  if (route.accessMode === 'alias_only') return { route, rest:`/${parts.slice(offset + 1).join('/')}`, suppliedKey:'', prefix:accessPrefix(route), channelId:'default' };
  if (parts.length <= offset + 1) return null;
  const suppliedKey = parts[offset + 1], channel = matchRouteChannel(route, suppliedKey, key);
  if (!channel) return null;
  return { route, rest:`/${parts.slice(offset + 2).join('/')}`, suppliedKey, prefix:accessPrefix(route, suppliedKey), channelId:channel.id };
}

// Writing to a response the client already dropped throws and would take the process down.
function failResponse(res, status, body) {
  if (res.headersSent || res.destroyed || res.writableEnded) return;
  try { res.writeHead(status,{'cache-control':'no-store','content-type':'text/plain; charset=utf-8'}); res.end(body); } catch {}
}

function publicIndex(routes) {
  const visible=routes.filter(r=>r.enabled&&r.showOnHome);
  const cards=visible.map(r=>`<li><strong>${escapeHtml(r.name||r.alias)}</strong><code>/${escapeHtml(r.alias)}/${r.accessMode==='alias_only'?'':'••••••/'}</code><span>${r.accessMode==='alias_only'?'公开别名':'需要访问密钥'}</span></li>`).join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>AegisRelay 节点</title><style>body{max-width:720px;margin:60px auto;padding:0 20px;background:#08111e;color:#e8eef8;font:16px system-ui}h1{color:#54d1b2}ul{padding:0}li{list-style:none;border:1px solid #24344b;border-radius:12px;padding:18px;margin:12px 0;background:#111d2e}strong,code,span{display:block;margin:5px 0}code{color:#54d1b2}span{color:#91a0b7;font-size:13px}</style><h1>AegisRelay</h1><p>可用 Emby 节点</p><ul>${cards||'<li>暂无公开展示的节点</li>'}</ul></html>`;
}

// Resolve a /.aegis-vod/<scheme>/<host>/<rest> request back to the real stream domain. The scheme is
// the upstream transport (http|https) and the host must be one the operator declared for this node —
// anything else is rejected so the path can't be turned into an open proxy. Returns null when the
// request is not a stream-relay path.
function vodTarget(found, search) {
  const rest=found.rest||'', marker=`/${RELAY_VOD_SEGMENT}/`;
  if(!rest.startsWith(marker))return null;
  const allowed=streamRewriteDomains(found.route);
  if(!allowed.length)throw new Error('stream rewrite disabled');
  const seg=rest.slice(marker.length).split('/');
  const scheme=(seg[0]||'').toLowerCase(), token=(seg[1]||'').toLowerCase(), name=token.split(':')[0];
  if(scheme!=='http'&&scheme!=='https')throw new Error('invalid stream scheme');
  if(!token||!(allowed.includes(token)||allowed.includes(name)))throw new Error('stream host not allowed');
  const target=new URL(`${scheme}://${token}`);
  if(target.username||target.password||target.pathname!=='/'||target.hostname!==name)throw new Error('invalid stream host');
  target.pathname='/'+seg.slice(2).join('/'); target.search=search||'';
  return {target,token};
}
// The stream-URL pattern a route derives (null when the feature is off). Snapshot routes
// (AtomicRouteSource) are deep-frozen and replaced wholesale on every apply, so a frozen route is
// derived once instead of on every request; a mutable route object is derived afresh each time.
const rewritePatterns=new WeakMap();
function rewritePattern(route) {
  if(rewritePatterns.has(route))return rewritePatterns.get(route);
  const domains=streamRewriteDomains(route);
  let pattern=null;
  if(domains.length){
    const alt=domains.map(d=>d.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
    // Longest possible match: scheme + longest declared host + ":65535". Carry this many trailing chars
    // between chunks so a URL split across chunk boundaries is never mis-emitted.
    pattern={regex:new RegExp('(https?|wss?):\\/\\/('+alt+')(:\\d+)?(?=[/"\'?#\\\\]|$)','g'),keep:Math.max(...domains.map(d=>d.length))+16};
  }
  if(Object.isFrozen(route))rewritePatterns.set(route,pattern);
  return pattern;
}
// A text/manifest rewriter that turns absolute stream-domain URLs into paths on this relay, or null
// when the feature is off or the public host is unknown. Scheme-qualified and boundary-guarded so a
// declared host is never matched as a suffix of a lookalike domain (e.g. vod.example inside
// vod.example.evil). The upstream scheme is preserved in the path; ws/wss map to the relay's own
// websocket scheme so live sockets stay on our domain too.
function buildStreamRewriter(pattern, publicContext, prefix) {
  if(!pattern||!publicContext.host)return null;
  const base=`${publicContext.proto}://${publicContext.host}${prefix}/${RELAY_VOD_SEGMENT}/`;
  const wsBase=`${publicContext.proto==='https'?'wss':'ws'}://${publicContext.host}${prefix}/${RELAY_VOD_SEGMENT}/`;
  const replacer=m=>{ const s=m[1].toLowerCase(), secure=s==='https'||s==='wss', ws=s==='ws'||s==='wss';
    return (ws?wsBase:base)+(secure?'https':'http')+'/'+m[2]+(m[3]||''); };
  // One global regex serves every response on the route. Sharing it is safe: each use runs to completion
  // synchronously from lastIndex 0 (StreamRewrite resets it; String#replace does so itself).
  return { regex:pattern.regex, replacer, keep:pattern.keep };
}
function isRewritableType(contentType) {
  const ct=String(contentType||'').toLowerCase();
  return /^text\//.test(ct) || /(json|xml|javascript|ecmascript|mpegurl|dash\+xml)/.test(ct);
}
function isManifestResponse(contentType, pathname='') {
  const ct=String(contentType||'').toLowerCase(),path=String(pathname||'').toLowerCase();
  return /(mpegurl|dash\+xml)/.test(ct)||/\.(?:m3u8|mpd)(?:$|[?#])/i.test(path);
}
// A playback URL is a byte stream unless it is unmistakably an HLS/DASH manifest. Some Emby/CDN
// stacks return a first, non-Range media response as HTTP 200 and occasionally mislabel it as
// text/plain or application/json. Sending that body through StringDecoder/RegExp corrupts bytes,
// burns CPU and throttles the stream. Keep the entire media path zero-copy by default; API responses
// such as PlaybackInfo are not classified as playback and remain eligible for URL rewriting.
export function shouldRewriteStreamBody({method='GET',status=200,headers={},playback=false,pathname=''}) {
  if(String(method).toUpperCase()==='HEAD'||headers.range||headers['content-range']||status===206||status===204||status===304)return false;
  if(!isRewritableType(headers['content-type']))return false;
  if(playback&&!isManifestResponse(headers['content-type'],pathname))return false;
  return true;
}
// A streaming stream-URL rewriter. It never buffers the whole body — it rewrites matches as bytes
// flow through and only holds back a short tail (a possible partial URL at a chunk boundary), so the
// client starts receiving the response immediately. This keeps playback start fast and can never
// stall a stream, even if a body is large or a response is misclassified as rewritable.
class StreamRewrite extends Transform {
  constructor({regex,replacer,keep}){ super(); this.regex=regex; this.replacer=replacer; this.keep=keep; this.decoder=new StringDecoder('utf8'); this.carry=''; }
  _transform(chunk,_enc,cb){
    const s=this.carry+this.decoder.write(chunk);
    if(s.length<=this.keep){ this.carry=s; return cb(); }
    const safe=s.length-this.keep; this.regex.lastIndex=0;
    let out='',lastEnd=0,m;
    while((m=this.regex.exec(s))){
      if(m.index>=safe)break;              // starts in the carry zone — might be incomplete, defer it
      out+=s.slice(lastEnd,m.index)+this.replacer(m); lastEnd=m.index+m[0].length;
    }
    const emitEnd=Math.max(lastEnd,safe);
    out+=s.slice(lastEnd,emitEnd); this.carry=s.slice(emitEnd);
    if(out)this.push(out); cb();
  }
  _flush(cb){ const s=this.carry+this.decoder.end(); this.regex.lastIndex=0; this.push(s.replace(this.regex,(...a)=>this.replacer(a))); cb(); }
}
// Streaming decompressor matched to the body's encoding, or null for identity/none. Undefined return
// means an encoding we can't decode — the caller then streams the body through untouched.
function decompressor(encoding){
  const e=String(encoding||'').toLowerCase();
  if(!e||e==='identity')return null;
  if(e==='gzip'||e==='x-gzip')return zlib.createGunzip();
  if(e==='deflate')return zlib.createInflate();
  if(e==='br')return zlib.createBrotliDecompress();
  return undefined;
}

function externalRedirectPath(location, base) {
  const basePath=base.pathname.replace(/\/$/,'');
  if(basePath&&basePath!=='/'&&(location.pathname===basePath||location.pathname.startsWith(`${basePath}/`))){
    return location.pathname.slice(basePath.length)||'/';
  }
  if(!basePath||basePath==='/')return location.pathname;
  return null;
}

function redirectSecret(route, appKey) {
  if(isRouteAuthKey(route.routeAuthKey))return Buffer.from(route.routeAuthKey,'base64url');
  if(Buffer.isBuffer(appKey)&&appKey.length===32)return appKey;
  throw new Error('redirect relay key unavailable');
}

function redirectAad(route) {
  return Buffer.from(`AegisRelay:redirect:v1:${route.id||route.alias}`,'utf8');
}

function sealRedirectTarget(route, target, appKey, playback, source) {
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',redirectSecret(route,appKey),iv);
  cipher.setAAD(redirectAad(route));
  const encrypted=Buffer.concat([cipher.update(JSON.stringify({target:target.href,playback:playback===true,...(playback&&source?{source}:{})}),'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64url');
}

function openRedirectTarget(route, token, appKey) {
  const payload=Buffer.from(String(token||''),'base64url');
  if(payload.length<29||payload.toString('base64url')!==token)throw new Error('invalid redirect relay token');
  const decipher=crypto.createDecipheriv('aes-256-gcm',redirectSecret(route,appKey),payload.subarray(0,12));
  decipher.setAAD(redirectAad(route));decipher.setAuthTag(payload.subarray(12,28));
  const decoded=JSON.parse(Buffer.concat([decipher.update(payload.subarray(28)),decipher.final()]).toString('utf8'));
  const target=new URL(decoded.target);
  if(!['http:','https:'].includes(target.protocol)||target.username||target.password)throw new Error('invalid redirect relay target');
  return {target,playback:decoded.playback===true,source:typeof decoded.source==='string'?decoded.source:null};
}

function continuationTarget(found, appKey) {
  const parts=found.rest.split('/').filter(Boolean);
  if(parts[0]!==RELAY_REDIRECT_SEGMENT)return null;
  if(parts.length!==2)throw new Error('invalid redirect relay path');
  return openRedirectTarget(found.route,parts[1],appKey);
}

function publicRelayLocation(found, target, context, appKey, playback, source) {
  const token=sealRedirectTarget(found.route,target,appKey,playback,source),path=`${found.prefix}/${RELAY_REDIRECT_SEGMENT}/${token}`;
  return context.host?`${context.proto}://${context.host}${path}`:path;
}

function publicRequestContext(req) {
  const host=String(req.headers.host||'').trim();
  const forwarded=String(req.headers['x-forwarded-proto']||'').split(',')[0].trim().toLowerCase();
  const proto=forwarded==='https'||forwarded==='http'?forwarded:(req.socket.encrypted?'https':'http');
  return {host,proto};
}

function cleanResponseHeaders(input) {
  const out=hopFree(input); delete out.server; delete out.via; delete out['x-powered-by'];
  stripAdminSetCookies(out);out['referrer-policy']='no-referrer'; out['x-content-type-options']='nosniff'; return out;
}
// Header block for a response hand-written onto a hijacked upgrade socket. Multi-value headers go out
// one line each: joining Set-Cookie values with commas corrupts the cookies.
function rawHeaderBlock(headers) {
  return Object.entries(headers).flatMap(([k,v])=>v===undefined?[]:(Array.isArray(v)?v:[v]).map(item=>`${k}: ${item}\r\n`)).join('');
}

export function makeProxyHandler(routeSource, key, metrics = null, steering = null) {
  return async (req, res) => {
    const incoming=new URL(req.url,'http://relay.invalid');
    if (req.method==='GET' && (incoming.pathname==='/' || incoming.pathname==='/index.html' || incoming.pathname==='/gateway' || incoming.pathname==='/gateway/')) {
      res.writeHead(200, { 'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','x-frame-options':'DENY','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" });
      return res.end(publicIndex(routesFrom(routeSource)));
    }
    const found=routeFor(incoming.pathname,routesFrom(routeSource),key);
    if (!found) { res.writeHead(404,{'cache-control':'no-store'}); return res.end('not found'); }
    const {route}=found;
    // Unified egress: this machine hands the client's own path, untouched, to the node's egress machine,
    // which serves the same node and checks the same key; the upstream only ever sees that machine. The
    // egress machine resolves .aegis-relay/.aegis-vod links itself, so they are passed on unread here.
    const egress=route.egress?.base?route.egress:null;
    // Or the other way round: this is the egress machine, and another machine relayed the request.
    const relayed=egress?null:relayedEgress(route,req.headers,Date.now());
    // Line sync (see line-sync.js): answered here with the node's own lines once the upstream accepts
    // the client's token. A node that does not share its lines answers 404 like a stock Emby server,
    // instead of passing on the upstream's. A line request relayed by another machine is that machine's
    // to answer: it is fetching the upstream's own list, so it goes on untouched.
    const lineRest=found.rest,lineAuth=!relayed&&req.method==='GET'&&Array.isArray(route.lines)?lineSyncAuthPath(lineRest):null;
    if (lineAuth&&!route.lines.length&&route.lineSyncUpstream!==true) { res.writeHead(404,{'cache-control':'no-store'}); return res.end('not found'); }
    // The steering token is addressed to this relay; it never reaches an upstream.
    const search=stripSteerParam(incoming.search);
    let continuation, vod;
    if(!egress){
      try { continuation=continuationTarget(found,key); vod=vodTarget(found,search); }
      catch { res.writeHead(404,{'cache-control':'no-store'});return res.end('not found'); }
    }
    const playback=continuation?.playback===true||!!vod||isPlaybackPath(found.rest)||(!!egress&&/\/\.aegis-(?:relay|vod)\//.test(found.rest));
    // CDN URLs often contain no item/session identifiers. Keep the original stream URL inside the
    // encrypted continuation so range requests and peer redirects remain one playback session.
    const playbackSource=continuation?.source||`${found.rest}${search}`;
    // A relayed request was counted, logged and quota-checked by the machine the client talks to.
    if(!relayed&&metrics&&!metrics.canServe(route)){res.writeHead(509,{'cache-control':'no-store','retry-after':'3600'});return res.end('monthly traffic quota exceeded');}
    const metricDone=relayed?null:metrics?.begin(route,{playback,bytesIn:Number(req.headers['content-length']||0)});
    // Log the viewer (IP + device) once per identifiable request, before the client IP is stripped.
    if (!relayed && metrics && (playback || hasViewerIdentity(req,incoming))) { const info=accessInfoFrom(req,incoming); if(info){ info.channelId=found.channelId||'default'; metrics.recordAccess(route,info); } }
    if (!egress&&!continuation&&!vod&&!routeUpstreams(route).length) { metricDone?.(502,0,true);res.writeHead(502,{'cache-control':'no-store'}); return res.end('no upstream available'); }
    // The upstream builds its redirects for the host the client used. A relayed request is answered for
    // the host and scheme the client actually used, so every link it carries leads back to that machine.
    const publicContext=relayed?{host:relayed.host,proto:relayed.proto}:publicRequestContext(req);
    // Automatic steering: serve here, or send this playback request to a peer machine's direct domain.
    const steer=playback&&!relayed&&route.steering&&steering?steering.plan({route,found,req,incoming,publicContext,source:continuation?.source?new URL(continuation.source,'http://relay.invalid'):undefined}):null;
    if (steer?.redirect) { metricDone?.(302,0,false); res.writeHead(302,{location:steer.redirect,'cache-control':'no-store','referrer-policy':'no-referrer'}); return res.end(); }
    const track=steer?.track||null;
    track?.attach(res);
    const exchange=new UpstreamExchange({route,prefix:found.prefix,egress,publicContext,clientHeaders:req.headers,method:req.method,playback});
    // Prepared only when the node opts into stream-URL rewriting; null (no effect) otherwise. We do
    // NOT touch Accept-Encoding here — the media path and every non-rewritten response keep their
    // normal compression, so playback speed on a rewrite-enabled node matches one without it.
    const rewriter=egress?null:buildStreamRewriter(rewritePattern(route),publicContext,found.prefix);
    // Emby clients abort constantly (seeking, stopping, backgrounding). Nginx tears the upstream
    // down with the client; without this the upstream kept streaming into a dead socket and leaked
    // sockets and memory until the process fell over.
    let clientGone=false;
    const releaseClient=()=>{ if(clientGone||res.writableFinished)return; clientGone=true; exchange.abort(); };
    res.on('close',releaseClient);
    res.on('error',()=>{});
    req.on('error',()=>{});
    // No line answered at all: say why, unless the client has already gone.
    const unanswered=error=>{
      if(error?.aborted){metricDone?.(499,0,false);return;}
      metricDone?.(502,0,true);failResponse(res,502,`Bad Gateway\n${error?.reason||'上游连接失败'}`);
    };
    if(lineAuth){
      let reply;
      try { reply=await answerLineRequest({exchange,route,prefix:found.prefix,authRest:lineAuth,lineRest,search}); }
      catch(error) { return unanswered(error); }
      if(res.destroyed||res.headersSent){metricDone?.(reply.status,0,false);return;}
      metricDone?.(reply.status,reply.body.length,reply.status>=500);res.writeHead(reply.status,reply.headers);return res.end(reply.body);
    }
    let upstream;
    try {
      const opening=exchange.open({rest:found.rest,search,target:continuation?.target||vod?.target||null,headers:steer?.range?{range:steer.range}:null,body:safeMethod(req.method)?null:req});
      if(!safeMethod(req.method)&&!relayed)steering?.observeProgress?.(req,incoming,found);
      upstream=await opening;
    } catch(error) { return unanswered(error); }
    const status=upstream.status,target=upstream.target,base=new URL(upstream.line),upRes=upstream.body;
    const out=cleanResponseHeaders(upstream.headers);
    // The egress machine already built its links for this machine's public host.
    if (out.location && !egress) {
      try {
        const loc=new URL(out.location,target);
        if(!['http:','https:'].includes(loc.protocol)||loc.username||loc.password)delete out.location;
        else if(!continuation&&!vod&&loc.origin===base.origin){
          const redirectedPath=externalRedirectPath(loc,base);
          // Keep ordinary login/navigation redirects readable. A redirect outside the configured
          // upstream base is wrapped below so the client must return through this relay.
          out.location=redirectedPath===null?publicRelayLocation(found,loc,publicContext,key,playback,playbackSource):(publicContext.host?`${publicContext.proto}://${publicContext.host}${found.prefix}${redirectedPath}${loc.search}${loc.hash}`:`${found.prefix}${redirectedPath}${loc.search}${loc.hash}`);
        }
        else out.location=publicRelayLocation(found,loc,publicContext,key,playback,playbackSource);
      }
      catch { delete out.location; }
    }
    track?.headers(status,out);
    if (res.destroyed || res.headersSent) { upstream.destroy(); metricDone?.(status,0,false); return; }
    const speed=Number(route.speedLimitMbps||0);
    let measured=false,streamed=0;
    const finishMetric=(failed=false)=>{if(measured)return;measured=true;metricDone?.(status,metricDone?.addBytes?0:streamed,failed||status>=500)};
    // pipeline (unlike .pipe) tears every stream down on failure and never leaves a dangling
    // half-open response. Short API responses return to the API pool; media responses are
    // intentionally one-shot so the next segment/seek cannot inherit a poisoned connection.
    // pipe upRes through any transforms, then to the client. `stages` is [source, ...transforms];
    // nothing is ever fully buffered, so the client starts receiving bytes immediately.
    const deliver=(...stages)=>{
      res.writeHead(status,out);
      res.flushHeaders?.();
      const done=err=>{ if(err)upstream.destroy(); finishMetric(); };
      const tail=stages[stages.length-1];
      if(speed>0){
        const counter=new ThrottleTransform(speed*1024*1024/8,bytes=>{streamed+=bytes;metricDone?.addBytes?.(bytes);track?.bytes(bytes)});
        pipeline(...stages,counter,res,done);
      }else{
        // No rate limit means no throttling transform. Count bytes off the last stage (what the
        // client actually receives) with a listener instead of parking a transform in the path.
        // Attach pipeline first: adding a data listener puts a pre-buffered IncomingMessage into
        // flowing mode, so the destination must already be subscribed before accounting begins.
        pipeline(...stages,res,done);
        tail.on('data',chunk=>{streamed+=chunk.length;metricDone?.addBytes?.(chunk.length);track?.bytes(chunk.length)});
      }
    };
    const deliverResumable=(source,plan)=>{
      res.writeHead(status,out);res.flushHeaders?.();
      // Only watchdog a byte-addressable body. During downstream backpressure pumpMedia disables
      // this timer, so a paused/slow viewer is not mistaken for a dead origin. The original leg may
      // be a warm pooled socket: give it the short probation leash until the stream ramps past the
      // startup window, so "a few dozen KiB then it hangs" is evicted fast and re-fetched clean.
      // A reopened leg always dials a fresh clean socket, so it keeps the full stall timeout.
      const sourceReused=upstream.reusedSocket;
      const sourceStall=()=>(sourceReused&&streamed<MEDIA_STARTUP_BYTES)?MEDIA_REUSED_PROBATION_MS:MEDIA_STALL_TIMEOUT_MS;
      const onBytes=bytes=>{streamed+=bytes;metricDone?.addBytes?.(bytes);track?.bytes(bytes)};
      const run=async()=>{
        let current=source,isSource=true,retries=0,lastError=null,marker=streamed,totalResumes=0;
        const resumeTimes=[];
        while(!clientGone&&!res.destroyed&&streamed<plan.length){
          if(current){
            try{await pumpMedia(current,res,onBytes,isSource?sourceStall:MEDIA_STALL_TIMEOUT_MS);lastError=null;}
            catch(error){lastError=error;}
            current=null;isSource=false;
          }
          if(streamed>=plan.length)break;
          // Refund the no-progress budget only after real progress (>=512 KiB), so an origin
          // dribbling a few bytes per socket cannot keep buying it back; a long movie with scattered
          // real stalls still never runs out and drops the stream.
          if(streamed-marker>=MEDIA_RESUME_PROGRESS_BYTES){retries=0;marker=streamed;}
          const nowMs=Date.now();
          while(resumeTimes.length&&nowMs-resumeTimes[0]>=60_000)resumeTimes.shift();
          // Any hard rail hit means the origin is pathological — break to the terminal branch, which
          // destroys the response so the player sees a real disconnect and reconnects, never a fake
          // completed end.
          if(retries>=MEDIA_RESUME_ATTEMPTS||totalResumes>=MEDIA_RESUME_TOTAL_CAP||resumeTimes.length>=MEDIA_RESUME_PER_MINUTE)break;
          const next=plan.start+streamed;retries++;totalResumes++;resumeTimes.push(nowMs);
          try{current=await upstream.reopen({from:next,to:plan.end,validator:plan.validator,accept:(resumeStatus,headers)=>compatibleResume(resumeStatus,cleanResponseHeaders(headers),plan,next)});}
          catch(error){lastError=error;}
        }
        if(clientGone||res.destroyed){finishMetric();return;}
        if(streamed===plan.length){res.end();finishMetric();return;}
        const error=lastError||Object.assign(new Error('upstream media ended before content-length'),{code:'ECONNRESET'});
        upstream.failed(error);finishMetric(true);
        if(!res.destroyed)res.destroy(error);
      };
      run().catch(error=>{upstream.failed(error);finishMetric(true);if(!res.destroyed)res.destroy(error)});
    };
    // The stream-URL rewrite only touches API bodies and explicit HLS/DASH manifests. Every other
    // playback response is passed straight through, including non-Range HTTP 200 bodies with a
    // wrong text/JSON MIME type. The rewrite itself streams and decompresses on the fly.
    const enc=out['content-encoding'];
    const rewriteBody=!!rewriter&&shouldRewriteStreamBody({method:req.method,status,headers:{...out,range:req.headers.range},playback,pathname:target.pathname});
    const gunzip=rewriteBody?decompressor(enc):null;
    if (rewriteBody && gunzip!==undefined) {
      // Length and encoding change as we rewrite/decompress, so drop them and let the response chunk.
      delete out['content-encoding']; delete out['content-length'];
      const rewrite=new StreamRewrite(rewriter);
      // pipeline (inside deliver) tears every stage down together if the decoder hits a mislabeled
      // body, so a bad response fails cleanly instead of stalling.
      deliver(...(gunzip?[upRes,gunzip,rewrite]:[upRes,rewrite]));
    } else {
      const resumePlan=playback&&speed<=0?mediaResumePlan(req.method,status,out):null;
      if(resumePlan)deliverResumable(upRes,resumePlan);else deliver(upRes);
    }
    // Read the HLS segment length off the playlist as it passes (after delivery is wired, so the
    // listener never switches the body into flowing mode ahead of the client).
    if(track?.kind==='manifest'&&status===200)track.manifest(upRes,enc);
    if(!playback&&!relayed)steering?.observePlaybackInfo?.(req,incoming,found,upRes);
  };
}

export function handleUpgrade(req, socket, head, routeSource, key) {
  const incoming=new URL(req.url,'http://relay.invalid'),found=routeFor(incoming.pathname,routesFrom(routeSource),key); if(!found)return socket.destroy();
  const relaySearch=incoming.search;
  // Through the node's egress machine, like every other request of the node (see makeProxyHandler).
  const egress=found.route.egress?.base?found.route.egress:null,relayed=egress?null:relayedEgress(found.route,req.headers,Date.now());
  // A rewritten live socket (wss://…/.aegis-vod/<host>/…) tunnels straight to the declared stream
  // host; otherwise use the node's primary upstream. An unknown/blocked stream host is dropped.
  let vod; if(!egress){ try { vod=vodTarget(found,relaySearch); } catch { return socket.destroy(); } }
  if(!egress&&!vod&&!routeUpstreams(found.route).length)return socket.destroy();
  const publicContext=relayed?{host:relayed.host,proto:relayed.proto}:publicRequestContext(req);
  const exchange=new UpstreamExchange({route:found.route,prefix:found.prefix,egress,publicContext,clientHeaders:req.headers,method:req.method});
  const up=exchange.upgrade({rest:found.rest,search:relaySearch,target:vod?.target||null,protocol:req.headers.upgrade});
  // Unhandled socket errors on either leg would surface as an uncaught exception and restart the
  // whole relay, and a client that vanished used to leave the upstream socket open forever.
  let clientGone=false;
  socket.on('error',()=>socket.destroy());
  socket.on('close',()=>{clientGone=true;exchange.abort()});
  up.on('upgrade',(r,s,h)=>{
    s.on('error',()=>s.destroy());
    if(clientGone||socket.destroyed)return s.destroy();
    const out={...cleanResponseHeaders(r.headers),connection:'Upgrade'};if(r.headers.upgrade)out.upgrade=r.headers.upgrade;
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${rawHeaderBlock(out)}\r\n`);
    if(h.length)socket.write(h);if(head.length)s.write(head);
    s.pipe(socket);socket.pipe(s);
    // Once hijacked, the origin socket no longer belongs to `up`, so destroying the request above never
    // reaches it: tie the two legs together, or a viewer who leaves keeps the origin connection open.
    socket.on('close',()=>s.destroy());s.on('close',()=>socket.destroy());
  });
  // An origin that refuses the upgrade (401, 404, 502…) answers with an ordinary response. Without a
  // listener Node silently discards it and the client is left hanging with no reply at all, so relay
  // the status and body, then close.
  up.on('response',r=>{
    if(clientGone||socket.destroyed)return r.destroy();
    socket.write(`HTTP/1.1 ${r.statusCode} ${r.statusMessage||''}\r\n${rawHeaderBlock({...cleanResponseHeaders(r.headers),connection:'close'})}\r\n`);
    r.on('error',()=>socket.destroy());
    r.pipe(socket);
  });
  up.on('error',()=>socket.destroy());up.end();
}
