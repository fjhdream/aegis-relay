import crypto from 'node:crypto';
import net from 'node:net';
import zlib from 'node:zlib';
import { isRouteAuthKey } from './route-auth.js';
import { b64u } from './security.js';

// Automatic playback steering (docs/AUTO_STEERING.md). Every machine runs this engine on its own data
// plane: it measures how well each playback session is being served here, and at request boundaries
// either serves the request or 302s it to a peer machine's direct domain. Machines share per-session
// state through the panel (SteeringHub); none of it is ever needed for correctness, only for quality.
export const STEER_PARAM='aegis_steer';
export const STEERING_CAPABILITY='steering-v1';
export const STEERING_MODES=Object.freeze(['off','shadow','on']);
// egress-v1: this machine relays a node's upstream traffic through the node's egress machine, and
// recognises such relayed requests when it is the egress machine itself.
export const EGRESS_CAPABILITY='egress-v1';
export const EGRESS_HEADER='x-aegis-egress',EGRESS_HOST_HEADER='x-aegis-egress-host';
export const VERDICTS=Object.freeze(['ok','starved_down','starved_up','unknown']);
export const STEER_DEFAULTS=Object.freeze({
  hlsWindowMs:20_000,minHlsSegments:4,progressiveWindowTicks:120,verdictTtlMs:60_000,dwellMs:120_000,
  switchWindowMs:600_000,maxSwitches:3,improve:1.3,penaltyMs:600_000,tokenTtlMs:30_000,sessionTtlMs:30*60_000,
  peerStaleMs:60_000,landingTimeoutMs:15_000,detachMs:15_000,reportEveryMs:5_000,
  syncActiveMs:5_000,syncIdleMs:30_000,syncDebounceMs:500,syncMaxBackoffMs:300_000,boundBytes:64*1024*1024,
  // Prefetching players can wait a minute before requesting the next range while buffered video plays.
  historyMinSamples:3,historyBadShare:0.34,historyGoodShare:0.75,boundContinueMs:120_000
});

const SESSION_KEY_RE=/^[A-Za-z0-9_-]{22}$/,PREFIX_KEY_RE=/^[A-Za-z0-9_-]{16}$/;
const ITEM_RE=/\/(?:emby\/)?(?:videos|audio)\/([^/]+)\//i;
const PLAY_RE=/\/(?:emby\/)?play\/(?:video|audio)\/([^/]+)(?:\/|$)/i;
const DOWNLOAD_RE=/\/items\/([^/]+)\/download/i;
// Side files of a playback (subtitles, images, trickplay) are tiny, parallel and not the stream itself:
// steering them would only scramble the timing the measurements rely on.
const SIDE_FILE_RE=/\/(?:subtitles|attachments|images|trickplay)\/|\.(?:vtt|srt|ass|ssa|sub|jpg|jpeg|png|webp|bif)$/i;
const DEVICE_RE=/DeviceId="([^"]*)"/i,CLIENT_RE=/Client="([^"]*)"/i;
const TOKEN_BODY=33,TOKEN_LENGTH=49;
const clip=(value,max=128)=>String(value||'').replace(/[\r\n\0]/g,'').trim().slice(0,max);
const mac=(key,label,data)=>crypto.createHmac('sha256',key).update(`${label}\n`).update(data).digest();
const targetTag=id=>crypto.createHash('sha256').update(`AegisRelay:steer-target:v1\n${id}`).digest().subarray(0,8);

// A per-node key derived from the node's routeAuthKey, which every machine serving the node already
// holds. Kept separate from the AES key of the .aegis-relay continuation tokens.
const steerKeys=new WeakMap();
export function steerKey(route) {
  if(!route||!isRouteAuthKey(route.routeAuthKey))return null;
  const cached=steerKeys.get(route);
  if(cached&&cached.source===route.routeAuthKey)return cached.key;
  const key=Buffer.from(crypto.hkdfSync('sha256',Buffer.from(route.routeAuthKey,'base64url'),Buffer.alloc(0),Buffer.from('AegisRelay:steer:v1'),32));
  steerKeys.set(route,{source:route.routeAuthKey,key});
  return key;
}

// The steer token is ours, never the upstream's. Remove it textually so every other query parameter is
// relayed byte-for-byte (re-serialising through URLSearchParams would re-encode the client's query).
export function stripSteerParam(search) {
  const value=String(search||'');
  if(!value.includes(`${STEER_PARAM}=`))return value;
  const kept=value.replace(/^\?/,'').split('&').filter(part=>part&&part.split('=')[0]!==STEER_PARAM);
  return kept.length?`?${kept.join('&')}`:'';
}

export function steerTokenOf(search) {
  for(const part of String(search||'').replace(/^\?/,'').split('&')){
    const eq=part.indexOf('=');
    if(eq>0&&part.slice(0,eq)===STEER_PARAM)return part.slice(eq+1);
  }
  return '';
}

export function playIdentity(req, incoming) {
  const headers=req.headers,query=new Map();
  for(const [name,value] of incoming.searchParams){const lower=name.toLowerCase();if(!query.has(lower))query.set(lower,value);}
  const auth=String(headers['x-emby-authorization']||headers.authorization||''),field=re=>{const match=re.exec(auth);return match?match[1]:''};
  return {
    deviceId:clip(headers['x-emby-device-id']||field(DEVICE_RE)||query.get('x-emby-device-id')||query.get('deviceid')),
    playSessionId:clip(query.get('playsessionid')),mediaSourceId:clip(query.get('mediasourceid')),
    client:clip(headers['x-emby-client']||field(CLIENT_RE)||query.get('x-emby-client'),80),userAgent:clip(headers['user-agent'],160)
  };
}

export function itemOf(rest) {
  const match=ITEM_RE.exec(rest)||PLAY_RE.exec(rest)||DOWNLOAD_RE.exec(rest);
  return match?clip(match[1]).toLowerCase():'';
}

export function requestKind(rest) {
  const path=String(rest||'').toLowerCase();
  if(SIDE_FILE_RE.test(path)||/\/livetv\//.test(path))return 'other';
  if(path.endsWith('.m3u8'))return 'manifest';
  if(/\/hls\d*\//.test(path)||/\.(?:ts|m4s|aac)$/.test(path))return 'segment';
  return 'progressive';
}

// Stable across machines: built only from what the client puts in every stream URL, never from the
// client IP (a dual-stack client reaches different machines over different address families).
export function sessionKeyFor(route, item, identity) {
  const key=steerKey(route);
  if(!key||!item||!(identity.playSessionId||identity.deviceId))return null;
  return b64u(mac(key,'session',[item,identity.mediaSourceId,identity.playSessionId,identity.deviceId].join('\n')).subarray(0,16));
}

// The client's network, coarse enough to stand for "viewers on the same line": IPv4 /24, IPv6 /48.
export function clientPrefix(ip) {
  const value=String(ip||'').trim().replace(/^::ffff:/i,'');
  if(net.isIPv4(value))return `${value.split('.').slice(0,3).join('.')}.0/24`;
  if(!net.isIPv6(value))return '';
  const [head,tail]=value.split('::'),left=head?head.split(':'):[],right=tail?tail.split(':'):[];
  const groups=value.includes('::')?[...left,...Array(Math.max(0,8-left.length-right.length)).fill('0'),...right]:left;
  return `${groups.slice(0,3).map(group=>parseInt(group,16).toString(16)).join(':')}::/48`;
}

// The same X-Real-IP the relay's viewer list trusts: set by the fronting Nginx, never by the client.
export function clientIpOf(req) {
  const first=value=>String(value||'').split(',')[0].trim();
  return first(req.headers['x-real-ip'])||first(req.headers['x-forwarded-for'])||String(req.socket?.remoteAddress||'');
}

// What the panel learns per network is keyed by a per-node digest: no address ever leaves the machine.
export function prefixKeyFor(route, ip) {
  const key=steerKey(route),prefix=clientPrefix(ip);
  return key&&prefix?b64u(mac(key,'prefix',prefix).subarray(0,12)):'';
}

// A request one machine relays to the node's egress machine carries a short-lived proof derived from
// the node key (which only the machines serving the node hold), plus the host the client used. The
// egress machine then builds every link for that host and leaves steering and accounting to the relay.
export function egressToken(route, nowMs) {
  const key=steerKey(route);
  return key?b64u(mac(key,'egress',String(Math.floor(nowMs/60_000))).subarray(0,16)):'';
}

export function relayedEgress(route, headers, nowMs) {
  const key=steerKey(route),token=String(headers?.[EGRESS_HEADER]||''),host=String(headers?.[EGRESS_HOST_HEADER]||'').trim().toLowerCase();
  if(!key||!/^[A-Za-z0-9_-]{22}$/.test(token)||!/^[a-z0-9.-]{1,253}(?::\d{1,5})?$/.test(host))return null;
  const raw=Buffer.from(token,'base64url'),minute=Math.floor(nowMs/60_000);
  // Machine clocks drift a little; a captured proof is stale within minutes.
  for(let skew=-2;skew<=2;skew++)if(crypto.timingSafeEqual(raw,mac(key,'egress',String(minute+skew)).subarray(0,16)))return {host};
  return null;
}

export function sealSteerToken(route, {epoch, issuedAtMs, target, sessionKey}) {
  const key=steerKey(route),session=Buffer.from(String(sessionKey||''),'base64url');
  if(!key)throw new Error('steering key unavailable');
  if(session.length!==16)throw new Error('invalid steering session key');
  const body=Buffer.alloc(TOKEN_BODY);
  body[0]=1;body.writeUInt32BE(epoch>>>0,1);body.writeUInt32BE(Math.floor(issuedAtMs/1000)>>>0,5);targetTag(target).copy(body,9);session.copy(body,17);
  return b64u(Buffer.concat([body,mac(key,'token',body).subarray(0,16)]));
}

export function openSteerToken(route, token, {self, nowMs, ttlMs=STEER_DEFAULTS.tokenTtlMs}) {
  const key=steerKey(route),raw=Buffer.from(String(token||''),'base64url');
  if(!key||raw.length!==TOKEN_LENGTH||b64u(raw)!==token||raw[0]!==1)return null;
  const body=raw.subarray(0,TOKEN_BODY);
  if(!crypto.timingSafeEqual(raw.subarray(TOKEN_BODY),mac(key,'token',body).subarray(0,16)))return null;
  if(!crypto.timingSafeEqual(body.subarray(9,17),targetTag(self)))return null;
  const issuedAtMs=body.readUInt32BE(5)*1000;
  if(Math.abs(nowMs-issuedAtMs)>ttlMs)return null;
  return {epoch:body.readUInt32BE(1),issuedAtMs,sessionKey:b64u(body.subarray(17,33))};
}

// HLS: segments fit in kernel socket buffers, so byte counters here say nothing about the client. The
// client's own request cadence does: it asks for the next segment once it holds the previous one.
// cycleMs = time between consecutive segment requests; upMs = the part of it spent on our upstream.
// The window stretches with the segment length: a starving player on 6 s segments only completes one
// every ~9 s, and a fixed 20 s window would never hold the minimum number of segments.
export function hlsVerdict(samples, segmentSeconds, {nowMs, windowMs=STEER_DEFAULTS.hlsWindowMs, minSegments=STEER_DEFAULTS.minHlsSegments}={}) {
  if(!(segmentSeconds>0))return {verdict:'unknown',rateBps:0};
  const span=Math.max(windowMs,minSegments*segmentSeconds*2000);
  const recent=samples.filter(sample=>sample.cycleMs>0&&sample.reqAt>=nowMs-span);
  if(recent.length<minSegments)return {verdict:'unknown',rateBps:0};
  let cycle=0,up=0,bytes=0;
  for(const sample of recent){cycle+=sample.cycleMs;up+=Math.min(sample.cycleMs,Math.max(0,sample.upMs));bytes+=sample.bytes;}
  const ratio=recent.length*segmentSeconds*1000/cycle,downShare=(cycle-up)/cycle,rateBps=Math.round(bytes*1000/cycle);
  return {verdict:ratio>=0.9?'ok':(downShare>=0.5?'starved_down':'starved_up'),rateBps,ratio,downShare};
}

// Progressive: one-second ticks. A player on a fast enough line fills its buffer and stops reading
// (idle ticks); one on a line slower than the bitrate never does. Who blocks tells the two ends apart.
export function progressiveVerdict(ticks, {windowTicks=STEER_DEFAULTS.progressiveWindowTicks, minRateMbps=0}={}) {
  if(ticks.length<windowTicks)return {verdict:'unknown',rateBps:0};
  let idle=0,blocked=0,active=0,bytes=0;
  const window=ticks.slice(-windowTicks);
  for(const tick of window){if(tick.idle)idle++;if(tick.blocked)blocked++;if(tick.bytes>0){active++;bytes+=tick.bytes;}}
  const rateBps=active?Math.round(bytes/active):0,count=window.length;
  if(idle/count>0.05)return {verdict:'ok',rateBps};
  if(blocked/count>=0.7)return {verdict:minRateMbps>0&&rateBps*8>=minRateMbps*1e6?'ok':'starved_down',rateBps};
  if(blocked/count<0.3)return {verdict:'starved_up',rateBps};
  return {verdict:'unknown',rateBps};
}

// The switching rule (docs §8.2 steps 2–4). Only a starving current line ever triggers a move, which is
// what keeps fluctuating lines from bouncing sessions around; dwell, a switch budget, a required
// margin and a penalty box do the rest. `candidates` maps machine id -> {eligible}; it includes self.
export function decide(session, {self, nowMs, candidates, params=STEER_DEFAULTS}) {
  const assigned=session.assigned||'',target=assigned||self;
  if(target!==self&&!candidates.get(target)?.eligible)return {target:self,assigned:'',changed:true,switched:false,reason:'target_unavailable'};
  const current=session.scores?.[target];
  const fresh=current&&nowMs-current.at<=params.verdictTtlMs,starving=fresh&&current.verdict==='starved_down';
  const recent=(session.switches||[]).filter(at=>nowMs-at<params.switchWindowMs);
  if(nowMs-(session.lastSwitchAt||0)<params.dwellMs||recent.length>=params.maxSwitches)return {target,assigned,changed:false};
  if(!starving){
    // The one move not triggered by starving: a session that never moved, on a machine this network
    // has kept starving on, while another one has kept serving it well. Decided before it stalls.
    const pick=!session.lastSwitchAt&&!(fresh&&current.verdict==='ok')?historyPick(session,target,candidates,params):'';
    return pick?{target:pick,assigned:pick,changed:true,switched:true,reason:'history',fromRateBps:current?.rateBps||0,toRateBps:0}:{target,assigned,changed:false};
  }
  let best=null,explore=null;
  for(const [id,candidate] of candidates){
    if(id===target||!candidate.eligible)continue;
    const score=session.scores?.[id],age=score?nowMs-score.at:Infinity;
    if(score&&score.verdict!=='unknown'&&age<=params.penaltyMs){
      if(score.verdict==='ok'&&score.rateBps>=params.improve*(current.rateBps||0)&&(!best||score.rateBps>best.rateBps))best={id,rateBps:score.rateBps};
      continue;
    }
    // Untested here: try the machine this network has done best on, then the least recently tried.
    const tried=session.tried?.[id]||0,share=historyShare(session,id,params);
    if(!explore||share>explore.share||(share===explore.share&&tried<explore.tried))explore={id,tried,share};
  }
  const pick=best?.id||explore?.id;
  if(!pick)return {target,assigned,changed:false};
  return {target:pick,assigned:pick,changed:true,switched:true,reason:best?'better_line':'explore',fromRateBps:current.rateBps||0,toRateBps:best?.rateBps||0};
}

// Share of good verdicts this client network has had on a machine (0.5 while too few are known).
function historyShare(session, id, params) {
  const seen=session.prior?.[id];
  return seen&&seen.n>=params.historyMinSamples?seen.ok:0.5;
}

function historyPick(session, target, candidates, params) {
  const mine=session.prior?.[target];
  if(!mine||mine.n<params.historyMinSamples||mine.ok>params.historyBadShare)return '';
  let pick=null;
  for(const [id,candidate] of candidates){
    const seen=session.prior?.[id];
    if(id===target||!candidate.eligible||!seen||seen.n<params.historyMinSamples||seen.ok<params.historyGoodShare)continue;
    if(!pick||seen.ok>pick.ok)pick={id,ok:seen.ok};
  }
  return pick?.id||'';
}

const rangeStart=value=>{const match=/^bytes=(\d+)-/.exec(String(value||'').trim());return match?Number(match[1]):null};

function appendToken(search, token) {
  return `${search?`${search}&`:'?'}${STEER_PARAM}=${token}`;
}

function manifestTargetDuration(buffer, encoding) {
  try {
    const enc=String(encoding||'').toLowerCase();
    const text=(enc==='gzip'||enc==='x-gzip'?zlib.gunzipSync(buffer):enc==='deflate'?zlib.inflateSync(buffer):enc==='br'?zlib.brotliDecompressSync(buffer):buffer).toString('utf8');
    const match=/#EXT-X-TARGETDURATION:\s*(\d+(?:\.\d+)?)/i.exec(text);
    const seconds=match?Number(match[1]):0;
    return seconds>0&&seconds<=60?seconds:0;
  } catch { return 0; }
}

// One served playback request. The proxy reports headers/bytes; the engine samples backpressure.
class SteerTrack {
  constructor(engine, session, kind, nowMs) {
    this.engine=engine;this.session=session;this.kind=kind;this.reqAt=nowMs;this.hdrAt=0;this.endAt=0;this.sent=0;this.blockedTicks=0;this.res=null;this.done=false;this.bound=null;
    const local=engine.localOf(session);
    if(kind==='segment')local.hls.open=this;
    else if(kind==='progressive'){
      const prog=local.prog;
      // Coming back after a gap: the old ticks describe a different stretch of the playback.
      if(!prog.active.size&&nowMs-prog.lastServedAt>engine.params.detachMs)prog.ticks=[];
      prog.active.add(this);
    }
    engine.tracks.add(this);
  }
  attach(res) { this.res=res;res.once('close',()=>this.close()); }
  headers(status, headers={}) {
    if(!this.hdrAt)this.hdrAt=this.engine.now();
    // A capped Range only counts when the origin really cut the file there; near the end of a file, or
    // from an origin that ignores Range, nothing was cut and there is nothing to continue.
    if(this.bound){
      const match=/^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(String(headers['content-range']||'').trim());
      const cut=status===206&&match&&Number(match[1])===this.bound.start&&Number(match[2])===this.bound.end&&(match[3]==='*'||Number(match[3])>this.bound.end+1);
      if(cut)this.bound.length=this.bound.end-this.bound.start+1;else this.engine.dropBound(this);
    }
  }
  bytes(count) { this.sent+=count;if(this.kind==='progressive')this.engine.localOf(this.session).prog.tickBytes+=count; }
  close() {
    if(this.done)return;
    this.done=true;this.endAt=this.engine.now();this.res=null;this.engine.tracks.delete(this);
    if(this.kind==='progressive'){const prog=this.engine.localOf(this.session).prog;prog.active.delete(this);prog.lastServedAt=this.endAt;}
    // The whole capped range reached the client: a player that handles it asks for the rest right away.
    if(this.bound?.length&&this.sent>=this.bound.length)this.engine.localOf(this.session).boundWait={end:this.bound.end,at:this.endAt,client:this.bound.client,trial:this.bound.trial};
    else if(this.bound)this.engine.dropBound(this);
  }
  // The media playlist states its segment length; read it off the wire without delaying delivery.
  manifest(stream, encoding) {
    const chunks=[];let size=0;
    stream.on('data',chunk=>{if(size<=256*1024){chunks.push(chunk);size+=chunk.length;}});
    stream.once('end',()=>{const seconds=manifestTargetDuration(Buffer.concat(chunks),encoding);if(seconds)this.engine.noteSegmentSeconds(this.session,seconds);});
  }
}

export class SteeringEngine {
  constructor({selfId, lineOf=()=>0, canServe=()=>true, params={}, clock=()=>Date.now()}={}) {
    this.selfId=String(selfId||'');this.lineOf=lineOf;this.canServe=canServe;this.params={...STEER_DEFAULTS,...params};this.clock=clock;
    this.offsetMs=0;this.sessions=new Map();this.items=new Map();this.tracks=new Set();this.health=new Map();
    this.excluded=new Set();this.bounded=new Set();this.trials=new Set();this.trialing=new Set();this.boundBytes=this.params.boundBytes;
    this.cursor=0;this.reports=new Map();this.decisions=[];this.landings=[];this.failures=[];this.shadow=[];this.bounds=[];
    this.ticker=null;this.syncTimer=null;this.syncDue=0;this.syncing=false;this.send=null;this.routes=()=>[];this.syncErrors=0;this.lastSyncError='';this.lastSyncAt=0;
  }

  // Panel time: tokens and scores are compared across machines, so every engine runs on the clock the
  // panel hands back with each sync.
  now() { return this.clock()+this.offsetMs; }

  session(key, routeId, nowMs) {
    let session=this.sessions.get(key);
    if(!session){
      session={key,routeId,assigned:'',epoch:0,lastSwitchAt:0,switches:[],scores:{},tried:{},segmentSeconds:0,lastLanding:null,lastSeen:nowMs,client:'',minRateMbps:0,pending:null,landedEpoch:-1,shadow:{lastSwitchAt:0,switches:[]},prefix:'',prior:{},local:null};
      this.sessions.set(key,session);this.startTicking();
    }
    return session;
  }

  localOf(session) {
    session.local||={hls:{open:null,samples:[]},prog:{ticks:[],tickBytes:0,active:new Set(),lastServedAt:0},lastVerdict:'',lastReportAt:null,boundWait:null,trialed:false};
    return session.local;
  }

  clientExcluded(identity) {
    if(identity.client&&this.excluded.has(identity.client.toLowerCase()))return true;
    // Browsers (Emby Web and friends): a cross-origin redirect drags in CORS and credential rules.
    return /^mozilla\//i.test(identity.userAgent);
  }

  candidatesFor(route, nowMs) {
    const candidates=new Map(),line=this.lineOf(route);
    for(const peer of route.steering.peers||[]){
      if(peer.id===this.selfId){candidates.set(peer.id,{eligible:true,base:peer.base});continue;}
      const health=this.health.get(peer.id),routeHealth=health?.routes?.[route.id];
      // Same upstream line, so a seek lands on the Emby server holding the transcode — unless every
      // machine reaches the upstream through the node's egress machine anyway.
      const sameLine=route.steering.params?.anyLine===true||Number(routeHealth?.line)===line;
      const eligible=!!(health&&health.healthy&&routeHealth&&!routeHealth.quotaExhausted&&sameLine&&nowMs-health.at<=this.params.peerStaleMs);
      candidates.set(peer.id,{eligible,base:peer.base});
    }
    if(!candidates.has(this.selfId))candidates.set(this.selfId,{eligible:true,base:''});
    return candidates;
  }

  // Decide where a playback request is served. Returns null when steering does not apply at all,
  // {redirect} to send the client to a peer, or {track, range} to serve it here.
  plan({route, found, req, incoming, publicContext, source}) {
    const topology=route?.steering;
    if(!topology||(topology.mode!=='shadow'&&topology.mode!=='on'))return null;
    if(req.method!=='GET'||publicContext?.proto!=='https'||req.headers.authorization)return null;
    const streamPath=source?.pathname||found.rest,kind=requestKind(streamPath);
    if(kind==='other')return null;
    const identity=playIdentity(req,source||incoming);
    if(this.clientExcluded(identity))return null;
    const nowMs=this.now(),item=itemOf(streamPath),token=steerTokenOf(incoming.search),itemKey=item?`${route.id}\n${item}`:'';
    const landed=token?openSteerToken(route,token,{self:this.selfId,nowMs,ttlMs:this.params.tokenTtlMs}):null;
    const key=landed?.sessionKey||sessionKeyFor(route,item,identity)||(itemKey&&this.items.get(itemKey)?.key)||'';
    if(!key)return null;
    if(itemKey)this.rememberItem(itemKey,key,nowMs);
    const session=this.session(key,route.id,nowMs);
    session.lastSeen=nowMs;session.minRateMbps=Number(topology.params?.minRateMbps||0);if(identity.client)session.client=identity.client;
    if(!session.prefix)session.prefix=prefixKeyFor(route,clientIpOf(req));
    // The player came back for the bytes right after a capped range: it continues on its own.
    const wait=session.local?.boundWait;
    if(wait&&kind==='progressive'&&rangeStart(req.headers.range)===wait.end+1)this.boundResult(session,true,nowMs);
    // The next segment request marks the moment the client finished the previous one.
    if(kind==='segment')this.closeCycle(session,nowMs);
    // A request we were just steered to is always served here: one steering hop per request at most,
    // which is what rules out redirect loops however stale the shared state is.
    if(landed){
      if(landed.epoch>=session.epoch){session.epoch=landed.epoch;session.assigned=this.selfId;}
      if(session.landedEpoch!==landed.epoch){
        session.landedEpoch=landed.epoch;session.lastLanding={epoch:landed.epoch,at:nowMs};
        this.landings.push({s:key,r:route.id,epoch:landed.epoch,client:identity.client,at:nowMs});this.requestSync();
      }
      return this.serve(session,kind,req,identity,topology,nowMs);
    }
    const candidates=this.candidatesFor(route,nowMs);
    let target=this.selfId;
    if(candidates.size>1){
      if(topology.mode==='on'){
        this.checkPending(session,nowMs);
        const decision=decide(session,{self:this.selfId,nowMs,candidates,params:this.params});
        if(decision.changed)this.reassign(session,decision,nowMs);
        target=decision.target;
      } else {
        // Shadow mode decides exactly the same way against the line actually in use, logs what it would
        // have done, and never moves anyone.
        const view={...session,assigned:'',lastSwitchAt:session.shadow.lastSwitchAt,switches:session.shadow.switches};
        const decision=decide(view,{self:this.selfId,nowMs,candidates,params:this.params});
        if(decision.changed&&decision.switched){
          session.shadow={lastSwitchAt:nowMs,switches:[...session.shadow.switches.filter(at=>nowMs-at<this.params.switchWindowMs),nowMs]};
          this.shadow.push({s:key,r:route.id,from:this.selfId,to:decision.target,reason:decision.reason,fromRateBps:decision.fromRateBps,toRateBps:decision.toRateBps,client:session.client,at:nowMs});
          this.requestSync();
        }
      }
    }
    if(target!==this.selfId){
      const peer=candidates.get(target),tokenValue=sealSteerToken(route,{epoch:session.epoch,issuedAtMs:nowMs,target,sessionKey:key});
      if(!session.pending||session.pending.epoch!==session.epoch)session.pending={target,epoch:session.epoch,at:nowMs,client:identity.client};
      if(kind==='segment')this.localOf(session).hls.open=null;
      return {redirect:`${peer.base}${found.prefix}${found.rest}${appendToken(stripSteerParam(incoming.search),tokenValue)}`};
    }
    return this.serve(session,kind,req,identity,topology,nowMs);
  }

  serve(session, kind, req, identity, topology, nowMs) {
    const track=new SteerTrack(this,session,kind,nowMs);
    // Playback must be visible even when a fast player finishes buffering before a verdict exists.
    if(session.local.lastReportAt===null)this.queueReport(session,true);
    // Phase 3 (opt-in per client): cap an open-ended Range so a long direct play is cut into requests,
    // each of which is a chance to move the session. Only for clients proven to continue on their own.
    // A client type on trial (automatic detection, off by default) gets one capped range per session and
    // one session at a time per machine: the trial can only ever interrupt that one playback.
    let range=null;
    const name=identity.client.toLowerCase(),local=session.local;
    const trial=!!name&&!this.bounded.has(name)&&this.trials.has(name)&&!local.trialed&&!this.trialing.has(name);
    if(kind==='progressive'&&topology.mode==='on'&&name&&(this.bounded.has(name)||trial)){
      const match=/^bytes=(\d+)-$/.exec(String(req.headers.range||'').trim()),start=match?Number(match[1]):NaN;
      if(Number.isSafeInteger(start)){
        range=`bytes=${start}-${start+this.boundBytes-1}`;
        track.bound={start,end:start+this.boundBytes-1,client:identity.client,trial,length:0};
        if(trial){local.trialed=true;this.trialing.add(name);}
      }
    }
    return {track,range};
  }

  rememberItem(itemKey, key, nowMs) {
    this.items.delete(itemKey);this.items.set(itemKey,{key,at:nowMs});
    if(this.items.size>4096)this.items.delete(this.items.keys().next().value);
  }

  noteSegmentSeconds(session, seconds) {
    if(session.segmentSeconds!==seconds){session.segmentSeconds=seconds;this.queueReport(session,true);}
  }

  closeCycle(session, nowMs) {
    const hls=this.localOf(session).hls,open=hls.open;
    if(!open)return;
    hls.open=null;
    const cycleMs=nowMs-open.reqAt;
    if(cycleMs<=0)return;
    const headersAt=open.hdrAt||nowMs,endAt=open.endAt||nowMs;
    const upMs=Math.max(0,headersAt-open.reqAt)+Math.max(0,endAt-headersAt-open.blockedTicks*1000);
    hls.samples.push({reqAt:open.reqAt,cycleMs,upMs:Math.min(cycleMs,upMs),bytes:open.sent});
    if(hls.samples.length>32)hls.samples.shift();
    this.score(session,hlsVerdict(hls.samples,session.segmentSeconds,{nowMs,windowMs:this.params.hlsWindowMs,minSegments:this.params.minHlsSegments}),nowMs);
  }

  score(session, result, nowMs) {
    if(result.verdict==='unknown')return;
    session.scores[this.selfId]={verdict:result.verdict,rateBps:result.rateBps,at:nowMs};
    const local=this.localOf(session),changed=local.lastVerdict!==result.verdict;
    local.lastVerdict=result.verdict;
    if(changed||nowMs-local.lastReportAt>=this.params.reportEveryMs)this.queueReport(session,changed);
  }

  queueReport(session, urgent=false) {
    const own=session.scores[this.selfId],local=this.localOf(session);
    local.lastReportAt=this.now();
    this.reports.set(session.key,{s:session.key,r:session.routeId,verdict:own?.verdict||'unknown',rateBps:own?.rateBps||0,at:own?.at||this.now(),segmentSeconds:session.segmentSeconds||0,client:session.client,p:session.prefix||''});
    if(urgent)this.requestSync();
  }

  reassign(session, decision, nowMs) {
    const from=session.assigned||this.selfId;
    session.epoch+=1;session.assigned=decision.assigned;session.pending=null;
    if(decision.switched){
      session.lastSwitchAt=nowMs;
      session.switches=[...session.switches.filter(at=>nowMs-at<this.params.switchWindowMs),nowMs].slice(-10);
      session.tried[decision.target]=nowMs;
    }
    this.decisions.push({s:session.key,r:session.routeId,assigned:decision.assigned,epoch:session.epoch,switched:decision.switched===true,from,reason:decision.reason,fromRateBps:decision.fromRateBps||0,toRateBps:decision.toRateBps||0,client:session.client,at:nowMs});
    this.requestSync();
  }

  // A redirect nobody followed within the timeout: the client could not (or would not) reach the
  // target. Stop sending the session there and let the panel learn about this client type.
  checkPending(session, nowMs) {
    const pending=session.pending;
    if(!pending)return;
    if(pending.epoch!==session.epoch||(session.lastLanding&&session.lastLanding.epoch>=pending.epoch)){session.pending=null;return;}
    if(nowMs-pending.at<=this.params.landingTimeoutMs)return;
    session.pending=null;
    session.scores[pending.target]={verdict:'starved_down',rateBps:0,at:nowMs};
    this.failures.push({s:session.key,r:session.routeId,epoch:pending.epoch,target:pending.target,client:pending.client,at:nowMs});
    if(session.assigned===pending.target)this.reassign(session,{target:this.selfId,assigned:'',changed:true,switched:false,reason:'landing_timeout'},nowMs);
  }

  // A capped range that cut nothing, or never fully reached the client, proves nothing either way.
  dropBound(track) {
    if(track.bound?.trial)this.trialing.delete(String(track.bound.client).toLowerCase());
    track.bound=null;
  }

  boundResult(session, continued, nowMs) {
    const wait=session.local.boundWait;
    session.local.boundWait=null;
    if(wait.trial)this.trialing.delete(String(wait.client).toLowerCase());
    this.bounds.push({s:session.key,r:session.routeId,client:wait.client,continued,trial:wait.trial,at:nowMs});
    if(this.bounds.length>1000)this.bounds.splice(0,this.bounds.length-1000);
    this.requestSync();
  }

  startTicking() {
    if(this.ticker)return;
    this.ticker=setInterval(()=>this.tick(),1000);this.ticker.unref?.();
  }

  stopTicking() { clearInterval(this.ticker);this.ticker=null; }

  tick() {
    const nowMs=this.now(),windowTicks=this.params.progressiveWindowTicks;
    for(const track of this.tracks)if(track.res?.writableNeedDrain)track.blockedTicks++;
    for(const session of this.sessions.values()){
      const prog=session.local?.prog;
      if(prog&&(prog.active.size||prog.ticks.length)&&(prog.active.size||nowMs-prog.lastServedAt<=this.params.detachMs)){
        let blocked=false;
        for(const track of prog.active)if(track.res?.writableNeedDrain){blocked=true;break;}
        const active=prog.active.size>0,bytes=prog.tickBytes;
        prog.tickBytes=0;
        prog.ticks.push({bytes,idle:!active||(bytes===0&&blocked),blocked:active&&blocked});
        if(prog.ticks.length>windowTicks)prog.ticks.shift();
        if(prog.ticks.length>=windowTicks)this.score(session,progressiveVerdict(prog.ticks,{windowTicks,minRateMbps:session.minRateMbps}),nowMs);
      }
      if(session.pending)this.checkPending(session,nowMs);
      if(session.local?.boundWait&&nowMs-session.local.boundWait.at>this.params.boundContinueMs)this.boundResult(session,false,nowMs);
      if(nowMs-session.lastSeen>this.params.sessionTtlMs&&!prog?.active.size)this.sessions.delete(session.key);
    }
    for(const [itemKey,entry] of this.items){if(nowMs-entry.at<=this.params.sessionTtlMs)break;this.items.delete(itemKey);}
    if(!this.sessions.size&&!this.tracks.size)this.stopTicking();
  }

  activeSessions(nowMs=this.now()) {
    let count=0;
    for(const session of this.sessions.values())if(nowMs-session.lastSeen<=60_000)count++;
    return count;
  }

  syncPayload(routes) {
    const health={routes:{}};
    for(const route of routes)health.routes[route.id]={line:this.lineOf(route),quotaExhausted:!this.canServe(route)};
    const reports=[...this.reports.values()].slice(0,200);
    for(const report of reports)this.reports.delete(report.s);
    return {protocolVersion:1,cursor:this.cursor,reports,decisions:this.decisions.splice(0,200),landings:this.landings.splice(0,200),failures:this.failures.splice(0,200),shadow:this.shadow.splice(0,200),bounds:this.bounds.splice(0,200),health};
  }

  // A failed sync must not lose decisions/landings: put them back in front (reports are superseded by
  // fresher ones anyway).
  requeue(payload) {
    for(const list of ['decisions','landings','failures','shadow','bounds']){
      this[list].unshift(...(payload[list]||[]));
      if(this[list].length>1000)this[list].splice(0,this[list].length-1000);
    }
  }

  applySync(response) {
    if(!response||typeof response!=='object')return;
    const serverTime=Number(response.serverTime);
    if(Number.isFinite(serverTime)&&serverTime>0)this.offsetMs=serverTime-this.clock();
    if(Number.isSafeInteger(response.cursor)&&response.cursor>=0)this.cursor=response.cursor;
    for(const remote of Array.isArray(response.sessions)?response.sessions:[])this.mergeSession(remote);
    if(Array.isArray(response.peers))this.health=new Map(response.peers.map(peer=>[String(peer?.id||''),{healthy:peer?.healthy===true,at:Number(peer?.at)||0,routes:peer?.routes&&typeof peer.routes==='object'?peer.routes:{}}]));
    if(Array.isArray(response.excludedClients))this.excluded=new Set(response.excludedClients.map(client=>String(client).toLowerCase()));
    if(Array.isArray(response.boundedClients))this.bounded=new Set(response.boundedClients.map(client=>String(client).toLowerCase()));
    if(Array.isArray(response.trialClients))this.trials=new Set(response.trialClients.map(client=>String(client).toLowerCase()));
    if(Number.isSafeInteger(response.boundBytes)&&response.boundBytes>=1024*1024)this.boundBytes=response.boundBytes;
  }

  mergeSession(remote) {
    const key=String(remote?.s||'');
    if(!SESSION_KEY_RE.test(key))return;
    const session=this.session(key,String(remote.r||''),Number(remote.lastSeen)||this.now());
    const epoch=Number(remote.epoch)||0,assigned=String(remote.assigned||'');
    // The panel is the arbiter: a newer epoch always wins, and at the same epoch its choice wins.
    if(epoch>session.epoch||(epoch===session.epoch&&assigned!==session.assigned)){
      session.epoch=epoch;session.assigned=assigned;session.lastSwitchAt=Number(remote.lastSwitchAt)||0;
      session.switches=Array.isArray(remote.switches)?remote.switches.map(Number).filter(Number.isFinite).slice(-10):[];
    }
    for(const [id,score] of Object.entries(remote.scores&&typeof remote.scores==='object'?remote.scores:{})){
      if(id===this.selfId)continue;
      const at=Number(score?.at)||0;
      if(!session.scores[id]||at>session.scores[id].at)session.scores[id]={verdict:VERDICTS.includes(score?.verdict)?score.verdict:'unknown',rateBps:Number(score?.rateBps)||0,at};
    }
    for(const [id,at] of Object.entries(remote.tried&&typeof remote.tried==='object'?remote.tried:{}))session.tried[id]=Math.max(session.tried[id]||0,Number(at)||0);
    if(!session.segmentSeconds&&Number(remote.segmentSeconds)>0)session.segmentSeconds=Number(remote.segmentSeconds);
    if(remote.prior&&typeof remote.prior==='object'){
      session.prior={};
      for(const [id,seen] of Object.entries(remote.prior).slice(0,32)){const n=Math.floor(Number(seen?.n)||0),ok=Number(seen?.ok);if(n>0&&ok>=0&&ok<=1)session.prior[id]={ok,n};}
    }
    if(remote.lastLanding&&(!session.lastLanding||Number(remote.lastLanding.at)>session.lastLanding.at))session.lastLanding={epoch:Number(remote.lastLanding.epoch)||0,at:Number(remote.lastLanding.at)||0};
    session.lastSeen=Math.max(session.lastSeen,Number(remote.lastSeen)||0);
  }

  // `send(payload) -> response` is the transport: a signed HTTPS call on agents, a direct hub call on
  // the panel. `routes()` returns the live route list; nothing is sent while no route steers.
  start(send, routes) {
    this.send=send;this.routes=routes;this.scheduleSync(1000);
  }

  stop() { clearTimeout(this.syncTimer);this.syncTimer=null;this.send=null;this.stopTicking(); }

  requestSync() {
    if(!this.send||this.syncing)return;
    if(this.syncDue&&this.syncDue<=this.clock()+this.params.syncDebounceMs)return;
    this.scheduleSync(this.params.syncDebounceMs);
  }

  scheduleSync(delay) {
    clearTimeout(this.syncTimer);
    this.syncDue=this.clock()+delay;
    this.syncTimer=setTimeout(()=>{this.syncDue=0;this.runSync()},delay);this.syncTimer.unref?.();
  }

  async runSync() {
    if(!this.send)return;
    const routes=this.routes().filter(route=>route.steering);
    if(!routes.length){this.scheduleSync(this.params.syncIdleMs);return;}
    this.syncing=true;
    const payload=this.syncPayload(routes);
    let next;
    try {
      this.applySync(await this.send(payload));
      this.syncErrors=0;this.lastSyncError='';this.lastSyncAt=this.clock();
      next=this.decisions.length||this.landings.length||this.failures.length?this.params.syncDebounceMs:(this.activeSessions()?this.params.syncActiveMs:this.params.syncIdleMs);
    } catch(error) {
      this.requeue(payload);this.syncErrors++;this.lastSyncError=String(error?.message||error).slice(0,160);
      next=Math.min(this.params.syncMaxBackoffMs,2000*2**Math.min(this.syncErrors,8));
    } finally { this.syncing=false; }
    if(this.send)this.scheduleSync(next);
  }
}
