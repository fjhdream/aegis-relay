import { LOCAL_AGENT_ID, remoteAgentStatus } from './agent-registry.js';
import { STEERING_CAPABILITY, STEER_DEFAULTS, VERDICTS } from './steering.js';
import { boundedClientList, excludedClients, readSteeringSettings } from './steering-topology.js';

// Panel side of automatic steering: merges what every machine measured and decided, arbitrates
// conflicting reassignments by epoch, and hands each machine back the sessions of the nodes it serves
// plus the health of its peers. Held in memory only — losing it on a restart just resets sessions to
// "served wherever they land", which never interrupts a playback.

const SESSION_KEY_RE=/^[A-Za-z0-9_-]{22}$/,PREFIX_KEY_RE=/^[A-Za-z0-9_-]{16}$/;
const BATCH=200;
const LANDING_SAMPLE=20,LANDING_MIN_SAMPLE=10,LANDING_MIN_RATIO=0.8;
// Per client network and machine: how often playback went well. One sample per session and machine a
// minute at most, so a single long playback cannot drown out everybody else on that network.
const HISTORY_MAX=5000,HISTORY_TTL_MS=7*24*3600_000,HISTORY_EVERY_MS=60_000;
// Switch outcomes. A real switch is judged by the first verdict at its target; a shadow ("would have
// switched") one by whether the line it stayed on recovered by itself within RECOVER_MS.
const EFFECT_RING=200,EFFECT_TIMEOUT_MS=10*60_000,RECOVER_MS=180_000,PERSIST_MS=120_000;
// Silence also means pause/stop/cache; only a matched next-byte request proves compatibility.
const BOUND_SAMPLE=10,BOUND_PENDING=32,TRIAL_SUCCESSES=3,TRIAL_MIN_LANDINGS=5,TRIAL_MIN_LANDED=0.9;
const list=value=>Array.isArray(value)?value.slice(0,BATCH):[];
const text=(value,max=80)=>String(value||'').replace(/[\r\n\0]/g,'').trim().slice(0,max);
const number=(value,min=0,max=Number.MAX_SAFE_INTEGER)=>{const n=Number(value);return Number.isFinite(n)?Math.min(max,Math.max(min,n)):min};
const median=values=>{const sorted=[...values].sort((left,right)=>left-right);return sorted.length?Math.round(sorted[Math.floor(sorted.length/2)]*10)/10:0};

export class SteeringHub {
  constructor({store, clock=()=>Date.now(), sessionTtlMs=30*60_000, onAutoExclude=null, onBoundVerdict=null}={}) {
    this.store=store;this.clock=clock;this.sessionTtlMs=sessionTtlMs;this.onAutoExclude=onAutoExclude;this.onBoundVerdict=onBoundVerdict;
    this.sessions=new Map();this.seq=0;this.health=new Map();this.events=[];this.clients=new Map();
    this.history=new Map();this.effects={on:[],shadow:[]};this.bounds=new Map();
  }

  deployedRoutes(agentId) {
    return new Set((this.store.data.deployments||[]).filter(item=>item.agentId===agentId&&item.enabled!==false).map(item=>item.routeId));
  }

  routeAgents(routeId) {
    return new Set((this.store.data.deployments||[]).filter(item=>item.routeId===routeId&&item.enabled!==false).map(item=>item.agentId));
  }

  touch(key, routeId, now) {
    let session=this.sessions.get(key);
    if(!session){session={key,routeId,assigned:'',epoch:0,lastSwitchAt:0,switches:[],scores:{},tried:{},segmentSeconds:0,lastLanding:null,landedEpoch:-1,failedEpoch:-1,client:'',lastSeen:now,seq:0,prefix:'',learnedAt:{},effect:null,shadowEffect:null};this.sessions.set(key,session);}
    session.lastSeen=now;
    return session;
  }

  bump(session) { session.seq=++this.seq; }

  event(entry) {
    this.events.push(entry);
    if(this.events.length>100)this.events.splice(0,this.events.length-100);
  }

  // One redirect outcome per reassignment, per client type. A client that keeps failing to follow
  // steering redirects is excluded automatically — the most direct compatibility test there is.
  outcome(client, landed) {
    const name=text(client);
    if(!name)return;
    const key=name.toLowerCase(),stat=this.clients.get(key)||{client:name,results:[]};
    stat.results.push(landed);
    if(stat.results.length>LANDING_SAMPLE)stat.results.shift();
    this.clients.set(key,stat);
    const ok=stat.results.filter(Boolean).length;
    if(stat.results.length>=LANDING_MIN_SAMPLE&&ok/stat.results.length<LANDING_MIN_RATIO){
      const settings=readSteeringSettings(this.store.data);
      if(!Object.keys(settings.autoExcluded).some(item=>item.toLowerCase()===key))this.onAutoExclude?.(name);
    }
  }

  prune(now) {
    for(const [key,session] of this.sessions){
      const gone=now-session.lastSeen>this.sessionTtlMs;
      if(session.effect&&(gone||now-session.effect.at>EFFECT_TIMEOUT_MS)){this.effectDone('on',session.effect,'unmeasured');session.effect=null;}
      if(session.shadowEffect&&(gone||now-session.shadowEffect.at>EFFECT_TIMEOUT_MS)){this.effectDone('shadow',session.shadowEffect,'unmeasured');session.shadowEffect=null;}
      if(gone)this.sessions.delete(key);
    }
  }

  // History is per node and per client network digest; the panel never sees an address.
  learn(session, agentId, verdict, at) {
    // A starving origin says nothing about the line to this network.
    if(!session.prefix||(verdict!=='ok'&&verdict!=='starved_down'))return;
    if(at-(session.learnedAt[agentId]||0)<HISTORY_EVERY_MS)return;
    session.learnedAt[agentId]=at;
    const key=`${session.routeId}\n${session.prefix}`,entry=this.history.get(key)||{at,machines:{}},seen=entry.machines[agentId]||{ok:0,n:0,at};
    // A plain mean over the first samples, then a moving average that follows the line as it changes.
    seen.ok+=(Number(verdict==='ok')-seen.ok)*Math.max(0.2,1/(seen.n+1));seen.n=Math.min(1000,seen.n+1);seen.at=at;
    entry.machines[agentId]=seen;entry.at=at;
    this.history.delete(key);this.history.set(key,entry);
    if(this.history.size>HISTORY_MAX)this.history.delete(this.history.keys().next().value);
  }

  prior(session, now) {
    const entry=session.prefix?this.history.get(`${session.routeId}\n${session.prefix}`):null;
    if(!entry||now-entry.at>HISTORY_TTL_MS)return undefined;
    const out={};
    for(const [id,seen] of Object.entries(entry.machines))if(now-seen.at<=HISTORY_TTL_MS)out[id]={ok:Math.round(seen.ok*100)/100,n:seen.n};
    return out;
  }

  effectDone(kind, effect, result, gain=0) {
    const ring=this.effects[kind];
    ring.push({at:effect.at,routeId:effect.routeId,from:effect.from,to:effect.to,reason:effect.reason,result,gain});
    if(ring.length>EFFECT_RING)ring.splice(0,ring.length-EFFECT_RING);
  }

  // A fresh verdict from the machine an outcome is waiting on.
  settle(session, agentId, verdict, rateBps, at) {
    const effect=session.effect;
    if(effect&&agentId===effect.to&&at>effect.at&&verdict!=='unknown'){
      session.effect=null;
      this.effectDone('on',effect,verdict==='ok'?'better':verdict==='starved_down'?'worse':'upstream',effect.fromRateBps>0&&rateBps>0?rateBps/effect.fromRateBps:0);
    }
    const shadow=session.shadowEffect;
    if(shadow&&agentId===shadow.from&&at>shadow.at&&verdict!=='unknown'){
      const elapsed=at-shadow.at;
      if(verdict==='ok'&&elapsed<=RECOVER_MS){session.shadowEffect=null;this.effectDone('shadow',shadow,'recovered');}
      else if(elapsed>=PERSIST_MS){session.shadowEffect=null;this.effectDone('shadow',shadow,'persisted');}
    }
  }

  bound(client, continued, trial) {
    // Older agents treated every timeout as failure, including normal stops and peer continuations.
    if(continued!==true)return;
    const name=text(client);
    if(!name)return;
    const key=name.toLowerCase(),stat=this.bounds.get(key)||{client:name,results:[],trials:[]},list=trial?stat.trials:stat.results;
    list.push(continued);
    if(list.length>BOUND_SAMPLE)list.shift();
    this.bounds.set(key,stat);
    if(trial&&stat.trials.length>=TRIAL_SUCCESSES&&stat.trials.slice(-TRIAL_SUCCESSES).every(Boolean))return this.onBoundVerdict?.(name,true);
  }

  rangeEvent(session, item, now) {
    const complete=item.phase==='complete',start=item.start,end=item.end;
    if(!Number.isSafeInteger(start)||start<0||complete&&(!Number.isSafeInteger(end)||end<start||!Number.isSafeInteger(end+1)))return;
    const at=Math.min(now,number(item.at)),requestAt=complete?number(item.requestAt):at;
    if(!at||now-at>this.sessionTtlMs||complete&&(!requestAt||requestAt>at||!text(item.client)))return;
    const offset=complete?end+1:start,ranges=session.ranges||=new Map(),entry=ranges.get(offset)||{startedAt:0,complete:null,done:false};
    if(complete){
      if(entry.complete&&entry.complete.at>=at)return;
      entry.complete={at,requestAt,client:text(item.client),trial:item.trial===true};entry.done=false;
    }else entry.startedAt=Math.max(entry.startedAt,at);
    ranges.delete(offset);ranges.set(offset,entry);
    if(ranges.size>BOUND_PENDING)ranges.delete(ranges.keys().next().value);
    const delivered=entry.complete;
    if(!entry.done&&delivered&&entry.startedAt>=delivered.requestAt&&Math.abs(entry.startedAt-delivered.at)<=this.sessionTtlMs){
      entry.done=true;this.bound(delivered.client,true,delivered.trial);
    }
  }

  // Client types put on trial for capped ranges: only with automatic detection on, and only ones that
  // have already shown they follow steering redirects reliably.
  trialClients(settings) {
    if(!settings.boundAuto||settings.mode!=='on')return [];
    const decided=new Set([...settings.boundedClients,...Object.keys(settings.autoBounded),...Object.keys(settings.autoUnbounded),...excludedClients(settings)].map(client=>client.toLowerCase()));
    return [...this.clients.values()].filter(stat=>stat.results.length>=TRIAL_MIN_LANDINGS&&stat.results.filter(Boolean).length/stat.results.length>=TRIAL_MIN_LANDED&&!decided.has(stat.client.toLowerCase())).slice(0,8).map(stat=>stat.client);
  }

  exchange(agentId, payload={}) {
    const now=this.clock(),deployed=this.deployedRoutes(agentId);
    this.prune(now);
    const routes={};
    for(const [routeId,health] of Object.entries(payload?.health?.routes&&typeof payload.health.routes==='object'?payload.health.routes:{})){
      if(deployed.has(routeId))routes[routeId]={line:Math.floor(number(health?.line,0,7)),quotaExhausted:health?.quotaExhausted===true};
    }
    this.health.set(agentId,{at:now,routes});
    const sessionFor=item=>{
      const key=String(item?.s||''),routeId=String(item?.r||'');
      return SESSION_KEY_RE.test(key)&&deployed.has(routeId)?this.touch(key,routeId,now):null;
    };
    for(const report of list(payload?.reports)){
      const session=sessionFor(report);
      if(!session||!VERDICTS.includes(report.verdict))continue;
      // A machine only ever speaks for its own line to the client.
      const at=Math.min(now,number(report.at)),rateBps=Math.round(number(report.rateBps,0,1e11));
      session.scores[agentId]={verdict:report.verdict,rateBps,at};
      const seconds=number(report.segmentSeconds,0,60);if(seconds>0)session.segmentSeconds=seconds;
      if(report.client)session.client=text(report.client);
      if(PREFIX_KEY_RE.test(String(report.p||'')))session.prefix=report.p;
      this.learn(session,agentId,report.verdict,at);
      this.settle(session,agentId,report.verdict,rateBps,at);
      this.bump(session);
    }
    for(const decision of list(payload?.decisions)){
      const session=sessionFor(decision);
      if(!session)continue;
      const assigned=text(decision.assigned,64),epoch=Math.floor(number(decision.epoch));
      if(assigned&&!this.routeAgents(session.routeId).has(assigned))continue;
      // Concurrent reassignments: the first one to reach a new epoch wins; the loser learns the
      // winner from this very response.
      if(epoch<=session.epoch)continue;
      const at=Math.min(now,number(decision.at)),reason=text(decision.reason,32);
      session.epoch=epoch;session.assigned=assigned;
      // A newer reassignment ends the wait on the previous switch's outcome.
      if(session.effect){this.effectDone('on',session.effect,reason==='landing_timeout'?'not_landed':'unmeasured');session.effect=null;}
      if(decision.switched===true){
        session.lastSwitchAt=at;session.switches=[...session.switches,at].slice(-10);
        if(assigned)session.tried[assigned]=at;
        if(assigned)session.effect={epoch,at,routeId:session.routeId,from:text(decision.from,64)||agentId,to:assigned,reason,fromRateBps:number(decision.fromRateBps)};
      }
      this.bump(session);
      this.event({at,routeId:session.routeId,session:session.key.slice(0,6),from:text(decision.from,64),to:assigned,reason,fromRateBps:number(decision.fromRateBps),toRateBps:number(decision.toRateBps),client:text(decision.client),mode:'on',reporter:agentId});
    }
    for(const landing of list(payload?.landings)){
      const session=sessionFor(landing);
      if(!session)continue;
      const epoch=Math.floor(number(landing.epoch)),at=Math.min(now,number(landing.at));
      session.lastLanding={epoch,at};
      if(session.landedEpoch!==epoch){session.landedEpoch=epoch;this.outcome(landing.client||session.client,true);}
      this.bump(session);
    }
    for(const failure of list(payload?.failures)){
      const session=sessionFor(failure);
      if(!session)continue;
      const epoch=Math.floor(number(failure.epoch));
      if(session.failedEpoch===epoch)continue;
      session.failedEpoch=epoch;
      this.outcome(failure.client||session.client,false);
      if(session.effect?.epoch===epoch){this.effectDone('on',session.effect,'not_landed');session.effect=null;}
      this.event({at:Math.min(now,number(failure.at)),routeId:session.routeId,session:session.key.slice(0,6),from:agentId,to:text(failure.target,64),reason:'landing_timeout',fromRateBps:0,toRateBps:0,client:text(failure.client||session.client),mode:'on',reporter:agentId});
    }
    for(const item of list(payload?.shadow)){
      const routeId=String(item?.r||'');
      if(!deployed.has(routeId))continue;
      const session=sessionFor(item),at=Math.min(now,number(item.at));
      if(session&&!session.shadowEffect)session.shadowEffect={at,routeId,from:agentId,to:text(item.to,64),reason:text(item.reason,32)};
      this.event({at:Math.min(now,number(item.at)),routeId,session:String(item.s||'').slice(0,6),from:agentId,to:text(item.to,64),reason:text(item.reason,32),fromRateBps:number(item.fromRateBps),toRateBps:number(item.toRateBps),client:text(item.client),mode:'shadow',reporter:agentId});
    }
    for(const item of list(payload?.bounds)){
      if(deployed.has(String(item?.r||'')))this.bound(item.client,item.continued===true,item.trial===true);
    }
    for(const item of list(payload?.rangeEvents)){
      if(item?.phase!=='request'&&item?.phase!=='complete')continue;
      const session=sessionFor(item);if(session)this.rangeEvent(session,item,now);
    }
    return this.response(agentId,deployed,payload?.cursor,now);
  }

  response(agentId, deployed, cursorValue, now) {
    // A cursor from before a panel restart is meaningless; start over and send everything.
    const cursor=Number.isSafeInteger(cursorValue)&&cursorValue>=0&&cursorValue<=this.seq?cursorValue:0;
    const changed=[...this.sessions.values()].filter(session=>session.seq>cursor&&deployed.has(session.routeId)).sort((left,right)=>left.seq-right.seq).slice(0,BATCH);
    const settings=readSteeringSettings(this.store.data);
    return {
      protocolVersion:1,serverTime:now,cursor:changed.length===BATCH?changed.at(-1).seq:this.seq,
      sessions:changed.map(session=>({s:session.key,r:session.routeId,assigned:session.assigned,epoch:session.epoch,lastSwitchAt:session.lastSwitchAt,switches:session.switches,scores:session.scores,tried:session.tried,segmentSeconds:session.segmentSeconds,lastLanding:session.lastLanding,lastSeen:session.lastSeen,prior:this.prior(session,now)})),
      peers:this.peers(),
      excludedClients:excludedClients(settings),
      boundedClients:boundedClientList(settings),trialClients:this.trialClients(settings),boundBytes:settings.boundMB*1024*1024
    };
  }

  peers() {
    const out=[];
    for(const agent of this.store.data.agents||[]){
      if(agent.state==='revoked')continue;
      const local=agent.id===LOCAL_AGENT_ID,health=this.health.get(agent.id);
      const healthy=local||(remoteAgentStatus(agent)==='online'&&agent.proxyHealthy===true&&Array.isArray(agent.capabilities)&&agent.capabilities.includes(STEERING_CAPABILITY)&&Number(agent.desiredRevision||0)===Number(agent.appliedRevision||0));
      out.push({id:agent.id,healthy,at:health?.at||0,routes:health?.routes||{}});
    }
    return out;
  }

  view(now=this.clock()) {
    const sessions=[...this.sessions.values()].filter(session=>now-session.lastSeen<=10*60_000).sort((left,right)=>right.lastSeen-left.lastSeen).slice(0,100)
      .map(session=>({session:session.key.slice(0,6),routeId:session.routeId,assigned:session.assigned,epoch:session.epoch,client:session.client,lastSeen:session.lastSeen,lastSwitchAt:session.lastSwitchAt,scores:Object.fromEntries(Object.entries(session.scores).map(([id,score])=>[id,{...score,stale:now-score.at>STEER_DEFAULTS.verdictTtlMs}]))}));
    const settings=readSteeringSettings(this.store.data),auto=new Set(Object.keys(settings.autoExcluded).map(item=>item.toLowerCase()));
    const clients=[...this.clients.values()].map(stat=>{const landed=stat.results.filter(Boolean).length;return{client:stat.client,total:stat.results.length,landed,autoExcluded:auto.has(stat.client.toLowerCase())}});
    const bounded=new Set(boundedClientList(settings).map(client=>client.toLowerCase())),trials=new Set(this.trialClients(settings).map(client=>client.toLowerCase()));
    const ranges=[...this.bounds.values()].map(stat=>{const key=stat.client.toLowerCase();return{client:stat.client,continued:stat.results.filter(Boolean).length,total:stat.results.length,trialContinued:stat.trials.filter(Boolean).length,trialTotal:stat.trials.length,state:bounded.has(key)?'on':trials.has(key)?'trial':'off'}});
    return {sessions,events:this.events.slice(-50).reverse(),clients,ranges,effects:this.effectSummary(),networks:this.history.size,machines:this.peers()};
  }

  effectSummary() {
    const {on,shadow}=this.effects,count=(items,result)=>items.filter(item=>item.result===result).length;
    const gains=items=>items.filter(item=>item.result==='better'&&item.gain>0).map(item=>item.gain);
    const pairs=new Map();
    for(const item of on){const key=`${item.from}\n${item.to}`;if(!pairs.has(key))pairs.set(key,[]);pairs.get(key).push(item);}
    return {
      on:{total:on.length,better:count(on,'better'),worse:count(on,'worse'),upstream:count(on,'upstream'),notLanded:count(on,'not_landed'),unmeasured:count(on,'unmeasured'),medianGain:median(gains(on)),
        pairs:[...pairs.values()].map(items=>({from:items[0].from,to:items[0].to,total:items.length,better:count(items,'better'),worse:count(items,'worse'),medianGain:median(gains(items))})).sort((left,right)=>right.total-left.total)},
      shadow:{total:shadow.length,recovered:count(shadow,'recovered'),persisted:count(shadow,'persisted'),unmeasured:count(shadow,'unmeasured')}
    };
  }
}
