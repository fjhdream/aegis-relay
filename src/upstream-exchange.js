import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { pipeline } from 'node:stream';
import { guardedLookup } from './lookup.js';
import { EGRESS_HEADER, EGRESS_HOST_HEADER, EGRESS_PROTO_HEADER, egressToken } from './steering.js';

// The upstream exchange: every request this relay sends upstream for a node goes through here, so
// "how do we talk to this node's upstream" lives in one place. One exchange serves one client request.
// It picks the line (circuit state, failover), builds the request headers (privacy and credential
// rules, the unified-egress hop, the client-compat hint), sets up the connection (pools, SNI,
// certificate check, SSRF-guarded DNS, TLS session reuse) and owns the connect / header / idle timeouts.
// What a caller gets back is the upstream's status, headers and body; what it does with them (redirect
// and stream-URL rewriting, speed limits, the media resume loop) is the caller's business.
//
// open()     the request, with failover across the node's lines; resolves once headers arrive
// reopen()   (on a response) the same request again from a byte offset, on a fresh socket, same line
// upgrade()  a WebSocket upgrade, on the node's first available line
// abort()    the client has gone: stop whatever is in flight, and do not count it against the line

// A larger socket backpressure window avoids repeatedly stopping the zero-copy pipeline after only
// a few small chunks on high-bandwidth/high-latency routes. It is a threshold (allocated on demand),
// not a per-connection reservation, and stays deliberately bounded for small VPSes.
export const RELAY_HIGH_WATER_MARK=256*1024;
const HOP=new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);
const RETRY_STATUS=new Set([502,503,504]);
// Two warm pools, so playback and control never poison each other's sockets. API/control traffic is
// short and bursty; media bodies, HLS segments and Range seeks are long. Fresh sockets are murder on
// startup and seek latency because every one repays TCP slow-start from a tiny congestion window
// ("shows a few dozen KiB and can't ramp up"), so media keeps its own keep-alive pool to stay warm.
// The invisible byte-resume net (reopen) opens a one-shot socket the moment a reused connection
// stalls, so the specific frontends/CDNs that deliver only a few KiB on a re-used socket still recover
// cleanly — pooling gives the fast warm-window path without ever trapping playback on a misbehaving origin.
const API_AGENT_OPTIONS={keepAlive:true,keepAliveMsecs:15_000,maxSockets:512,maxFreeSockets:64,maxTotalSockets:1024,timeout:75_000,scheduling:'lifo',highWaterMark:RELAY_HIGH_WATER_MARK};
const MEDIA_AGENT_OPTIONS={keepAlive:true,keepAliveMsecs:30_000,maxSockets:256,maxFreeSockets:48,maxTotalSockets:512,timeout:75_000,scheduling:'lifo',highWaterMark:RELAY_HIGH_WATER_MARK};
const httpAgent=new http.Agent(API_AGENT_OPTIONS);
const httpsAgent=new https.Agent(API_AGENT_OPTIONS);
const httpMediaAgent=new http.Agent(MEDIA_AGENT_OPTIONS);
const httpsMediaAgent=new https.Agent(MEDIA_AGENT_OPTIONS);
// Clean media sockets still resume the cached TLS session, avoiding a full handshake without
// reintroducing unsafe HTTP connection reuse. API traffic and every completed HTTPS media request
// feed this cache.
const TLS_SESSION_MAX=1024;
const tlsSessions=new Map();
function tlsSessionKey(target){ return `${target.hostname}\0${target.port||'443'}`; }
function rememberTlsSession(key,session){ if(!key||!session)return; tlsSessions.delete(key); tlsSessions.set(key,session); if(tlsSessions.size>TLS_SESSION_MAX)tlsSessions.delete(tlsSessions.keys().next().value); }
export function clearTlsSessions(){ tlsSessions.clear(); }
// SNI carries host names only. Node 22 merely warns about an IP address there (DEP0123); newer Node
// rejects the request outright, which broke every HTTPS upstream configured by IP.
function tlsServername(hostname){const host=String(hostname||'').replace(/^\[|\]$/g,'');return net.isIP(host)?undefined:host;}

const CONNECT_TIMEOUT_MS=10_000;
const RESPONSE_HEADER_TIMEOUT_MS=60_000;
const FAILOVER_HEADER_TIMEOUT_MS=15_000;
const PLAYBACK_HEADER_TIMEOUT_MS=45_000;
// A WebSocket handshake answers right after connect; nothing legitimate takes this long.
const UPGRADE_HANDSHAKE_TIMEOUT_MS=15_000;
// Byte-addressable media can be resumed safely. Do not leave the player frozen for the previous
// 30-second window after an origin has stopped producing bytes — but on-the-fly transcode legitimately
// pauses for several seconds while it renders ahead, so the watchdog must be slower than a transcode
// gap or it churns needless reconnects mid-play.
export const MEDIA_STALL_TIMEOUT_MS=15_000;
const MEDIA_RESUME_HEADER_TIMEOUT_MS=8_000;
// A *reused* pooled media socket is on probation: if a warm connection stalls before headers, or
// dribbles only a few KiB before the stream has ramped up, that is the "delivers a handful of KiB then
// hangs" frontend/CDN pathology — not a slow transcode (which is slow on a fresh socket too). Give it
// a short leash and reconnect clean once. Fresh sockets keep the full patient windows above, so slow
// transcode starts and paused streams are never clipped.
export const MEDIA_REUSED_PROBATION_MS=8_000;

const timeoutError=(message,extra)=>Object.assign(new Error(message),{code:'ETIMEDOUT'},extra);
const clientGoneError=()=>Object.assign(new Error('client closed'),{code:'ECLIENTGONE',aborted:true});
const safeMethod=method=>method==='GET'||method==='HEAD';

export function hopFree(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([k])=>!HOP.has(k.toLowerCase())&&!['cookie2','x-forwarded-host'].includes(k.toLowerCase())));
}

export function stripAdminCredentials(headers) {
  delete headers['x-csrf-token'];
  if (!headers.cookie) return headers;
  const cookies=String(headers.cookie).split(';').map(value=>value.trim()).filter(Boolean).filter(value=>!value.toLowerCase().startsWith('aegis_session='));
  if(cookies.length)headers.cookie=cookies.join('; ');else delete headers.cookie;
  return headers;
}

// Optional client-compatibility hint for upstreams you own or are authorized to proxy. This only
// sets the declared X-Emby-* hint headers when the operator enables the profile; it deliberately
// never rewrites the MediaBrowser auth header, the tokens, or the identity carried in query params.
// Rewriting the authenticated Client/Device/Version desynchronizes the request from Emby's
// token/session binding, which is exactly what broke playback on servers running device-management
// or anti-proxy plugins — so the authenticated identity and tokens are always left untouched.
function applyClientProfile(headers, profile = {}) {
  if (!profile || profile.enabled !== true) return;
  const mapping = { userAgent:'user-agent', client:'x-emby-client', deviceName:'x-emby-device-name', deviceId:'x-emby-device-id' };
  for (const [field,header] of Object.entries(mapping)) if (profile[field]) headers[header]=profile[field];
}

export function routeUpstreams(route) {
  if (route.upstreams?.length) return route.upstreams;
  return route.upstream ? [route.upstream] : [];
}

// Operator-declared backend stream hosts for this node (host or host:port), only when the feature is
// enabled. These are the sole domains the /.aegis-vod/ path may reach and the only ones rewritten.
export function streamRewriteDomains(route) {
  const sr=route&&route.streamRewrite;
  if(!sr||sr.enabled!==true||!Array.isArray(sr.domains))return [];
  return sr.domains.map(d=>String(d||'').trim().toLowerCase()).filter(Boolean);
}

// The origins that may receive the client's Emby credentials: the node's upstreams and its declared
// stream hosts, trusted parts of the same deployment. Snapshot routes are deep-frozen and replaced
// wholesale on every apply, so a frozen route is derived once instead of on every request.
const routeOrigins=new WeakMap();
function credentialOrigins(route) {
  let origins=routeOrigins.get(route);
  if(origins)return origins;
  origins=new Set([...routeUpstreams(route),...streamRewriteDomains(route).flatMap(h=>[`https://${h}`,`http://${h}`])].map(value=>{try{return new URL(value).origin}catch{return''}}).filter(Boolean));
  if(Object.isFrozen(route))routeOrigins.set(route,origins);
  return origins;
}

// Circuit state per node line.
const runtime=new Map();
function stateKey(route, target) { return `${route.id || route.alias}\0${target}`; }
// Circuit state would otherwise outlive its route forever: every delete or upstream edit left an
// orphan entry in the map for the lifetime of the process.
export function dropRouteRuntime(routeId) {
  const prefix=`${routeId}\0`;
  for (const key of runtime.keys()) if (key.startsWith(prefix)) runtime.delete(key);
}
function stateFor(route, target) {
  const k=stateKey(route, target);
  if (!runtime.has(k)) runtime.set(k, { failures:0, openUntil:0, lastError:'', lastSuccess:null });
  return runtime.get(k);
}
function markSuccess(route, target) { const s=stateFor(route,target); s.failures=0; s.openUntil=0; s.lastError=''; s.lastSuccess=new Date().toISOString(); }
function markFailure(route, target, reason) {
  // Only trip after several consecutive genuine upstream failures. A short fuse used to open the
  // circuit on transient blips and then serve 502s to healthy nodes, which read as instability.
  const s=stateFor(route,target); s.failures++; s.lastError=String(reason || 'request failed').slice(0,120);
  if (s.failures >= 4) s.openUntil=Date.now() + Math.min(120_000, 10_000 * 2 ** Math.min(s.failures - 4, 4));
}
function safeUpstreamError(error) {
  const code=String(error?.code||''),message=String(error?.message||'').toLowerCase();
  if(code==='ECONNREFUSED')return'上游拒绝连接，请检查地址、端口和防火墙';
  if(code==='ENOTFOUND'||code==='EAI_AGAIN')return'上游域名解析失败';
  if(code==='ETIMEDOUT'||message.includes('timeout'))return'上游连接超时';
  if(code==='ECONNRESET'||message.includes('socket hang up'))return'上游提前断开连接';
  if(code.includes('CERT')||message.includes('certificate')||message.includes('self-signed'))return'上游 TLS 证书验证失败';
  if(code==='EPROTO'||message.includes('wrong version number')||message.includes('ssl routines'))return'上游协议不匹配，请检查 HTTP/HTTPS';
  return'上游连接失败';
}
function orderedTargets(route) {
  // Deterministic order — always prefer the primary line. Rotating upstreams per request sent a
  // client's seeks to a different Emby server than the one holding its playback/transcode session,
  // which showed up as long buffering and dropped streams. Extra lines are failover, not balancing.
  const all=routeUpstreams(route);
  if (!all.length) return [];
  const available=all.filter(t=>stateFor(route,t).openUntil<=Date.now());
  return available.length?available:all;
}

// Index of the upstream line this machine currently serves a node from. Steering only moves a session
// to a machine on the same line, so a seek never lands on an Emby server without its transcode session.
export function activeUpstreamLine(route) {
  const all=routeUpstreams(route),now=Date.now(),index=all.findIndex(t=>stateFor(route,t).openUntil<=now);
  return index<0?0:index;
}

export function getRuntimeStatus(routes) {
  return routes.map(route => ({ id:route.id, alias:route.alias, upstreams:routeUpstreams(route).map(target=>{
    const s=stateFor(route,target); return { target:'[encrypted upstream]', failures:s.failures, circuitOpen:s.openUntil>Date.now(), retryAt:s.openUntil?new Date(s.openUntil).toISOString():null, lastSuccess:s.lastSuccess, lastError:s.lastError };
  }) }));
}

function joinTarget(target, rest, search) {
  const base=new URL(target), left=base.pathname.replace(/\/$/,''), right=rest.startsWith('/')?rest:`/${rest}`;
  base.pathname=`${left}${right}`.replace(/\/{2,}/g,'/'); base.search=search; return base;
}

function watchSocket(request,{secure,tlsKey,connectTimer,onAssigned}) {
  request.on('socket',socket=>{
    socket.setNoDelay(true);socket.setKeepAlive(true,15_000);
    onAssigned?.();
    if(!socket.connecting)return clearTimeout(connectTimer);
    // Capture TLS session tickets from every new connection (API and media) so later unpooled
    // playback sockets to the same origin can resume instead of doing a full handshake.
    if(secure)socket.on('session',session=>rememberTlsSession(tlsKey,session));
    // TCP connect is not enough for HTTPS: keep the guard running until the TLS handshake has
    // completed, otherwise a stalled secureConnect can hold playback for the full idle timeout.
    socket.once(secure?'secureConnect':'connect',()=>clearTimeout(connectTimer));
  });
}

export class UpstreamExchange {
  // prefix is the client's access prefix (/alias/key): an egress machine is handed the client's own path.
  // clientHeaders are the client's request headers, as received.
  constructor({route,prefix='',egress=null,publicContext={},clientHeaders={},method='GET',playback=false}) {
    this.route=route;this.prefix=prefix;this.egress=egress?.base?egress:null;this.publicContext=publicContext;
    this.method=method;this.playback=playback;this.clientRange=!!clientHeaders.range;
    this.origins=this.egress?new Set([this.egress.base]):credentialOrigins(route);
    this.active=null;this.aborted=false;
    // Mirror the proven Nginx gateway: advertise the public host/scheme so the upstream builds correct
    // redirects, but strip the client IP for privacy. Through an egress machine, that machine applies
    // the client-compat hint.
    const headers=stripAdminCredentials(hopFree(clientHeaders));
    delete headers['x-forwarded-for'];delete headers.forwarded;delete headers['x-real-ip'];
    delete headers[EGRESS_HEADER];delete headers[EGRESS_HOST_HEADER];delete headers[EGRESS_PROTO_HEADER];
    if(publicContext.host)headers['x-forwarded-host']=publicContext.host;
    headers['x-forwarded-proto']=publicContext.proto;
    if(!this.egress)applyClientProfile(headers,route.clientProfile);
    this.headers=headers;
  }

  // The lines to try, in order, each with its full URL. An explicit target (a sealed redirect
  // continuation, a declared stream host) is tried alone; a pinned line likewise.
  candidates({rest='/',search='',target=null,line=null}) {
    if(target)return [{line:target.href,url:target}];
    const lines=line?[line]:this.egress?[this.egress.base]:orderedTargets(this.route),path=this.egress?`${this.prefix}${rest}`:rest;
    return lines.map(value=>({line:value,url:joinTarget(value,path,search)}));
  }

  requestHeaders(url,extra=null) {
    const headers={...this.headers,...(extra||{})};
    // The egress machine's Nginx overwrites X-Forwarded-Proto for its own HTTPS hop, so the client's scheme
    // goes in a header of its own (see EGRESS_PROTO_HEADER).
    if(this.egress){headers[EGRESS_HEADER]=egressToken(this.route,Date.now());if(this.publicContext.host)headers[EGRESS_HOST_HEADER]=this.publicContext.host;headers[EGRESS_PROTO_HEADER]=`proto=${this.publicContext.proto==='http'?'http':'https'}`;}
    headers.host=url.host;
    // The client's Emby credentials only ever reach this node's own origins.
    if(!this.origins.has(url.origin)){delete headers.authorization;delete headers.cookie;delete headers['x-emby-token'];}
    return headers;
  }

  connectOptions(url,headers) {
    return {protocol:url.protocol,hostname:url.hostname,port:url.port,path:url.pathname+url.search,headers,servername:tlsServername(url.hostname),rejectUnauthorized:this.egress?true:this.route.tlsVerify!==false,lookup:guardedLookup(this.egress?false:this.route.allowPrivate)};
  }

  abort() {
    this.aborted=true;
    if(this.active&&!this.active.destroyed)this.active.destroy();
  }

  // Resolves with an UpstreamResponse once a line answers; rejects with the last error (its .reason is
  // safe to show), or with .aborted when the client went away. GET and HEAD fail over to the next line
  // on a 502/503/504 or a connection error, and are retried once on a clean socket when a reused pooled
  // one turns out to be dead. Any other method sends body once and is never retried. A signal cancels
  // this call alone, without holding it against the line.
  open({rest='/',search='',target=null,line=null,headers=null,body=null,signal=null}={}) {
    const candidates=this.candidates({rest,search,target,line}),canRetry=safeMethod(this.method);
    if(!candidates.length)return Promise.reject(Object.assign(new Error('no upstream available'),{reason:'no upstream available'}));
    return new Promise((resolve,reject)=>{
      let settled=false;
      const fail=error=>{if(settled)return;settled=true;reject(error)};
      const attempt=(index,freshSocket=false)=>{
        if(settled)return;
        if(this.aborted)return fail(clientGoneError());
        const {line:value,url}=candidates[index],secure=url.protocol==='https:';
        // A failover/stale-socket retry (freshSocket) forces a clean one-shot socket; otherwise media
        // rides its own warm pool and control traffic rides the API pool. Keeping the two pools apart
        // means a long media body can never inherit — or hand off — a poisoned API socket.
        const pool=freshSocket?null:(this.playback?(secure?httpsMediaAgent:httpMediaAgent):(secure?httpsAgent:httpAgent));
        const requestHeaders=this.requestHeaders(url,headers);requestHeaders.connection=pool?'keep-alive':'close';
        const tlsKey=secure?tlsSessionKey(url):'';
        const options={...this.connectOptions(url,requestHeaders),method:this.method,highWaterMark:RELAY_HIGH_WATER_MARK,agent:pool||false,...(signal?{signal}:{})};
        // Pooled agents handle TLS resumption themselves. The one-shot recovery/failover sockets fall
        // back to the shared session cache so even a fresh connection skips the full handshake.
        if(secure&&!pool){const session=tlsSessions.get(tlsKey);if(session)options.session=session;}
        let handedOut=false,headerTimer=null;
        const up=(secure?https:http).request(options,upRes=>{
          clearTimeout(connectTimer);
          const status=upRes.statusCode||502;
          if(canRetry&&RETRY_STATUS.has(status)&&index+1<candidates.length){markFailure(this.route,value,`HTTP ${status}`);upRes.resume();return attempt(index+1);}
          if(RETRY_STATUS.has(status))markFailure(this.route,value,`HTTP ${status}`);else markSuccess(this.route,value);
          if(settled){up.destroy();return;}
          handedOut=true;settled=true;
          resolve(new UpstreamResponse(this,{request:up,response:upRes,line:value,target:url,options,tlsKey}));
        });
        this.active=up;
        // Short guard for the TCP connect only; once connected, allow a long idle window so slow
        // transcode starts and paused streams are not killed (Nginx uses proxy_read_timeout 3600s).
        const connectTimer=setTimeout(()=>up.destroy(timeoutError('connect timeout')),CONNECT_TIMEOUT_MS);
        connectTimer.unref?.();
        // The header wait is armed once the socket is assigned, because only then is up.reusedSocket
        // known. A reused pooled media socket (client sent a Range) is on probation: no headers within
        // the short leash means a poisoned pooled connection, re-fetched clean once. A fresh socket keeps
        // the full patient window so a slow transcode start is never clipped.
        const armHeaderTimer=()=>{
          const reusedProbation=this.playback&&this.clientRange&&up.reusedSocket===true;
          const ms=reusedProbation?MEDIA_REUSED_PROBATION_MS:(this.playback?PLAYBACK_HEADER_TIMEOUT_MS:(candidates.length>1?FAILOVER_HEADER_TIMEOUT_MS:RESPONSE_HEADER_TIMEOUT_MS));
          headerTimer=setTimeout(()=>up.destroy(timeoutError('response headers timeout',reusedProbation?{reusedProbation:true}:null)),ms);
          headerTimer.unref?.();
        };
        up.on('response',()=>{clearTimeout(connectTimer);clearTimeout(headerTimer)});
        watchSocket(up,{secure,tlsKey,connectTimer,onAssigned:armHeaderTimer});
        up.setTimeout(3600_000,()=>up.destroy(new Error('upstream idle timeout')));
        up.on('error',err=>{
          clearTimeout(connectTimer);clearTimeout(headerTimer);
          // A client that walked away (or a caller that cancelled) is not an upstream fault; counting it
          // opened circuits on perfectly healthy nodes and produced sporadic 502s mid-session.
          if(this.aborted)return fail(clientGoneError());
          if(signal?.aborted)return fail(err);
          // Precisely the two ways a *reused* pooled socket fails before headers: the origin had already
          // half-closed it (reset/broken pipe on reuse), or it stayed silent past the short probation
          // leash. Either is a poisoned pooled connection — re-fetch once on a clean same-line socket.
          // Everything else (a fresh socket's error, or a plain timeout on a socket that was never
          // reused) is a slow or dead line, not a stale connection: do not burn a second window retrying
          // the exact same thing. A pool alone is not proof of reuse — a pool's first socket is new.
          const resettable=err.code==='ECONNRESET'||err.code==='EPIPE';
          const staleSocket=((up.reusedSocket===true&&resettable)||err.reusedProbation===true)&&!freshSocket&&!handedOut&&canRetry;
          if(staleSocket)return attempt(index,true);
          const reason=safeUpstreamError(err);markFailure(this.route,value,reason);
          if(handedOut)return;
          if(canRetry&&index+1<candidates.length)return attempt(index+1);
          fail(Object.assign(err,{reason}));
        });
        if(canRetry||!body)up.end();else pipeline(body,up,()=>{});
      };
      attempt(0);
    });
  }

  // A WebSocket upgrade on the node's first available line. Returns the request; the caller listens for
  // 'upgrade', 'response' and 'error' and ends it. The socket is hijacked, so it never joins a pool.
  upgrade({rest='/',search='',target=null,protocol=''}={}) {
    const [{line,url}]=this.candidates({rest,search,target}),secure=url.protocol==='https:',tlsKey=secure?tlsSessionKey(url):'';
    const headers=this.requestHeaders(url);headers.connection='Upgrade';headers.upgrade=protocol;
    const options={...this.connectOptions(url,headers),agent:false};
    if(secure){const session=tlsSessions.get(tlsKey);if(session)options.session=session;}
    const up=(secure?https:http).request(options);
    this.active=up;
    // A dead or silent origin would otherwise hold the client's socket open until the OS gave up.
    const handshake=setTimeout(()=>up.destroy(timeoutError('upgrade handshake timeout')),UPGRADE_HANDSHAKE_TIMEOUT_MS);
    handshake.unref?.();
    if(secure)up.on('socket',socket=>socket.on('session',session=>rememberTlsSession(tlsKey,session)));
    up.on('close',()=>clearTimeout(handshake));
    up.on('upgrade',()=>{clearTimeout(handshake);markSuccess(this.route,line)});
    up.on('response',r=>{clearTimeout(handshake);if(RETRY_STATUS.has(r.statusCode))markFailure(this.route,line,`HTTP ${r.statusCode}`);else markSuccess(this.route,line)});
    up.on('error',err=>{if(!this.aborted)markFailure(this.route,line,err.message)});
    return up;
  }
}

// An upstream response handed to the caller: status, headers and body (the raw IncomingMessage), plus
// the line and the URL it came from.
class UpstreamResponse {
  constructor(exchange,{request,response,line,target,options,tlsKey}) {
    this.exchange=exchange;this.request=request;this.body=response;this.status=response.statusCode||502;this.headers=response.headers;
    this.line=line;this.target=target;this.reusedSocket=request.reusedSocket===true;this.options=options;this.tlsKey=tlsKey;
  }

  destroy() { if(!this.request.destroyed)this.request.destroy(); }

  // The body broke off for good: hold it against the line it came from.
  failed(error) { markFailure(this.exchange.route,this.line,safeUpstreamError(error)); }

  // The same request again for bytes from..to, on a fresh socket to the same line. Resolves with the
  // body once accept(status, headers) approves the answer; a rejected answer is an ERESUMEREJECTED error.
  reopen({from,to,validator='',accept}) {
    const exchange=this.exchange;
    if(exchange.aborted)return Promise.reject(clientGoneError());
    return new Promise((resolve,reject)=>{
      const headers={...this.options.headers,range:`bytes=${from}-${to}`,connection:'close'};
      if(exchange.egress)headers[EGRESS_HEADER]=egressToken(exchange.route,Date.now());
      delete headers['if-none-match'];delete headers['if-modified-since'];
      if(validator)headers['if-range']=validator;
      const secure=this.target.protocol==='https:',options={...this.options,method:'GET',headers,agent:false};
      if(secure){const session=tlsSessions.get(this.tlsKey);if(session)options.session=session;}
      let settled=false,connectGuard,headerGuard;
      const fail=error=>{clearTimeout(connectGuard);clearTimeout(headerGuard);if(settled)return;settled=true;reject(exchange.aborted?clientGoneError():error)};
      const resumeReq=(secure?https:http).request(options,resumeRes=>{
        clearTimeout(connectGuard);clearTimeout(headerGuard);
        if(!accept(resumeRes.statusCode||0,resumeRes.headers)){
          resumeRes.destroy();return fail(Object.assign(new Error('upstream rejected byte resume'),{code:'ERESUMEREJECTED'}));
        }
        settled=true;markSuccess(exchange.route,this.line);resolve(resumeRes);
      });
      exchange.active=resumeReq;
      connectGuard=setTimeout(()=>resumeReq.destroy(timeoutError('resume connect timeout')),CONNECT_TIMEOUT_MS);
      headerGuard=setTimeout(()=>resumeReq.destroy(timeoutError('resume headers timeout')),MEDIA_RESUME_HEADER_TIMEOUT_MS);
      connectGuard.unref?.();headerGuard.unref?.();
      watchSocket(resumeReq,{secure,tlsKey:this.tlsKey,connectTimer:connectGuard});
      resumeReq.setTimeout(MEDIA_STALL_TIMEOUT_MS,()=>resumeReq.destroy(timeoutError('resumed media stalled')));
      resumeReq.on('error',fail);resumeReq.end();
    });
  }
}
