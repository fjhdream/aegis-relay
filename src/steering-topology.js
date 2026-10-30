import { isRouteAuthKey } from './route-auth.js';
import { LOCAL_AGENT_ID, routesForAgent } from './agent-registry.js';
import { EGRESS_CAPABILITY, STEERING_CAPABILITY, STEERING_MODES } from './steering.js';
import { PLAYBACK_OBSERVATION_CAPABILITY } from './playback-observation.js';

// Which machines may steer a node between them, and the settings behind it. Compiled into each
// machine's signed snapshot, so only static topology lives here; liveness travels over the steering sync.

const DOMAIN_RE=/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const compareUtf8=(left,right)=>Buffer.compare(Buffer.from(left,'utf8'),Buffer.from(right,'utf8'));

export function normalizeEntryDomain(value) {
  const domain=String(value||'').trim().toLowerCase().replace(/^https?:\/\//,'').replace(/\/+$/,'');
  if(!domain)return '';
  if(!DOMAIN_RE.test(domain))throw new Error('入口域名必须是完整的 DNS 域名，不带协议、端口或路径');
  return domain;
}

export function normalizeClientList(value) {
  const seen=new Set(),out=[];
  for(const item of Array.isArray(value)?value:String(value||'').split(/[\n,;]+/)){
    const name=String(item||'').replace(/[\r\n\0]/g,'').trim().slice(0,80);
    if(!name||seen.has(name.toLowerCase()))continue;
    seen.add(name.toLowerCase());out.push(name);
    if(out.length>=32)break;
  }
  return out;
}

export function readSteeringSettings(data) {
  const raw=data?.settings?.steering&&typeof data.settings.steering==='object'?data.settings.steering:{};
  const boundMB=Number(raw.boundMB);
  return {
    mode:STEERING_MODES.includes(raw.mode)?raw.mode:'off',
    entryDomain:typeof raw.entryDomain==='string'?raw.entryDomain:'',
    excludedClients:Array.isArray(raw.excludedClients)?raw.excludedClients:[],
    autoExcluded:raw.autoExcluded&&typeof raw.autoExcluded==='object'&&!Array.isArray(raw.autoExcluded)?raw.autoExcluded:{},
    boundedClients:Array.isArray(raw.boundedClients)?raw.boundedClients:[],
    boundMB:Number.isFinite(boundMB)&&boundMB>=8&&boundMB<=1024?Math.round(boundMB):64,
    boundAuto:raw.boundAuto===true,
    autoBounded:clientMap(raw.autoBounded),autoUnbounded:clientMap(raw.autoUnbounded)
  };
}
const clientMap=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};

// Client types whose open-ended Range gets capped: the operator's list plus the ones detected
// automatically, minus any that failed to continue (which is checked even for listed ones).
export function boundedClientList(settings) {
  const failed=new Set(Object.keys(settings.autoUnbounded).map(client=>client.toLowerCase()));
  return normalizeClientList([...settings.boundedClients,...Object.keys(settings.autoBounded)]).filter(client=>!failed.has(client.toLowerCase()));
}

// Same as readSteeringSettings, but stores the normalized object so callers can edit it in place.
export function steeringSettings(data) {
  data.settings||={};
  data.settings.steering=readSteeringSettings(data);
  return data.settings.steering;
}

export function excludedClients(settings) {
  return normalizeClientList([...settings.excludedClients,...Object.keys(settings.autoExcluded)]);
}

// Why a machine cannot take part, or [] when it can. A target must be reachable on a direct HTTPS
// domain of its own: the entry domain resolves differently per client, so it can never be a target.
export function agentSteeringIssues(agent, settings) {
  const issues=[];
  if(!agent||agent.state==='revoked')return ['机器已撤销'];
  if(agent.steerTarget===false)issues.push('已关闭参与切流');
  const domain=String(agent.domain||'').toLowerCase(),local=agent.id===LOCAL_AGENT_ID;
  if(!domain||(!local&&agent.proxyMode==='ip'))issues.push('没有 HTTPS 直连域名（IP 反代不能作为切流目标）');
  else if(settings.entryDomain&&domain===settings.entryDomain)issues.push('直连域名与入口域名相同，需要给这台机器单独的域名');
  if(!local&&!(Array.isArray(agent.capabilities)&&agent.capabilities.includes(STEERING_CAPABILITY)))issues.push('探针版本不支持切流，需要升级');
  return issues;
}

export function steerableAgent(agent, settings) {
  return agentSteeringIssues(agent,settings).length===0;
}

export function routeSteeringIssues(data, route, settings=readSteeringSettings(data)) {
  const issues=[];
  if(route.autoSteer?.enabled!==true)issues.push('未开启自动切流');
  if(route.accessMode==='alias_only'||!isRouteAuthKey(route.routeAuthKey))issues.push('需要开启连接密码');
  if(Number(route.speedLimitMbps||0)>0)issues.push('限速节点不能切流（限速会被误判为线路慢）');
  if(steeringPeers(data,route,settings).length<2)issues.push('至少需要两台可参与切流的机器部署该节点');
  return issues;
}

function steeringPeers(data, route, settings) {
  const deployed=new Set((Array.isArray(data.deployments)?data.deployments:[]).filter(item=>item.routeId===route.id&&item.enabled!==false).map(item=>item.agentId));
  return (Array.isArray(data.agents)?data.agents:[]).filter(agent=>deployed.has(agent.id)&&steerableAgent(agent,settings))
    .map(agent=>({id:agent.id,base:`https://${String(agent.domain).toLowerCase()}`})).sort((left,right)=>compareUtf8(left.id,right.id));
}

export function steeringTopology(data, route, settings=readSteeringSettings(data)) {
  if(settings.mode==='off'||routeSteeringIssues(data,route,settings).length)return null;
  const params={minRateMbps:Math.max(0,Number(route.autoSteer.minRateMbps||0)),...(egressTopology(data,route)?{anyLine:true}:{})};
  return {mode:settings.mode,peers:steeringPeers(data,route,settings),params};
}

const deployingAgents=(data,route)=>{
  const deployed=new Set((Array.isArray(data.deployments)?data.deployments:[]).filter(item=>item.routeId===route.id&&item.enabled!==false).map(item=>item.agentId));
  return (Array.isArray(data.agents)?data.agents:[]).filter(agent=>deployed.has(agent.id)&&agent.state!=='revoked');
};
const knowsEgress=agent=>agent.id===LOCAL_AGENT_ID||(Array.isArray(agent.capabilities)&&agent.capabilities.includes(EGRESS_CAPABILITY));

// A unified upstream egress: every machine serving the node relays its upstream traffic through one of
// them, so the upstream sees a single address however clients are spread or steered. It is only in
// force when every machine serving the node can take part — a single older machine fetching on its
// own would quietly bring the second address back.
export function egressIssues(data, route) {
  const id=String(route?.egressAgentId||'');
  if(!id)return [];
  const machines=deployingAgents(data,route),egress=machines.find(agent=>agent.id===id),issues=[];
  if(!egress)return [(Array.isArray(data.agents)?data.agents:[]).some(agent=>agent.id===id&&agent.state!=='revoked')?'统一出口机器没有部署该节点':'统一出口机器不存在或已撤销'];
  const domain=String(egress.domain||'');
  if(!domain||(egress.id!==LOCAL_AGENT_ID&&egress.proxyMode==='ip'))issues.push('统一出口机器没有 HTTPS 直连域名');
  if(route.accessMode==='alias_only'||!isRouteAuthKey(route.routeAuthKey))issues.push('统一出口需要开启连接密码');
  const old=machines.filter(agent=>!knowsEgress(agent)).map(agent=>agent.name||agent.id);
  if(old.length)issues.push(`${old.join('、')} 的探针版本不支持统一出口，需要升级`);
  return issues;
}

export function egressTopology(data, route) {
  if(!route?.egressAgentId||egressIssues(data,route).length)return null;
  const egress=(data.agents||[]).find(agent=>agent.id===route.egressAgentId);
  return {id:egress.id,base:`https://${String(egress.domain).toLowerCase()}`};
}

// The node list compiled into a machine's snapshot. A node only carries a steering block on machines
// that are themselves part of its topology, and an egress block on every machine but the egress
// itself; everything else compiles exactly as before, so enabling nothing changes no snapshot hash.
export function agentSnapshotNodes(data, agentId) {
  const routes=routesForAgent(data,agentId),settings=readSteeringSettings(data);
  const observes=agentId===LOCAL_AGENT_ID||data.agents?.find(a=>a.id===agentId)?.capabilities?.includes(PLAYBACK_OBSERVATION_CAPABILITY);
  return routes.map(route=>{
    const topology=settings.mode==='off'?null:steeringTopology(data,route,settings),egress=egressTopology(data,route);
    let node=route;
    if(topology&&observes)node={...node,playbackObservation:true};
    if(topology&&topology.peers.some(peer=>peer.id===agentId))node={...node,steering:topology};
    if(egress&&egress.id!==agentId)node={...node,egress};
    return node;
  });
}

// Participating machines that do not serve the node. The panel has every participating machine serve
// the entry domain, and DNS may send a client to any of them: one without the node would answer 404.
export function entryCoverageGaps(data, route, settings=readSteeringSettings(data)) {
  const peers=new Set(steeringPeers(data,route,settings).map(peer=>peer.id));
  return (Array.isArray(data.agents)?data.agents:[]).filter(agent=>steerableAgent(agent,settings)&&!peers.has(agent.id));
}

// Address handed to clients for a node: the shared entry domain only while the node is actually steered
// and served by every machine behind that domain; otherwise its machine's direct address as before.
export function steeringEntryBaseUrl(data, route) {
  const settings=readSteeringSettings(data);
  if(!settings.entryDomain||!route||!steeringTopology(data,route,settings)||entryCoverageGaps(data,route,settings).length)return '';
  return `https://${settings.entryDomain}`;
}

// --- Entry domain on each machine (applied by a host unit, like a domain switch) ---
export const ENTRY_CAPABILITY='entry-v1';
const ENTRY_STATES=['pending','applying','active','failed'];
const ENTRY_RETRY_MINUTES=[3,9,27,60];

// What a machine must serve for the entry domain: the domain itself, the certificate email, and the
// other participating machines it forwards ACME challenges to. null when it should not serve it.
export function desiredEntry(data, agentId) {
  const settings=readSteeringSettings(data),email=String(data?.settings?.certificateEmail||'').trim().toLowerCase();
  if(!settings.entryDomain||!email)return null;
  const machines=(Array.isArray(data.agents)?data.agents:[]).filter(agent=>steerableAgent(agent,settings)),self=machines.find(agent=>agent.id===agentId);
  if(!self)return null;
  return {domain:settings.entryDomain,email,peers:machines.filter(agent=>agent!==self).map(agent=>String(agent.domain).toLowerCase()).sort()};
}

// The request comes from the panel (signed) and goes to a root-owned host script (which re-checks it);
// anything off here is dropped rather than repaired.
export function cleanEntryRequest(value) {
  if(!value||typeof value!=='object')return null;
  const domain=String(value.domain||'').toLowerCase(),email=String(value.email||'').toLowerCase(),peers=Array.isArray(value.peers)?value.peers.map(peer=>String(peer).toLowerCase()):null;
  if(!DOMAIN_RE.test(domain)||!/^[^\s@]+@[^\s@]+$/.test(email)||email.length>254||!peers||peers.length>16||!peers.every(peer=>DOMAIN_RE.test(peer)&&peer!==domain))return null;
  return {domain,email,peers:[...new Set(peers)].sort()};
}

export function cleanEntryStatus(value) {
  if(!value||typeof value!=='object')return null;
  return {requestId:String(value.requestId||'').slice(0,80),state:ENTRY_STATES.includes(value.state)?value.state:'failed',
    entryDomain:String(value.entryDomain||'').slice(0,253),peers:Array.isArray(value.peers)?value.peers.slice(0,16).map(peer=>String(peer).slice(0,253)):[],
    attempt:Math.max(0,Math.min(1000,Math.floor(Number(value.attempt)||0))),message:String(value.message||'').slice(0,500),updatedAt:String(value.updatedAt||'').slice(0,40)};
}

// 0 when nothing is to be done, otherwise the attempt number of the request to file. A failure for the
// same configuration is retried with growing pauses: until every machine forwards ACME challenges (or
// DNS is in place) issuance keeps failing, and Let's Encrypt allows only a few failures per hour.
export function entryAttempt(desired, status, nowMs=Date.now()) {
  if(!desired)return 0;
  const same=status&&status.entryDomain===desired.domain&&status.peers.join(' ')===desired.peers.join(' ');
  if(!same)return 1;
  if(status.state!=='failed')return 0;
  const waitMs=ENTRY_RETRY_MINUTES[Math.min(ENTRY_RETRY_MINUTES.length-1,Math.max(0,status.attempt-1))]*60_000,age=nowMs-Date.parse(status.updatedAt||'');
  return Number.isFinite(age)&&age>=waitMs?status.attempt+1:0;
}

export function entryCommand(entry, local) {
  return `sudo ${local?'aegis-relay':'aegis-relay-agent'} entry ${entry.domain} ${entry.email}${entry.peers.length?` ${entry.peers.join(' ')}`:''}`;
}
