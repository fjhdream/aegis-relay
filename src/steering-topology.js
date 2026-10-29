import { isRouteAuthKey } from './route-auth.js';
import { LOCAL_AGENT_ID, routesForAgent } from './agent-registry.js';
import { STEERING_CAPABILITY, STEERING_MODES } from './steering.js';

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
  return {mode:settings.mode,peers:steeringPeers(data,route,settings),params:{minRateMbps:Math.max(0,Number(route.autoSteer.minRateMbps||0))}};
}

// The node list compiled into a machine's snapshot. A node only carries a steering block on machines
// that are themselves part of its topology; everything else compiles exactly as before, so enabling
// nothing changes no snapshot hash.
export function agentSnapshotNodes(data, agentId) {
  const routes=routesForAgent(data,agentId),settings=readSteeringSettings(data);
  if(settings.mode==='off')return routes;
  return routes.map(route=>{
    const topology=steeringTopology(data,route,settings);
    return topology&&topology.peers.some(peer=>peer.id===agentId)?{...route,steering:topology}:route;
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
