// The steering sync: what every machine's steering engine (steering.js) and the panel's hub
// (steering-hub.js) tell each other, in both directions. A machine reports what it measured and
// decided; the panel answers with the sessions that changed since the machine last asked, its peers'
// health and the client lists. Panel and machines of different versions talk to each other, so the
// shape on the wire only ever grows, and what one side reads is cleaned here, in one place.
//
// The transport is `send(payload) -> response`: a signed HTTPS call on agents (agent-main.js) and
// localTransport() on the panel machine and in tests.

const VERDICTS=Object.freeze(['ok','starved_down','starved_up','unknown']);
export const SESSION_KEY_RE=/^[A-Za-z0-9_-]{22}$/;
const PREFIX_KEY_RE=/^[A-Za-z0-9_-]{16}$/;
const PROTOCOL_VERSION=1;
const BATCH=200;
const QUEUE_MAX=1000;
// The event lists a machine reports, each in the order it happened. A sync that fails puts them back
// in front; speed reports are not put back, a fresher one supersedes them.
const EVENT_LISTS=Object.freeze(['decisions','landings','failures','shadow','rangeEvents','playbackEvents']);

const list=value=>Array.isArray(value)?value.slice(0,BATCH):[];
const text=(value,max=80)=>String(value||'').replace(/[\r\n\0]/g,'').trim().slice(0,max);
const number=(value,min=0,max=Number.MAX_SAFE_INTEGER)=>{const n=Number(value);return Number.isFinite(n)?Math.min(max,Math.max(min,n)):min};
const object=value=>value&&typeof value==='object'?value:{};

// --- Machine to panel ---

// The next report from a machine's queues (its speed reports by session, its event lists, its cursor),
// taken off them.
export function takeReport(queues, health) {
  const reports=[...queues.reports.values()].slice(0,BATCH);
  for(const report of reports)queues.reports.delete(report.s);
  return {protocolVersion:PROTOCOL_VERSION,cursor:queues.cursor,reports,...Object.fromEntries(EVENT_LISTS.map(name=>[name,queues[name].splice(0,BATCH)])),health};
}

export function requeueReport(queues, payload) {
  for(const name of EVENT_LISTS){
    queues[name].unshift(...(payload?.[name]||[]));
    if(queues[name].length>QUEUE_MAX)queues[name].splice(0,queues[name].length-QUEUE_MAX);
  }
}

// A report as the panel reads it: every field typed and bounded. Whether a session or a machine may be
// spoken for, and times later than the panel's own clock, are the hub's to judge.
export function readReport(payload) {
  const value=object(payload),key=item=>({s:String(item?.s||''),r:String(item?.r||'')});
  const health={};
  for(const [routeId,route] of Object.entries(object(object(value.health).routes)))health[routeId]={line:Math.floor(number(route?.line,0,7)),quotaExhausted:route?.quotaExhausted===true};
  return {
    cursor:value.cursor,health,
    reports:list(value.reports).map(item=>({...key(item),verdict:VERDICTS.includes(item?.verdict)?item.verdict:null,at:number(item?.at),rateBps:Math.round(number(item?.rateBps,0,1e11)),
      segmentSeconds:number(item?.segmentSeconds,0,60),client:item?.client?text(item.client):null,p:PREFIX_KEY_RE.test(String(item?.p||''))?item.p:null})),
    decisions:list(value.decisions).map(item=>({...key(item),assigned:text(item?.assigned,64),epoch:Math.floor(number(item?.epoch)),at:number(item?.at),reason:text(item?.reason,32),switched:item?.switched===true,
      from:text(item?.from,64),fromRateBps:number(item?.fromRateBps),toRateBps:number(item?.toRateBps),client:text(item?.client)})),
    landings:list(value.landings).map(item=>({...key(item),epoch:Math.floor(number(item?.epoch)),at:number(item?.at),client:item?.client?text(item.client):''})),
    failures:list(value.failures).map(item=>({...key(item),epoch:Math.floor(number(item?.epoch)),at:number(item?.at),target:text(item?.target,64),client:item?.client?text(item.client):''})),
    shadow:list(value.shadow).map(item=>({...key(item),at:number(item?.at),to:text(item?.to,64),reason:text(item?.reason,32),fromRateBps:number(item?.fromRateBps),toRateBps:number(item?.toRateBps),client:text(item?.client)})),
    // Sent by machines older than 0.13.0, before capped-range continuations were judged by the hub.
    bounds:list(value.bounds).map(item=>({r:String(item?.r||''),client:item?.client,continued:item?.continued===true,trial:item?.trial===true})),
    // Cleaned where they are used (SteeringHub.rangeEvent, PlaybackObservation.ingest).
    rangeEvents:list(value.rangeEvents).filter(item=>item?.phase==='request'||item?.phase==='complete'),
    playbackEvents:list(value.playbackEvents)
  };
}

// --- Panel to machine ---

// The part of a session both sides keep, as the panel hands it out.
export function sessionUpdate(session, prior) {
  return {s:session.key,r:session.routeId,assigned:session.assigned,epoch:session.epoch,lastSwitchAt:session.lastSwitchAt,switches:session.switches,scores:session.scores,tried:session.tried,segmentSeconds:session.segmentSeconds,lastLanding:session.lastLanding,lastSeen:session.lastSeen,prior};
}

export function syncResponse({serverTime,cursor,sessions,peers,excludedClients,boundedClients,trialClients,boundBytes}) {
  return {protocolVersion:PROTOCOL_VERSION,serverTime,cursor,sessions,peers,excludedClients,boundedClients,trialClients,boundBytes};
}

// A session update as a machine reads it; null when the key is not a session key.
function readSessionUpdate(remote) {
  const key=String(remote?.s||'');
  if(!SESSION_KEY_RE.test(key))return null;
  const scores={},tried={};
  for(const [id,score] of Object.entries(object(remote.scores)))scores[id]={verdict:VERDICTS.includes(score?.verdict)?score.verdict:'unknown',rateBps:Number(score?.rateBps)||0,at:Number(score?.at)||0};
  for(const [id,at] of Object.entries(object(remote.tried)))tried[id]=Number(at)||0;
  let prior=null;
  if(remote.prior&&typeof remote.prior==='object'){
    prior={};
    for(const [id,seen] of Object.entries(remote.prior).slice(0,32)){const n=Math.floor(Number(seen?.n)||0),ok=Number(seen?.ok);if(n>0&&ok>=0&&ok<=1)prior[id]={ok,n};}
  }
  return {
    key,routeId:String(remote.r||''),epoch:Number(remote.epoch)||0,assigned:String(remote.assigned||''),lastSwitchAt:Number(remote.lastSwitchAt)||0,
    switches:Array.isArray(remote.switches)?remote.switches.map(Number).filter(Number.isFinite).slice(-10):[],scores,tried,
    segmentSeconds:Number(remote.segmentSeconds)>0?Number(remote.segmentSeconds):0,prior,
    lastLanding:remote.lastLanding?{epoch:Number(remote.lastLanding.epoch)||0,at:Number(remote.lastLanding.at)||0}:null,lastSeen:Number(remote.lastSeen)||0
  };
}

// A response as a machine reads it; null when it is not one. A part that is missing or malformed is left
// undefined, so the machine keeps what it had.
export function readSyncResponse(response) {
  if(!response||typeof response!=='object')return null;
  const serverTime=Number(response.serverTime),clients=value=>Array.isArray(value)?value.map(client=>String(client).toLowerCase()):undefined;
  return {
    serverTime:Number.isFinite(serverTime)&&serverTime>0?serverTime:undefined,
    cursor:Number.isSafeInteger(response.cursor)&&response.cursor>=0?response.cursor:undefined,
    sessions:(Array.isArray(response.sessions)?response.sessions:[]).map(readSessionUpdate).filter(Boolean),
    peers:Array.isArray(response.peers)?response.peers.map(peer=>({id:String(peer?.id||''),healthy:peer?.healthy===true,at:Number(peer?.at)||0,routes:peer?.routes&&typeof peer.routes==='object'?peer.routes:{}})):undefined,
    excludedClients:clients(response.excludedClients),boundedClients:clients(response.boundedClients),trialClients:clients(response.trialClients),
    boundBytes:Number.isSafeInteger(response.boundBytes)&&response.boundBytes>=1024*1024?response.boundBytes:undefined
  };
}

// The panel machine's transport, and the in-memory one in tests: the hub answers directly, but both
// ways go through JSON exactly as they would over the wire, so nothing is shared between the two sides.
export function localTransport(hub, agentId) {
  return payload=>JSON.parse(JSON.stringify(hub.exchange(agentId,JSON.parse(JSON.stringify(payload)))));
}
