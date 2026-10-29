import { LOCAL_AGENT_ID, remoteAgentStatus } from './agent-registry.js';
import { STEERING_CAPABILITY, VERDICTS } from './steering.js';
import { excludedClients, normalizeClientList, readSteeringSettings } from './steering-topology.js';

// Panel side of automatic steering: merges what every machine measured and decided, arbitrates
// conflicting reassignments by epoch, and hands each machine back the sessions of the nodes it serves
// plus the health of its peers. Held in memory only — losing it on a restart just resets sessions to
// "served wherever they land", which never interrupts a playback.

const SESSION_KEY_RE=/^[A-Za-z0-9_-]{22}$/;
const BATCH=200;
const LANDING_SAMPLE=20,LANDING_MIN_SAMPLE=10,LANDING_MIN_RATIO=0.8;
const list=value=>Array.isArray(value)?value.slice(0,BATCH):[];
const text=(value,max=80)=>String(value||'').replace(/[\r\n\0]/g,'').trim().slice(0,max);
const number=(value,min=0,max=Number.MAX_SAFE_INTEGER)=>{const n=Number(value);return Number.isFinite(n)?Math.min(max,Math.max(min,n)):min};

export class SteeringHub {
  constructor({store, clock=()=>Date.now(), sessionTtlMs=30*60_000, onAutoExclude=null}={}) {
    this.store=store;this.clock=clock;this.sessionTtlMs=sessionTtlMs;this.onAutoExclude=onAutoExclude;
    this.sessions=new Map();this.seq=0;this.health=new Map();this.events=[];this.clients=new Map();
  }

  deployedRoutes(agentId) {
    return new Set((this.store.data.deployments||[]).filter(item=>item.agentId===agentId&&item.enabled!==false).map(item=>item.routeId));
  }

  routeAgents(routeId) {
    return new Set((this.store.data.deployments||[]).filter(item=>item.routeId===routeId&&item.enabled!==false).map(item=>item.agentId));
  }

  touch(key, routeId, now) {
    let session=this.sessions.get(key);
    if(!session){session={key,routeId,assigned:'',epoch:0,lastSwitchAt:0,switches:[],scores:{},tried:{},segmentSeconds:0,lastLanding:null,landedEpoch:-1,failedEpoch:-1,client:'',lastSeen:now,seq:0};this.sessions.set(key,session);}
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
    for(const [key,session] of this.sessions)if(now-session.lastSeen>this.sessionTtlMs)this.sessions.delete(key);
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
      session.scores[agentId]={verdict:report.verdict,rateBps:Math.round(number(report.rateBps,0,1e11)),at:Math.min(now,number(report.at))};
      const seconds=number(report.segmentSeconds,0,60);if(seconds>0)session.segmentSeconds=seconds;
      if(report.client)session.client=text(report.client);
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
      const at=Math.min(now,number(decision.at));
      session.epoch=epoch;session.assigned=assigned;
      if(decision.switched===true){
        session.lastSwitchAt=at;session.switches=[...session.switches,at].slice(-10);
        if(assigned)session.tried[assigned]=at;
      }
      this.bump(session);
      this.event({at,routeId:session.routeId,session:session.key.slice(0,6),from:text(decision.from,64),to:assigned,reason:text(decision.reason,32),fromRateBps:number(decision.fromRateBps),toRateBps:number(decision.toRateBps),client:text(decision.client),mode:'on',reporter:agentId});
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
      this.event({at:Math.min(now,number(failure.at)),routeId:session.routeId,session:session.key.slice(0,6),from:agentId,to:text(failure.target,64),reason:'landing_timeout',fromRateBps:0,toRateBps:0,client:text(failure.client||session.client),mode:'on',reporter:agentId});
    }
    for(const item of list(payload?.shadow)){
      const routeId=String(item?.r||'');
      if(!deployed.has(routeId))continue;
      this.event({at:Math.min(now,number(item.at)),routeId,session:String(item.s||'').slice(0,6),from:agentId,to:text(item.to,64),reason:text(item.reason,32),fromRateBps:number(item.fromRateBps),toRateBps:number(item.toRateBps),client:text(item.client),mode:'shadow',reporter:agentId});
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
      sessions:changed.map(session=>({s:session.key,r:session.routeId,assigned:session.assigned,epoch:session.epoch,lastSwitchAt:session.lastSwitchAt,switches:session.switches,scores:session.scores,tried:session.tried,segmentSeconds:session.segmentSeconds,lastLanding:session.lastLanding,lastSeen:session.lastSeen})),
      peers:this.peers(),
      excludedClients:excludedClients(settings),
      boundedClients:normalizeClientList(settings.boundedClients),boundBytes:settings.boundMB*1024*1024
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
      .map(session=>({session:session.key.slice(0,6),routeId:session.routeId,assigned:session.assigned,epoch:session.epoch,client:session.client,lastSeen:session.lastSeen,lastSwitchAt:session.lastSwitchAt,scores:session.scores}));
    const settings=readSteeringSettings(this.store.data),auto=new Set(Object.keys(settings.autoExcluded).map(item=>item.toLowerCase()));
    const clients=[...this.clients.values()].map(stat=>{const landed=stat.results.filter(Boolean).length;return{client:stat.client,total:stat.results.length,landed,autoExcluded:auto.has(stat.client.toLowerCase())}});
    return {sessions,events:this.events.slice(-50).reverse(),clients,machines:this.peers()};
  }
}
