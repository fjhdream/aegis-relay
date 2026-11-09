import { canonicalJson } from './canonical-json.js';
import { isRouteAuthKey, ROUTE_AUTH_VERSION } from './route-auth.js';
import { cleanLines } from './line-sync.js';

// The node wire format: how a node travels inside a signed snapshot, from the panel to a machine.
// encodeNodes() is what the panel signs; decodeNodes() is what a machine serves from (the panel
// machine's own agent and every remote one), checked with the very same rules, so the two can never
// drift apart. A block a machine does not know is ignored, so a newer panel can add one without an
// older machine rejecting the snapshot; a known block that is malformed rejects the whole snapshot.
// The blocks derived from the whole panel (steering, egress, lines, playback observation) are worked
// out by agentSnapshotNodes in steering-topology.js; this module only carries them.

const NODE_MAX=100;
const ALIAS=/^[a-z0-9][a-z0-9_-]{0,31}$/;
const compareUtf8=(left,right)=>Buffer.compare(Buffer.from(left,'utf8'),Buffer.from(right,'utf8'));

function upstreamList(value) {
  if(!Array.isArray(value))throw new Error('upstreams must be an array');
  return value.map(item=>{
    if(typeof item!=='string'||!item.trim())throw new Error('upstreams contains an invalid value');
    let url;try{url=new URL(item)}catch{throw new Error('invalid route upstream')}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('invalid route upstream');
    return item;
  });
}

function clientProfile(value={}) {
  const result={enabled:value?.enabled===true};
  for(const field of ['userAgent','client','deviceName','deviceId'])if(value?.[field])result[field]=String(value[field]);
  return result;
}

function streamRewrite(value={}) {
  const domains=Array.isArray(value?.domains)?value.domains.map(d=>String(d||'').trim().toLowerCase()).filter(Boolean):[];
  return {enabled:value?.enabled===true&&domains.length>0,domains};
}

function httpsMachine(value, message) {
  const id=String(value?.id||''),base=String(value?.base||'');
  let url;try{url=new URL(base)}catch{throw new Error(message)}
  if(!id||url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.origin!==base)throw new Error(message);
  return {id,base};
}

// Present only on nodes this machine steers (see steering-topology.js), so every other snapshot keeps
// its exact previous shape and hash.
function steering(value) {
  const peers=(Array.isArray(value?.peers)?value.peers:[]).map(peer=>httpsMachine(peer,'invalid steering peer'));
  return {mode:value?.mode==='on'?'on':'shadow',peers,params:{minRateMbps:Math.max(0,Number(value?.params?.minRateMbps||0)),...(value?.params?.anyLine===true?{anyLine:true}:{})}};
}

function egress(value) { return httpsMachine(value,'invalid egress machine'); }

// The access block of a key node: its own key and those of its distribution channels (per-user keys),
// each with the digest a machine verifies the client's key against.
function keyAccess(value, alias) {
  if(value.algorithm!==ROUTE_AUTH_VERSION||!isRouteAuthKey(value.routeAuthKey)||typeof value.digest!=='string'||!value.digest)throw new Error(`node ${alias} has incomplete route authentication`);
  const channels=(Array.isArray(value.channels)?value.channels:[]).map(ch=>{
    if(!isRouteAuthKey(ch?.routeAuthKey)||typeof ch.digest!=='string'||!ch.digest)throw new Error(`node ${alias} has an invalid channel`);
    return {id:String(ch.id||'').slice(0,32),routeAuthKey:ch.routeAuthKey,digest:ch.digest};
  });
  return {mode:'key',algorithm:ROUTE_AUTH_VERSION,routeAuthKey:value.routeAuthKey,digest:value.digest,...(channels.length?{channels}:{})};
}

function nodeIdentity(value) {
  if(!value||typeof value!=='object')throw new Error('snapshot node must be an object');
  const id=String(value.id||'').trim(),alias=String(value.alias||'').trim();
  if(!id||!alias)throw new Error('snapshot nodes require id and alias');
  if(!ALIAS.test(alias))throw new Error(`invalid node alias: ${alias}`);
  return {id,alias};
}

// The blocks every node carries in the same shape on both sides.
function sharedBlocks(value) {
  return {
    ...(value.steering?{steering:steering(value.steering)}:{}),
    ...(value.playbackObservation===true?{playbackObservation:true}:{}),
    ...(value.egress?{egress:egress(value.egress)}:{}),
    ...(Array.isArray(value.lines)?{lines:cleanLines(value.lines),...(value.lineSyncUpstream===true?{lineSyncUpstream:true}:{})}:{})
  };
}

function encodeNode(route) {
  const {id,alias}=nodeIdentity(route);
  let access={mode:'alias_only'};
  if(route.accessMode!=='alias_only'){
    if(route.authMigrationRequired===true)throw new Error(`node ${alias} requires an access-key rotation before agent deployment`);
    if(route.authVersion!==ROUTE_AUTH_VERSION)throw new Error(`node ${alias} has incomplete route authentication`);
    // A channel that is not fully set up is left out rather than holding the node back.
    const channels=(Array.isArray(route.channels)?route.channels:[]).filter(ch=>ch?.authVersion===ROUTE_AUTH_VERSION&&isRouteAuthKey(ch.routeAuthKey)&&typeof ch.keyDigest==='string'&&ch.keyDigest);
    access=keyAccess({algorithm:route.authVersion,routeAuthKey:route.routeAuthKey,digest:route.keyDigest,channels:channels.map(ch=>({id:ch.id,routeAuthKey:ch.routeAuthKey,digest:ch.keyDigest}))},alias);
  }
  const upstreams=upstreamList(route.upstreams?.length?route.upstreams:(route.upstream?[route.upstream]:[]));
  if(!upstreams.length)throw new Error(`node ${alias} requires at least one upstream`);
  return {
    id,alias,name:String(route.name||alias),enabled:route.enabled!==false,
    upstreams,
    allowPrivate:route.allowPrivate===true,tlsVerify:route.tlsVerify!==false,
    showOnHome:route.showOnHome===true,clientProfile:clientProfile(route.clientProfile),streamRewrite:streamRewrite(route.streamRewrite),
    speedLimitMbps:Number(route.speedLimitMbps||0),monthlyQuotaGB:Number(route.monthlyQuotaGB||0),access,
    ...sharedBlocks(route)
  };
}

function decodeNode(node) {
  const {id,alias}=nodeIdentity(node);
  if(!node.access||typeof node.access!=='object')throw new Error(`node ${alias} has no access block`);
  const access=node.access.mode==='alias_only'?null:keyAccess(node.access,alias);
  const upstreams=upstreamList(node.upstreams);
  if(!upstreams.length)throw new Error(`node ${alias} requires at least one upstream`);
  return {
    id,alias,name:node.name,enabled:node.enabled,upstreams,
    allowPrivate:node.allowPrivate,tlsVerify:node.tlsVerify,showOnHome:node.showOnHome,
    clientProfile:clientProfile(node.clientProfile),streamRewrite:streamRewrite(node.streamRewrite),speedLimitMbps:node.speedLimitMbps,monthlyQuotaGB:node.monthlyQuotaGB,
    accessMode:access?'key':'alias_only',
    ...sharedBlocks(node),
    ...(access?{authVersion:access.algorithm,routeAuthKey:access.routeAuthKey,keyDigest:access.digest,...(access.channels?{channels:access.channels.map(c=>({id:c.id,routeAuthKey:c.routeAuthKey,keyDigest:c.digest,authVersion:access.algorithm}))}:{})}:{})
  };
}

function checkList(nodes) {
  const ids=new Set(),aliases=new Set();
  for(const node of nodes){
    if(ids.has(node.id))throw new Error(`duplicate node id: ${node.id}`);
    if(aliases.has(node.alias))throw new Error(`duplicate node alias: ${node.alias}`);
    ids.add(node.id);aliases.add(node.alias);
  }
}

// Panel side: a machine's nodes (as agentSnapshotNodes builds them) in their signed, canonical form,
// sorted by id. Throws when a node cannot be deployed.
export function encodeNodes(routes) {
  if(!Array.isArray(routes))throw new Error('snapshot nodes must be an array');
  if(routes.length>NODE_MAX)throw new Error('invalid route count');
  const nodes=routes.map(encodeNode).sort((left,right)=>compareUtf8(left.id,right.id)||compareUtf8(left.alias,right.alias));
  checkList(nodes);
  canonicalJson(nodes);
  return nodes;
}

// Machine side: the routes the proxy serves from a verified snapshot. Throws on anything off.
export function decodeNodes(nodes) {
  if(!Array.isArray(nodes)||nodes.length>NODE_MAX)throw new Error('invalid route count');
  const routes=nodes.map(decodeNode);
  checkList(routes);
  return routes;
}
