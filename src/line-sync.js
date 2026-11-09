import { agentEntryUrl, LOCAL_AGENT_ID } from './agent-registry.js';

// Line sync: Emby clients that support "extension lines" ask the server they were configured with for
// every other address of it, at GET /emby/System/Ext/ServerDomains (the convention of
// github.com/uhdnow/emby_ext_domains), and offer them as switchable lines. A relay answers that for the
// node itself, with the node's own addresses: the steering entry domain and every machine serving it.
// Each address carries the client's own access prefix, so a line works with the key the client already
// has. Passed through, the request would instead hand out the upstream's direct domains, if any; a node
// can opt into sharing its configured primary and the upstream's own lines.

export const LINE_SYNC_CAPABILITY='line-sync-v1';
export const LINE_SYNC_MAX=32;
const LINE_NAME_MAX=64;
const LINE_PATH=/^(\/emby)?\/system\/ext\/serverdomains\/?$/i;
const UPSTREAM_LINE_PREFIX='上游·';
const UPSTREAM_URL_MAX=2048;
// The upstream's own list is fetched after the token check and must not hold the reply up for long.
export const UPSTREAM_LINES_TIMEOUT_MS=3000;
export const UPSTREAM_LINES_MAX_BYTES=64*1024;

export function lineSyncEnabled(route) {
  return route?.lineSync!==false;
}

// Whether the node appends the upstream's own lines; only meaningful while it shares its lines at all.
export function lineSyncUpstream(route) {
  return lineSyncEnabled(route)&&route?.lineSyncUpstream===true;
}

// Some upstreams serve /System/Info publicly; the items endpoint checks the user's library access.
export function lineSyncAuthPath(rest) {
  const match=LINE_PATH.exec(String(rest||''));
  return match?`${match[1]?'/emby':''}/Items`:null;
}

function lineName(value) {
  return String(value||'').replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,LINE_NAME_MAX);
}

function lineBase(value) {
  let url;
  try{url=new URL(String(value||''))}catch{return ''}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||!url.hostname)return '';
  return url.origin;
}

// An upstream line keeps its path (the upstream may sit under one), but never credentials or a fragment.
function upstreamUrl(value) {
  const text=String(value||'').trim();
  if(text.length>UPSTREAM_URL_MAX)return '';
  let url;
  try{url=new URL(text)}catch{return ''}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||!url.hostname)return '';
  url.hash='';
  return url.pathname==='/'&&!url.search?url.origin:url.href;
}

// The upstream's reply to the same line request, as reference-format JSON. Anything else (a stock Emby
// 404 page, HTML, a malformed list) reads as no additional upstream lines.
export function upstreamLines(body) {
  let payload;
  try{payload=JSON.parse(Buffer.isBuffer(body)?body.toString('utf8'):String(body||''))}catch{return []}
  if(!payload||typeof payload!=='object'||payload.ok===false||!Array.isArray(payload.data))return [];
  const lines=[];
  for(const item of payload.data){
    if(lines.length>=LINE_SYNC_MAX)break;
    const url=upstreamUrl(item?.url);
    if(!url)continue;
    lines.push({name:lineName(`${UPSTREAM_LINE_PREFIX}${lineName(item?.name)||new URL(url).hostname}`),url});
  }
  return lines;
}

// Throws on anything off, like the other snapshot blocks: the panel only ever compiles clean lines.
export function cleanLines(value) {
  if(!Array.isArray(value)||value.length>LINE_SYNC_MAX)throw new Error('invalid line list');
  return value.map(line=>{
    const name=lineName(line?.name),base=lineBase(line?.base);
    if(!name||!base||base!==line.base)throw new Error('invalid line');
    return {name,base};
  });
}

// The node's lines, best first: the steering entry domain (it picks a machine per client), then each
// machine serving the node in the panel's machine order. The panel machine is served on localBase.
export function nodeLines(data, route, {entryBase='',localBase=''}={}) {
  if(!route||!lineSyncEnabled(route))return [];
  const deployed=new Set((Array.isArray(data?.deployments)?data.deployments:[]).filter(item=>item.routeId===route.id&&item.enabled!==false).map(item=>item.agentId));
  const machines=(Array.isArray(data?.agents)?data.agents:[]).filter(agent=>deployed.has(agent.id)&&agent.state!=='revoked')
    .map((agent,index)=>({agent,index})).sort((left,right)=>Number(left.agent.sortOrder||0)-Number(right.agent.sortOrder||0)||left.index-right.index);
  const lines=[],seen=new Set();
  const add=(name,value)=>{
    const base=lineBase(value),label=lineName(name);
    if(!base||!label||seen.has(base)||lines.length>=LINE_SYNC_MAX)return;
    seen.add(base);lines.push({name:label,base});
  };
  add('智能入口',entryBase);
  for(const {agent} of machines)add(agent.name||agent.id,agent.id===LOCAL_AGENT_ID?localBase:agentEntryUrl(agent));
  return lines;
}

const JSON_HEADERS={'content-type':'application/json; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'};

// The answer once the upstream has judged the token. Shaped like the reference service's, so clients
// built against it read it unchanged. List the configured primary first among upstream lines so
// a duplicate advertised by the upstream keeps the primary label.
export function lineSyncReply(upstreamStatus, lines, prefix, upstream=[], primaryUpstream) {
  let status=200,payload;
  if(upstreamStatus===200){
    const data=[],seen=new Set();
    const add=(name,url)=>{if(seen.has(url))return;seen.add(url);data.push({name,url})};
    for(const line of lines)add(line.name,`${line.base}${prefix}`);
    const primary=primaryUpstream&&upstreamUrl(primaryUpstream);
    if(primary)add(`${UPSTREAM_LINE_PREFIX}主线路`,primary);
    for(const line of upstream)add(line.name,line.url);
    payload={data,ok:true};
  }
  else if(upstreamStatus===401||upstreamStatus===403){status=401;payload={error:'Invalid token',ok:false};}
  else{status=502;payload={error:'Upstream unavailable',ok:false};}
  const body=Buffer.from(JSON.stringify(payload));
  return {status,headers:{...JSON_HEADERS,'content-length':String(body.length)},body};
}
