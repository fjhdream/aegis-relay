import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanAlias, deriveKey, hashPassword, newTotpSecret, randomToken, RateLimiter, requestIp, tokenDigest, verifyPassword, verifyTotp, timingEqual } from './security.js';
import { Store } from './store.js';
import { activeUpstreamLine, dropRouteRuntime, getRuntimeStatus, handleUpgrade, makeProxyHandler, RELAY_SERVER_OPTIONS, validateUpstreamList } from './proxy.js';
import { Metrics } from './metrics.js';
import { diagnoseRoute } from './diagnostics.js';
import { Notifier } from './notifier.js';
import { clientCredentials, savedCredentials } from './credentials.js';
import { adminRelative, isRootAdminRequest, normalizeAdminPath } from './admin-path.js';
import { customConnectionKey } from './connection-key.js';
import { isRouteAuthKey, newRouteAuthKey, ROUTE_AUTH_VERSION, routeChannels, routeTokenDigest } from './route-auth.js';
import { LocalAgent } from './local-agent.js';
import { agentEntryUrl, deploymentId, ensureLocalDeployment, LOCAL_AGENT_ID, normalizeAgentDomain, publicAgent, removeRouteDeployments, replaceAgentDeployments, routeEntryBaseUrl } from './agent-registry.js';
import { AgentApi, enrollmentInstallCommand, issueEnrollment, normalizeCertificateEmail } from './agent-api.js';
import { aggregateTelemetry, indexViewersByNode, nodeChannels, sanitizeTelemetry, telemetryFromMetrics } from './telemetry.js';
import { createDashboardFeed } from './dashboard-feed.js';
import { activeLocalDomain, baseHostname, domainRequestRole, followEntry, readDomainStatus, readEntryStatus, requestDomainSwitch } from './domain-control.js';
import { qrRows } from './qr.js';
import { fetchPanelIcon, MAX_ICON_BYTES, normalizePanelIcon } from './panel-icon.js';
import { SteeringEngine, STEERING_MODES } from './steering.js';
import { SteeringHub } from './steering-hub.js';
import { agentSteeringIssues, desiredEntry, egressIssues, egressTopology, ENTRY_CAPABILITY, entryCommand, entryCoverageGaps, normalizeClientList, normalizeEntryDomain, routeSteeringIssues, steeringEntryBaseUrl, steeringSettings } from './steering-topology.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP_VERSION=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8')).version;
const cfg = {
  adminHost: process.env.ADMIN_HOST || '127.0.0.1', adminPort: +(process.env.ADMIN_PORT || 9080),
  proxyHost: process.env.PROXY_HOST || '0.0.0.0', proxyPort: +(process.env.PROXY_PORT || 8080),
  adminPath: normalizeAdminPath(process.env.ADMIN_PATH ?? '_aegis'),
  dataFile: process.env.DATA_FILE || path.join(ROOT, 'data', 'aegis.enc.json'),
  setupToken: process.env.SETUP_TOKEN || '', secureCookies: process.env.SECURE_COOKIES !== 'false', publicBaseUrl:process.env.PUBLIC_BASE_URL||'', localProxyBaseUrl:process.env.LOCAL_PROXY_BASE_URL||'', certificateEmail:process.env.CERTIFICATE_EMAIL||''
};
const key = deriveKey(process.env.APP_MASTER_KEY); const store = new Store(cfg.dataFile, key);
if(!store.data.settings.certificateEmail&&cfg.certificateEmail){store.data.settings.certificateEmail=normalizeCertificateEmail(cfg.certificateEmail);store.save();}
const configuredLocalDomain=activeLocalDomain(cfg);
const localAgent = new LocalAgent({store}); localAgent.start();
// After the local agent: on a fresh install it is what creates this record, and the steering topology
// reads the domain from the record (an empty one left the panel machine out until the next restart).
const localRecord=store.data.agents.find(agent=>agent.id===LOCAL_AGENT_ID);
if(localRecord&&configuredLocalDomain&&localRecord.domain!==configuredLocalDomain){localRecord.domain=configuredLocalDomain;localRecord.updatedAt=new Date().toISOString();store.save();localAgent.reconcile();}
// Automatic steering: the hub arbitrates sessions across machines; a client type that keeps failing to
// follow steering redirects is excluded for good (until the operator clears it).
// Capped ranges (direct play cut into requests): a client type that continued on trial is switched on,
// one that failed to continue is switched off, until the operator clears the automatic results.
function rangeVerdict(client,works){
  const settings=steeringSettings(store.data),lower=client.toLowerCase(),has=map=>Object.keys(map).some(item=>item.toLowerCase()===lower);
  if(has(settings.autoUnbounded)||(works&&has(settings.autoBounded)))return;
  if(works)settings.autoBounded[client]=new Date().toISOString();
  else{settings.autoUnbounded[client]=new Date().toISOString();for(const item of Object.keys(settings.autoBounded))if(item.toLowerCase()===lower)delete settings.autoBounded[item];}
  store.audit(works?'steering.client_range_enabled':'steering.client_range_disabled','system',client);store.save();
}
const steeringHub = new SteeringHub({store,onBoundVerdict:rangeVerdict,onAutoExclude:client=>{const settings=steeringSettings(store.data);if(Object.keys(settings.autoExcluded).some(item=>item.toLowerCase()===client.toLowerCase()))return;settings.autoExcluded[client]=new Date().toISOString();store.audit('steering.client_auto_excluded','system',client);store.save();}});
// A machine's capabilities or domain feed every node's steering topology, so a change there recompiles
// the local snapshot too (remote ones are recompiled by the API itself).
const agentApi = new AgentApi({store,version:APP_VERSION,steering:steeringHub,onTopologyChange:()=>localAgent.reconcile()});
const metrics = new Metrics(store);
// Stats for nodes deleted by earlier versions were never removed; sweep them once at boot.
metrics.retainOnly(store.data.routes.map(route=>route.id||route.alias));
const notifier = new Notifier(store,metrics);
const sessions = store.data.sessions && typeof store.data.sessions === 'object' && !Array.isArray(store.data.sessions) ? store.data.sessions : {};
store.data.sessions = sessions;
function pruneSessions(){const now=Date.now();for(const [sid,session] of Object.entries(sessions))if(!session||Number(session.expires)<now)delete sessions[sid];for(const [sid] of Object.entries(sessions).sort((a,b)=>Number(b[1].expires)-Number(a[1].expires)).slice(16))delete sessions[sid]}
pruneSessions();
const loginLimiter = new RateLimiter(6, 5 * 60_000);
const ui = fs.readFileSync(path.join(ROOT, 'web', 'index.html'),'utf8').replace('APP_JS',`app.js?v=${APP_VERSION}`).replace('STYLE_CSS',`style.css?v=${APP_VERSION}`).replace('HELP_CSS',`help.css?v=${APP_VERSION}`).replaceAll('APP_VERSION',APP_VERSION);
const appjs = fs.readFileSync(path.join(ROOT,'web','app.js'));
const stylesheet = fs.readFileSync(path.join(ROOT,'web','style.css'));
const helpStylesheet = fs.readFileSync(path.join(ROOT,'web','help.css'));
const agentInstaller = fs.readFileSync(path.join(ROOT,'scripts','agent-install.sh'));
const agentUpgrader = fs.readFileSync(path.join(ROOT,'scripts','agent-upgrade.sh'));

function headers(extra = {}) { return { 'cache-control':'no-store', 'content-security-policy':"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", 'permissions-policy':'camera=(), microphone=(), geolocation=()', 'referrer-policy':'no-referrer', 'x-content-type-options':'nosniff', 'x-frame-options':'DENY', ...extra }; }
function json(res, status, body, extra = {}) { res.writeHead(status, headers({ 'content-type':'application/json; charset=utf-8', ...extra })); res.end(JSON.stringify(body)); }
const ip = requestIp;
async function body(req, limit = 32 * 1024) {
  if (!String(req.headers['content-type']).startsWith('application/json')) throw Object.assign(new Error('application/json required'), { status: 415 });
  let size = 0, chunks = []; for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('request too large'), { status: 413 }); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}
function cookies(req) { return Object.fromEntries(String(req.headers.cookie || '').split(';').map(v=>v.trim().split('=').map(decodeURIComponent)).filter(v=>v.length===2)); }
function auth(req) { const sid = cookies(req).aegis_session, s = Object.prototype.hasOwnProperty.call(sessions,sid)?sessions[sid]:null; if (!s || s.expires < Date.now()) { if(sid&&s){delete sessions[sid];store.save()} return null; } s.expires = Date.now() + 30 * 60_000; return { sid, ...s }; }
function requireAuth(req) { const s = auth(req); if (!s) throw Object.assign(new Error('登录已失效，请重新登录'), { status: 401 }); if (!timingEqual(req.headers['x-csrf-token'] || '', s.csrf)) throw Object.assign(new Error('安全校验已失效，请重新登录'), { status: 403 }); return s; }
function routeUpstreams(r) { return r.upstreams?.length?r.upstreams:(r.upstream?[r.upstream]:[]); }
function cleanProfile(value = {}) {
  if(!value||typeof value!=='object')throw new Error('invalid client profile');
  const out={enabled:value.enabled===true};
  for(const field of ['userAgent','client','deviceName','deviceId']){
    const v=String(value[field]||'').trim(); if(/[\r\n]/.test(v)||v.length>160)throw new Error(`invalid client profile field: ${field}`); if(v)out[field]=v;
  }
  return out;
}
function cleanStreamRewrite(value={}){
  if(!value||typeof value!=='object')return {enabled:false,domains:[]};
  const raw=Array.isArray(value.domains)?value.domains:String(value.domains||'').split(/[\s,;\n]+/);
  const domains=[];
  for(const item of raw){
    let s=String(item||'').trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//,'').replace(/^\/+/,'').split('/')[0].split('?')[0];
    if(!s)continue;
    if(!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/.test(s))throw new Error(`invalid stream domain: ${item}`);
    if(!domains.includes(s))domains.push(s);
    if(domains.length>16)throw new Error('a node supports at most 16 stream domains');
  }
  return {enabled:value.enabled===true&&domains.length>0,domains};
}
function cleanTags(value){return[...new Set((Array.isArray(value)?value:String(value||'').split(',')).map(x=>String(x).trim()).filter(Boolean).slice(0,8).map(x=>x.slice(0,24)))]}
function numeric(value,min,max){const n=Number(value||0);return Number.isFinite(n)?Math.min(max,Math.max(min,n)):0}
function connectionKey(value){return customConnectionKey(value)||randomToken(24)}
function routeAuthFields(accessKey) {
  if (!accessKey) return { keyDigest:null, accessKey:null };
  const routeAuthKey=newRouteAuthKey();
  return { authVersion:ROUTE_AUTH_VERSION, routeAuthKey, keyDigest:routeTokenDigest(accessKey,routeAuthKey), accessKey };
}
// One extra distribution channel (a labeled per-user connection key) beyond the node's default key.
function newChannel(label,accessKey){const key=connectionKey(accessKey),routeAuthKey=newRouteAuthKey();return{id:randomToken(8),label:String(label||'').slice(0,40),accessKey:key,routeAuthKey,keyDigest:routeTokenDigest(key,routeAuthKey),authVersion:ROUTE_AUTH_VERSION,createdAt:new Date().toISOString()};}
// Channel list without secrets (for publicRoute / access mapping).
function channelList(r){return routeChannels(r).map(ch=>({id:ch.id,label:ch.label||(ch.id==='default'?'默认':''),createdAt:ch.createdAt||r.createdAt||null,isDefault:ch.id==='default'}));}
// Channel list WITH each channel's client URL (for the operator to copy and hand out).
function channelCredentials(r){return routeChannels(r).map(ch=>({id:ch.id,label:ch.label||(ch.id==='default'?'默认':''),isDefault:ch.id==='default',clientPath:ch.accessKey?`/${r.alias}/${ch.accessKey}/`:`/${r.alias}/`}));}
function cleanAutoSteer(value={}){if(!value||typeof value!=='object')return{enabled:false,minRateMbps:0};return{enabled:value.enabled===true,minRateMbps:numeric(value.minRateMbps,0,100000)}}
// The machine a node's upstream traffic all leaves from (see egressTopology). Import keeps only known
// machines; an explicit edit naming an unknown one is rejected.
const knownEgressAgent=value=>{const id=String(value||'').trim().slice(0,64);return id&&store.data.agents.some(agent=>agent.id===id&&agent.state!=='revoked')?id:''};
function cleanEgressAgent(value){const id=knownEgressAgent(value);if(String(value||'').trim()&&!id)throw Object.assign(new Error('unknown egress machine'),{status:400});return id}
function publicRoute(r) { return { id:r.id, alias:r.alias, name:r.name, enabled:r.enabled, upstreams:routeUpstreams(r), allowPrivate:r.allowPrivate, tlsVerify:r.tlsVerify, accessMode:r.accessMode||'key', authMigrationRequired:r.authMigrationRequired===true, showOnHome:r.showOnHome===true, clientProfile:r.clientProfile||{enabled:false},streamRewrite:r.streamRewrite||{enabled:false,domains:[]},autoSteer:r.autoSteer||{enabled:false,minRateMbps:0},egressAgentId:r.egressAgentId||'',tags:r.tags||[],notes:r.notes||'',favorite:r.favorite===true,sortOrder:Number(r.sortOrder||0),speedLimitMbps:Number(r.speedLimitMbps||0),monthlyQuotaGB:Number(r.monthlyQuotaGB||0),reminderDays:Number(r.reminderDays||0),accessAlertThreshold:Number(r.accessAlertThreshold||0),channels:channelList(r),reminderLastAt:r.reminderLastAt||null,createdAt:r.createdAt,updatedAt:r.updatedAt }; }
function localDomainStatus(){const status=readDomainStatus(cfg.dataFile);if(!status)return null;if(status.state==='active'&&status.currentDomain&&status.currentDomain!==configuredLocalDomain)return{...status,state:'applying',message:'Nginx 已切换，面板服务正在重新载入配置'};return status}
// A switch that finished and already matches the live endpoint is not news: the "当前生效域名"
// field and the sync pill already show it, so surfacing a permanent green "已生效" banner is just
// noise. Keep only in-progress (pending/applying) and failed states.
function ongoingDomainChange(change,liveEndpoint){
  if(!change)return null;
  if(change.state==='active'&&(!change.currentDomain||change.currentDomain===liveEndpoint))return null;
  return change;
}
function agentView(agent){const view=publicAgent(agent,store.data,agent.id===LOCAL_AGENT_ID?localAgent.status():null);return agent.id===LOCAL_AGENT_ID?{...view,domain:configuredLocalDomain||view.domain||'',domainChange:ongoingDomainChange(localDomainStatus(),configuredLocalDomain||view.domain||''),automaticDomainSwitch:true}:{...view,domainChange:ongoingDomainChange(agent.domainStatus||null,agent.domain||''),automaticDomainSwitch:true}}
function clientBaseUrl(){return cfg.localProxyBaseUrl||cfg.publicBaseUrl}
// A node deployed to a remote agent is distributed on that agent's own domain/IP, not the panel's, so
// its shown client address must reflect that entry (falling back to the panel when served locally).
// A steered node is handed out on the shared entry domain, which every participating machine serves.
function routeBaseUrl(route){return steeringEntryBaseUrl(store.data,route)||routeEntryBaseUrl(store.data,route.id,clientBaseUrl())}
// What the 自动切流 page needs: settings, per-machine/per-node readiness, the entry-domain command each
// machine has to run once, and the live view from the hub.
function steeringView(){
  const settings=steeringSettings(store.data),agents=store.data.agents.map(agentView).sort((a,b)=>a.sortOrder-b.sortOrder);
  const machines=store.data.agents.filter(agent=>agent.state!=='revoked').map(agent=>{const view=agents.find(item=>item.id===agent.id)||{};return{id:agent.id,name:agent.name||agent.id,domain:view.domain||agent.domain||'',local:agent.id===LOCAL_AGENT_ID,status:view.status,agentVersion:view.agentVersion||'',steerTarget:agent.steerTarget!==false,issues:agentSteeringIssues({...agent,domain:view.domain||agent.domain},settings)}});
  const email=store.data.settings.certificateEmail||'',entryCommands=[];
  // Machines that know entry-v1 (and the panel itself) set the entry domain up on their own; the command
  // stays available for older agents and for re-running by hand.
  for(const machine of machines){
    const agent=store.data.agents.find(item=>item.id===machine.id),entry=desiredEntry(store.data,machine.id);
    if(!entry)continue;
    const status=machine.local?readEntryStatus(cfg.dataFile):agent.entryStatus||null,current=!!status&&status.entryDomain===entry.domain&&status.peers.join(' ')===entry.peers.join(' ');
    entryCommands.push({id:machine.id,name:machine.name,command:entryCommand(entry,machine.local),auto:machine.local||(agent.capabilities||[]).includes(ENTRY_CAPABILITY),state:current?status.state:'waiting',message:current?status.message:'',attempt:current?status.attempt:0,updatedAt:current?status.updatedAt:''});
  }
  const routes=store.data.routes.map(route=>{const issues=routeSteeringIssues(store.data,route,settings),gaps=settings.entryDomain&&!issues.length?entryCoverageGaps(store.data,route,settings):[];return{id:route.id,alias:route.alias,name:route.name,enabled:route.autoSteer?.enabled===true,issues,entryGaps:gaps.map(agent=>agent.name||agent.id),entryAddress:!!steeringEntryBaseUrl(store.data,route),egressAgentId:route.egressAgentId||'',egressIssues:egressIssues(store.data,route),egressActive:!!egressTopology(store.data,route)}});
  return {settings:{mode:settings.mode,entryDomain:settings.entryDomain,excludedClients:settings.excludedClients,autoExcluded:settings.autoExcluded,boundedClients:settings.boundedClients,boundAuto:settings.boundAuto,autoBounded:settings.autoBounded,autoUnbounded:settings.autoUnbounded,boundMB:settings.boundMB},certificateEmail:email,machines,routes,entryCommands,live:steeringHub.view()};
}
// The panel machine serves the entry domain like every other participating machine; its host unit
// applies the request (agents do the same from their check-in).
function syncLocalEntry(){try{followEntry({dataFile:cfg.dataFile,entry:desiredEntry(store.data,LOCAL_AGENT_ID)})}catch(error){console.error('[aegis] entry domain request failed',error?.message||error)}}
function credentialsFor(route,accessKey){return{...clientCredentials(route,accessKey),publicBaseUrl:routeBaseUrl(route)}}
function checkedAlias(value){const alias=cleanAlias(value);if(['r','api','gateway','app','index','index.html','favicon.ico'].includes(alias))throw new Error('alias is reserved');return alias;}
function machineTelemetryList(){
  const localSnapshot=metrics.snapshot(localAgent.routeSource.getRoutes()),localTelemetry=telemetryFromMetrics(localSnapshot),localRecord=store.data.agents.find(agent=>agent.id===LOCAL_AGENT_ID)||{id:LOCAL_AGENT_ID,name:'主代理机器'},localView=agentView(localRecord);
  const machines=[{...localView,name:localRecord.name||'主代理机器',domain:localView.domain||configuredLocalDomain,telemetry:localTelemetry,lastTelemetryAt:new Date().toISOString()}];
  for(const agent of store.data.agents.filter(item=>item.id!==LOCAL_AGENT_ID)){const view=publicAgent(agent,store.data);machines.push({...view,telemetry:sanitizeTelemetry(agent.telemetry),lastTelemetryAt:agent.lastTelemetryAt||null})}
  return {localSnapshot,machines};
}
// Channel id -> label for a node's distribution channels, as nodeChannels expects them.
function channelLabels(route){return new Map(channelList(route).map(c=>[c.id,c.label]))}
// Alert on distinct DEVICES, not IPs: mainland dynamic IPs (WiFi/5G/CGNAT) churn one legitimate
// viewer across many IPs, but an Emby device id is stable per player, and a household has a bounded
// device count — a redistributed relay is what shows a spike of distinct devices.
function dashboardSnapshot(){
  const {localSnapshot,machines}=machineTelemetryList();
  const combined=aggregateTelemetry(machines.map(machine=>machine.telemetry));
  const routeById=new Map(store.data.routes.map(r=>[r.id,r])),viewers=indexViewersByNode(machines);
  const nodes=localSnapshot.nodes.map(n=>{const route=routeById.get(n.id)||{id:n.id},b=nodeChannels(viewers,route,channelLabels(route),false);return{...n,distinctIps:b.distinctIps,distinctDevices:b.distinctDevices,accessAlertThreshold:Number(route.accessAlertThreshold||0),suspicious:b.suspicious}});
  return {...localSnapshot,nodes,totalRequests:combined.totalRequests,totalBytes:combined.totalBytes,monthBytes:combined.monthBytes,playbackRequests:combined.playbackRequests,errors:combined.errors,active:combined.active,daily:combined.daily,machines,onlineMachines:machines.filter(machine=>machine.status==='online'&&machine.proxyHealthy).length};
}
const dashboardFeed=createDashboardFeed({build:dashboardSnapshot,subscribe:listener=>metrics.subscribe(listener)});
// Full per-node viewer roster (IP + device), merged and de-duplicated across every machine serving it.
function accessSnapshot(){
  const {machines}=machineTelemetryList(),viewers=indexViewersByNode(machines);
  return store.data.routes.map(r=>{const b=nodeChannels(viewers,r,channelLabels(r),true);return {id:r.id,alias:r.alias,name:r.name,threshold:b.threshold,distinctIps:b.distinctIps,distinctDevices:b.distinctDevices,suspicious:b.suspicious,status:b.suspicious?'疑似多人共享':'安全',channels:b.channels};});
}

const notFound=res=>json(res,404,{error:'not found'});
const adminAccount=()=>store.data.admin;
const otpUri=secret=>`otpauth://totp/${encodeURIComponent(`AegisRelay:${adminAccount().username}`)}?secret=${secret}&issuer=AegisRelay&digits=6&period=30`;
const findRoute=id=>store.data.routes.find(x=>x.id===id);
// A node change goes live on the panel's own proxy and is pushed to every remote machine.
function publishRoutes(){localAgent.reconcile();agentApi.invalidate();}
// The node record shared by create and import. Callers validate the alias and upstreams and pick the key.
function buildRoute(input,{alias,upstreams,accessMode,accessKey,enabled}){
  const now=new Date().toISOString();
  return {id:randomToken(12),alias,name:String(input.name||alias).slice(0,80),upstreams,allowPrivate:input.allowPrivate===true,tlsVerify:input.tlsVerify!==false,enabled,accessMode,
    showOnHome:input.showOnHome===true,clientProfile:cleanProfile(input.clientProfile),streamRewrite:cleanStreamRewrite(input.streamRewrite),autoSteer:cleanAutoSteer(input.autoSteer),egressAgentId:knownEgressAgent(input.egressAgentId),tags:cleanTags(input.tags),notes:String(input.notes||'').slice(0,500),favorite:input.favorite===true,
    sortOrder:numeric(input.sortOrder,-10000,10000),speedLimitMbps:numeric(input.speedLimitMbps,0,100000),monthlyQuotaGB:numeric(input.monthlyQuotaGB,0,1000000),reminderDays:numeric(input.reminderDays,0,365),accessAlertThreshold:numeric(input.accessAlertThreshold,0,100000),
    ...routeAuthFields(accessKey),createdAt:now,updatedAt:now};
}
// Node fields a PATCH sets directly, applied in this order.
const ROUTE_PATCH_FIELDS={
  name:v=>String(v).slice(0,80),enabled:v=>v===true,tlsVerify:v=>v===true,showOnHome:v=>v===true,clientProfile:cleanProfile,streamRewrite:cleanStreamRewrite,autoSteer:cleanAutoSteer,egressAgentId:cleanEgressAgent,tags:cleanTags,notes:v=>String(v).slice(0,500),favorite:v=>v===true,
  sortOrder:v=>numeric(v,-10000,10000),speedLimitMbps:v=>numeric(v,0,100000),monthlyQuotaGB:v=>numeric(v,0,1000000),reminderDays:v=>numeric(v,0,365),accessAlertThreshold:v=>numeric(v,0,100000)
};

// --- Endpoints answered before any session exists ---
async function setupAdmin(req,res){
  if (store.data.admin) return json(res, 409, { error:'already initialized' });
  const b = await body(req); if (!cfg.setupToken || !timingEqual(b.setupToken || '', cfg.setupToken)) { store.audit('setup.denied', ip(req)); return json(res, 403, { error:'invalid setup token' }); }
  // A fresh install is password-only; two-factor is opt-in from 个人设置 afterwards.
  store.data.admin = { username:String(b.username || 'admin').slice(0,64), passwordHash:hashPassword(b.password), totpSecret:null, recoveryDigests:[], createdAt:new Date().toISOString() };
  store.audit('admin.initialized', ip(req));
  return json(res, 201, { totpEnabled:false });
}
async function login(req,res,cookiePath){
  if (!store.data.admin || !loginLimiter.take(ip(req))) { store.audit('login.denied', ip(req)); return json(res, 429, { error:'try again later' }); }
  const b = await body(req), a = store.data.admin, totpOn = !!a.totpSecret, passwordOk = verifyPassword(b.password || '', a.passwordHash);
  let second = !totpOn || verifyTotp(a.totpSecret, b.code);
  // A recovery code is spent only once the password has proven who is signing in: checked the other way
  // round, a wrong password burned a valid code.
  if (passwordOk && totpOn && !second && b.recovery) { const d=tokenDigest(String(b.recovery),key), idx=(a.recoveryDigests||[]).findIndex(x=>timingEqual(x,d)); if(idx>=0){a.recoveryDigests.splice(idx,1);store.save();second=true;} }
  if (!passwordOk || !second) { store.audit('login.failed', ip(req)); return json(res, 401, { error:'invalid credentials' }); }
  const sid=randomToken(), csrf=randomToken(24); sessions[sid]={csrf,expires:Date.now()+30*60_000};pruneSessions();store.audit('login.success',ip(req));
  const cookie=`aegis_session=${encodeURIComponent(sid)}; HttpOnly; SameSite=Strict; Path=${cookiePath}; Max-Age=604800${cfg.secureCookies?'; Secure':''}`; return json(res,200,{csrf},{'set-cookie':cookie});
}
function logout(req,res,cookiePath){ const s=requireAuth(req);delete sessions[s.sid];store.audit('logout',ip(req));return json(res,200,{ok:true},{'set-cookie':`aegis_session=; HttpOnly; SameSite=Strict; Path=${cookiePath}; Max-Age=0`}); }
// Resume an existing session after a page refresh: hands the CSRF token back to a browser that still
// holds the HttpOnly, SameSite=Strict session cookie. No CSRF token is required to read it, and the
// strict cookie plus same-origin policy keep it unreadable to other sites.
function resumeSession(req,res){ const s=auth(req); if(!s) return json(res,401,{error:'登录已失效，请重新登录'}); return json(res,200,{csrf:s.csrf,username:store.data.admin?.username||''}); }
const publicApi={
  'GET /status':(req,res)=>json(res, 200, { initialized:!!store.data.admin, adminPath:cfg.adminPath, version:APP_VERSION }),
  // The panel icon shows on the login screen and as the favicon, both of which render before any session
  // exists. Served no-store (via the default headers): caching it made a freshly saved icon revert to the
  // stale cached value on the next refresh.
  'GET /branding':(req,res)=>json(res, 200, { icon:store.data.settings.panelIcon||'' }),
  'POST /setup':setupAdmin,
  'POST /login':login,
  'POST /logout':logout,
  'GET /session':resumeSession
};

// --- Account ---
async function updateIcon(req,res){
  const b=await body(req,MAX_ICON_BYTES*2);
  const icon=typeof b.url==='string'&&b.url.trim()?normalizePanelIcon(await fetchPanelIcon(b.url.trim())):normalizePanelIcon(b.icon);
  store.data.settings.panelIcon=icon;
  store.audit(icon?'account.icon_updated':'account.icon_reset',ip(req));store.save();
  return json(res,200,{ok:true,icon});
}
async function changePassword(req,res){
  const b=await body(req);
  if(!verifyPassword(b.currentPassword||'',adminAccount().passwordHash)){store.audit('account.password_denied',ip(req));return json(res,401,{error:'当前密码不正确'});}
  adminAccount().passwordHash=hashPassword(b.newPassword||'');
  store.audit('account.password_changed',ip(req));store.save();
  return json(res,200,{ok:true});
}
// Enrolment is two-step: the secret stays pending until a generated code proves the app has it.
async function beginTotp(req,res){
  const b=await body(req);
  if(!verifyPassword(b.password||'',adminAccount().passwordHash))return json(res,401,{error:'当前密码不正确'});
  const secret=newTotpSecret();
  adminAccount().pendingTotp={secret,startedAt:new Date().toISOString()};store.save();
  const uri=otpUri(secret);
  return json(res,200,{secret,uri,qr:qrRows(uri)});
}
async function enableTotp(req,res){
  const b=await body(req),pending=adminAccount().pendingTotp;
  if(!pending?.secret)return json(res,409,{error:'请先重新生成二维码'});
  if(!verifyTotp(pending.secret,b.code||'')){store.audit('account.totp_failed',ip(req));return json(res,401,{error:'验证码不正确，请确认手机时间已同步'});}
  const recovery=Array.from({length:8},()=>randomToken(9));
  adminAccount().totpSecret=pending.secret;adminAccount().recoveryDigests=recovery.map(v=>tokenDigest(v,key));
  delete adminAccount().pendingTotp;
  store.audit('account.totp_enabled',ip(req));store.save();
  return json(res,200,{ok:true,recovery});
}
async function disableTotp(req,res){
  const b=await body(req);
  if(!adminAccount().totpSecret)return json(res,409,{error:'两步验证尚未开启'});
  if(!verifyPassword(b.password||'',adminAccount().passwordHash))return json(res,401,{error:'当前密码不正确'});
  if(!verifyTotp(adminAccount().totpSecret,b.code||''))return json(res,401,{error:'验证码不正确'});
  adminAccount().totpSecret=null;adminAccount().recoveryDigests=[];delete adminAccount().pendingTotp;
  store.audit('account.totp_disabled',ip(req));store.save();
  return json(res,200,{ok:true});
}

// --- Machines ---
async function createEnrollment(req,res){
  const b=await body(req),issued=issueEnrollment(store.data,{name:b.name,domain:b.domain,routeIds:b.routeIds});
  let command;
  try{command=enrollmentInstallCommand({publicBaseUrl:cfg.publicBaseUrl,token:issued.token,name:issued.record.name,domain:issued.record.domain,email:store.data.settings.certificateEmail});}
  catch(error){store.data.enrollmentTokens=store.data.enrollmentTokens.filter(item=>item!==issued.record);throw error;}
  store.audit('agent.enrollment_created',ip(req),issued.record.id);
  return json(res,201,{expiresAt:issued.record.expiresAt,command,uninstallCommand:'sudo aegis-relay-agent uninstall'});
}
async function updateAgent(req,res,agent){
  const b=await body(req),now=new Date().toISOString(),local=agent.id===LOCAL_AGENT_ID,localDomainRequested=local&&b.domain!==undefined;
  // Validate the whole request before changing anything (see updateRoute): a domain or route-list error
  // used to arrive after the name had changed, and a local domain switch could already have been filed.
  let name,domain,routeIds,switching=false;
  if(b.name!==undefined){name=String(b.name||'').trim();if(!name||name.length>80)return json(res,400,{error:'invalid agent name'});}
  if(b.domain!==undefined){
    domain=normalizeAgentDomain(b.domain);
    if(local){
      if(!domain)return json(res,400,{error:'本机代理域名不能为空，请填写与面板不同的子域名'});
      if(!cfg.publicBaseUrl.startsWith('https://'))return json(res,409,{error:'请先在部署向导完成面板 HTTPS 配置'});
      if(domain===baseHostname(cfg.publicBaseUrl))return json(res,409,{error:'代理域名不能与面板域名相同'});
      const existing=localDomainStatus();switching=!!existing&&['pending','applying'].includes(existing.state);
      if(switching&&existing.desiredDomain!==domain)return json(res,409,{error:`正在切换到 ${existing.desiredDomain}，完成后再提交新域名`});
    }else if(domain&&!store.data.settings.certificateEmail)return json(res,409,{error:'请先在部署向导保存统一证书邮箱'});
  }
  if(b.routeIds!==undefined){
    if(!Array.isArray(b.routeIds))return json(res,400,{error:'routeIds must be an array'});
    routeIds=[...new Set(b.routeIds.map(String))];
    if(routeIds.some(id=>!store.data.routes.some(route=>route.id===id)))return json(res,400,{error:'unknown route id'});
  }
  // Apply. The local domain switch goes first: it is the one step that can still fail, and it checks its
  // input before writing anything.
  if(domain!==undefined){
    if(local){
      if(domain!==configuredLocalDomain&&!switching)requestDomainSwitch({dataFile:cfg.dataFile,domain,email:store.data.settings.certificateEmail,currentDomain:configuredLocalDomain});
      else if(domain===configuredLocalDomain)agent.domain=domain;
    }else{
      const currentMode=agent.proxyMode||(agent.domain?'domain':'ip');
      if(domain){if(currentMode!=='domain'||domain!==agent.domain){agent.desiredMode='domain';agent.desiredDomain=domain;agent.domainStatus={requestId:'',state:'pending',mode:'domain',desiredDomain:domain,currentDomain:agent.domain||'',message:'等待机器申请证书并切换 Nginx',updatedAt:new Date().toISOString()};}}
      else if(currentMode!=='ip'){agent.desiredMode='ip';delete agent.desiredDomain;agent.domainStatus={requestId:'',state:'pending',mode:'ip',desiredDomain:'',currentDomain:agent.domain||'',message:'等待机器切换为 IP 反代（HTTP）',updatedAt:new Date().toISOString()};}
    }
  }
  if(name!==undefined)agent.name=name;
  if(routeIds)replaceAgentDeployments(store.data,agent.id,routeIds,now);
  if(b.sortOrder!==undefined)agent.sortOrder=numeric(b.sortOrder,-10000,10000);
  if(b.steerTarget!==undefined)agent.steerTarget=b.steerTarget===true;
  agent.updatedAt=now;
  // Another machine's deployments or participation reshape the steering peers in this machine's snapshot too.
  if(local||routeIds||b.steerTarget!==undefined)localAgent.reconcile();
  if(b.steerTarget!==undefined||b.domain!==undefined)syncLocalEntry();
  agentApi.invalidate();
  store.audit(localDomainRequested?'agent.local_domain_requested':'agent.updated',ip(req),agent.id);
  return json(res,200,{agent:agentView(agent)});
}
async function agentResource(req,res,[,id]){
  const agent=store.data.agents.find(item=>item.id===id);if(!agent)return json(res,404,{error:'agent not found'});
  if(req.method==='PATCH')return updateAgent(req,res,agent);
  if(req.method==='DELETE'){
    if(agent.id===LOCAL_AGENT_ID)return json(res,409,{error:'the local agent cannot be deleted'});
    store.data.agents=store.data.agents.filter(item=>item!==agent);store.data.deployments=store.data.deployments.filter(item=>item.agentId!==agent.id);
    store.audit('agent.deleted',ip(req),agent.id);publishRoutes();
    return json(res,200,{ok:true});
  }
  return notFound(res);
}

// --- Nodes ---
async function createRoute(req,res){
  const b=await body(req), alias=checkedAlias(b.alias); if(store.data.routes.some(r=>r.alias===alias)) return json(res,409,{error:'alias already exists'});
  const upstreams=await validateUpstreamList(b.upstreams||b.upstream,b.allowPrivate===true);
  const accessMode=b.accessMode==='alias_only'?'alias_only':'key', accessKey=accessMode==='key'?connectionKey(b.accessKey):'';
  const r=buildRoute(b,{alias,upstreams,accessMode,accessKey,enabled:true}),now=r.createdAt;
  store.data.routes.push(r);
  // Deploy the new node onto exactly the machine picked in the drawer, so its shown client address
  // uses that machine's domain (routeBaseUrl prefers the remote deployment). A panel machine used
  // only for management must not silently pick up every new node as well — that deployment would
  // have to be turned off by hand after every single create. The panel keeps serving the node when
  // no agent is picked, when the picked one is unknown, or when it has no usable entry host yet
  // (freshly enrolled, no domain/IP): without that fallback the address handed out would be dead.
  const deployAgentId=String(b.agentId||''),deployAgent=deployAgentId&&deployAgentId!==LOCAL_AGENT_ID?store.data.agents?.find(a=>a.id===deployAgentId):null;
  if(deployAgent)store.data.deployments.push({id:deploymentId(deployAgentId,r.id),agentId:deployAgentId,routeId:r.id,enabled:true,createdAt:now,updatedAt:now});
  if(!deployAgent||!agentEntryUrl(deployAgent))ensureLocalDeployment(store.data,r.id,now);
  store.audit('route.created',ip(req),alias);publishRoutes();
  return json(res,201,{route:publicRoute(r),...credentialsFor(r,accessKey)});
}
async function importRoutes(req,res){
  const b=await body(req),items=Array.isArray(b.routes)?b.routes.slice(0,50):[];const credentials=[],errors=[];
  for(const item of items){
    try{
      const alias=checkedAlias(item.alias);if(store.data.routes.some(r=>r.alias===alias))throw new Error('alias already exists');
      const upstreams=await validateUpstreamList(item.upstreams||item.upstream,item.allowPrivate===true),accessMode=item.accessMode==='alias_only'?'alias_only':'key',accessKey=accessMode==='key'?randomToken(24):'';
      const r=buildRoute(item,{alias,upstreams,accessMode,accessKey,enabled:item.enabled!==false});
      store.data.routes.push(r);ensureLocalDeployment(store.data,r.id,r.createdAt);credentials.push({alias,...credentialsFor(r,accessKey)});
    }catch(e){errors.push({alias:String(item?.alias||''),error:e.message})}
  }
  store.audit('routes.imported',ip(req),`${credentials.length} imported`);publishRoutes();
  return json(res,200,{imported:credentials.length,credentials,errors});
}
async function updateRoute(req,res,r){
  const b=await body(req);
  // Work out and validate every change before touching the node. Fields used to be written as they were
  // read, so a request rejected half-way (an alias conflict, a blocked upstream) still left the earlier
  // ones applied in memory — unpublished, yet persisted by the next flush — including a freshly switched
  // access key the operator was never shown. Nothing is written until the request is known to succeed,
  // and the write itself has no await in it, so no other request can interleave with it.
  let mode=null,accessKey;
  if(b.accessMode!==undefined){const wanted=b.accessMode==='alias_only'?'alias_only':'key';if(wanted!==r.accessMode){mode=wanted;if(mode==='key')accessKey=connectionKey(b.accessKey);}}
  const fields={};
  for(const [field,clean] of Object.entries(ROUTE_PATCH_FIELDS))if(b[field]!==undefined)fields[field]=clean(b[field]);
  const alias=b.alias===undefined?undefined:checkedAlias(b.alias);
  let allowPrivate=r.allowPrivate,upstreams;
  if(b.upstreams!==undefined||b.upstream!==undefined||b.allowPrivate!==undefined){allowPrivate=b.allowPrivate===undefined?r.allowPrivate:b.allowPrivate===true;upstreams=await validateUpstreamList(b.upstreams||b.upstream||routeUpstreams(r),allowPrivate);}
  // After the await: another request may have taken the alias meanwhile.
  if(alias!==undefined&&store.data.routes.some(x=>x!==r&&x.alias===alias))return json(res,409,{error:'alias already exists'});
  let switchedKey=null;
  if(mode==='alias_only'){r.accessMode='alias_only';r.keyDigest=null;r.accessKey=null;delete r.routeAuthKey;delete r.authVersion;delete r.authMigrationRequired;switchedKey='';}
  else if(mode==='key'){r.accessMode='key';Object.assign(r,routeAuthFields(accessKey));delete r.authMigrationRequired;switchedKey=accessKey;}
  Object.assign(r,fields);
  if(alias!==undefined)r.alias=alias;
  if(upstreams){r.allowPrivate=allowPrivate;r.upstreams=upstreams;delete r.upstream;}
  r.updatedAt=new Date().toISOString();
  store.audit(switchedKey===null?'route.updated':'route.access_mode_changed',ip(req),r.alias);publishRoutes();
  return json(res,200,{route:publicRoute(r),...(switchedKey===null?{}:clientCredentials(r,switchedKey))});
}
async function routeResource(req,res,[,id]){
  const r=findRoute(id);if(!r)return notFound(res);
  if(req.method==='PATCH')return updateRoute(req,res,r);
  if(req.method==='DELETE'){
    store.data.routes=store.data.routes.filter(x=>x!==r);removeRouteDeployments(store.data,r.id);metrics.drop(r.id);dropRouteRuntime(r.id);
    store.audit('route.deleted',ip(req),r.alias);publishRoutes();
    return json(res,200,{ok:true});
  }
  return notFound(res);
}
function routeCredentials(req,res,[,id]){
  if(req.method!=='GET')return notFound(res);
  const r=findRoute(id);if(!r)return notFound(res);
  store.audit('route.credentials_viewed',ip(req),r.alias);
  return json(res,200,{...savedCredentials(r),publicBaseUrl:routeBaseUrl(r)});
}
async function rotateRouteKey(req,res,[,id]){
  if(req.method!=='POST')return notFound(res);
  const r=findRoute(id);if(!r)return notFound(res);
  if(r.accessMode==='alias_only')return json(res,409,{error:'this node does not use an access key'});
  const b=await body(req),accessKey=connectionKey(b.accessKey),routeAuthKey=r.authVersion===ROUTE_AUTH_VERSION&&isRouteAuthKey(r.routeAuthKey)?r.routeAuthKey:newRouteAuthKey();
  r.authVersion=ROUTE_AUTH_VERSION;r.routeAuthKey=routeAuthKey;r.keyDigest=routeTokenDigest(accessKey,routeAuthKey);r.accessKey=accessKey;delete r.authMigrationRequired;r.updatedAt=new Date().toISOString();
  store.audit('route.key_rotated',ip(req),r.alias);publishRoutes();
  return json(res,200,credentialsFor(r,accessKey));
}
async function routeChannelList(req,res,[,id]){
  const r=findRoute(id);if(!r)return notFound(res);
  if(req.method==='GET')return json(res,200,{channels:channelCredentials(r),publicBaseUrl:routeBaseUrl(r)});
  if(req.method==='POST'){
    if(r.accessMode!=='key')return json(res,409,{error:'该节点未启用连接密码，无法添加分发通道；请先在编辑里开启连接密码'});
    const b=await body(req);r.channels=Array.isArray(r.channels)?r.channels:[];
    if(r.channels.length>=32)return json(res,409,{error:'一个节点最多 32 个分发通道'});
    const channel=newChannel(b.label,b.accessKey);r.channels.push(channel);r.updatedAt=new Date().toISOString();
    store.audit('route.channel_added',ip(req),`${r.alias}:${channel.label}`);publishRoutes();
    return json(res,201,{channel:{id:channel.id,label:channel.label,clientPath:`/${r.alias}/${channel.accessKey}/`},publicBaseUrl:routeBaseUrl(r)});
  }
  return notFound(res);
}
async function routeChannel(req,res,[,id,cid]){
  const r=findRoute(id);if(!r)return notFound(res);
  if(cid==='default')return json(res,409,{error:'默认通道不能在此删除/改名，请用列表中的“密码”按钮'});
  r.channels=Array.isArray(r.channels)?r.channels:[];const channel=r.channels.find(c=>c.id===cid);if(!channel)return json(res,404,{error:'通道不存在'});
  if(req.method==='DELETE'){r.channels=r.channels.filter(c=>c.id!==cid);r.updatedAt=new Date().toISOString();store.audit('route.channel_removed',ip(req),`${r.alias}:${channel.label}`);publishRoutes();return json(res,200,{ok:true});}
  if(req.method==='PATCH'){const b=await body(req);channel.label=String(b.label||'').slice(0,40);r.updatedAt=new Date().toISOString();publishRoutes();return json(res,200,{ok:true,label:channel.label});}
  return notFound(res);
}
function completeReminder(req,res,[,id]){
  if(req.method!=='POST')return notFound(res);
  const r=findRoute(id);if(!r)return notFound(res);
  r.reminderLastAt=new Date().toISOString();r.reminderNotifiedAt=null;store.audit('route.reminder_completed',ip(req),r.alias);
  return json(res,200,{ok:true,at:r.reminderLastAt});
}
async function diagnose(req,res,[,id]){
  if(req.method!=='GET'&&req.method!=='POST')return notFound(res);
  const r=findRoute(id);if(!r)return notFound(res);
  const result=await diagnoseRoute(r);store.audit('route.diagnosed',ip(req),r.alias);
  return json(res,200,result);
}

// --- Settings ---
async function updateDeployment(req,res){const b=await body(req);store.data.settings.certificateEmail=normalizeCertificateEmail(b.certificateEmail);store.audit('deployment.certificate_email_updated',ip(req));return json(res,200,{ok:true,certificateEmail:store.data.settings.certificateEmail});}
async function updateNotifications(req,res){const b=await body(req),result=notifier.configure(b);store.audit('notifications.updated',ip(req));return json(res,200,result);}
async function testNotifications(req,res){await notifier.test();store.audit('notifications.tested',ip(req));return json(res,200,{ok:true});}
async function updateSteering(req,res){
  const b=await body(req);
  // Validate everything before writing (see updateRoute).
  if(b.mode!==undefined&&!STEERING_MODES.includes(b.mode))return json(res,400,{error:'invalid steering mode'});
  const entry=b.entryDomain===undefined?undefined:normalizeEntryDomain(b.entryDomain);
  if(entry&&entry===baseHostname(cfg.publicBaseUrl))return json(res,409,{error:'入口域名不能与面板域名相同'});
  const settings=steeringSettings(store.data);
  if(b.mode!==undefined)settings.mode=b.mode;
  if(entry!==undefined)settings.entryDomain=entry;
  if(b.excludedClients!==undefined)settings.excludedClients=normalizeClientList(b.excludedClients);
  if(b.boundedClients!==undefined)settings.boundedClients=normalizeClientList(b.boundedClients);
  if(b.boundMB!==undefined)settings.boundMB=Math.round(numeric(b.boundMB,8,1024));
  if(b.clearAutoExcluded===true)settings.autoExcluded={};
  if(b.boundAuto!==undefined)settings.boundAuto=b.boundAuto===true;
  if(b.clearRangeAuto===true){settings.autoBounded={};settings.autoUnbounded={};steeringHub.bounds.clear();}
  store.audit('steering.updated',ip(req),settings.mode);store.save();publishRoutes();syncLocalEntry();
  return json(res,200,steeringView());
}

const adminApi={
  'GET /account':(req,res)=>json(res,200,{username:adminAccount().username,totpEnabled:!!adminAccount().totpSecret,recoveryRemaining:(adminAccount().recoveryDigests||[]).length}),
  'PUT /account/icon':updateIcon,
  'POST /account/password':changePassword,
  'POST /account/totp/begin':beginTotp,
  'POST /account/totp/enable':enableTotp,
  'POST /account/totp/disable':disableTotp,
  'GET /routes':(req,res)=>json(res,200,{routes:store.data.routes.map(publicRoute).sort((a,b)=>a.sortOrder-b.sortOrder||Number(b.favorite)-Number(a.favorite)||a.name.localeCompare(b.name))}),
  'POST /routes':createRoute,
  'POST /import':importRoutes,
  'GET /export':(req,res)=>json(res,200,{version:1,exportedAt:new Date().toISOString(),routes:store.data.routes.map(r=>{const x=publicRoute(r);delete x.id;delete x.createdAt;delete x.updatedAt;return x})}),
  // Sort is stable, so machines that never got an explicit order keep their registration order.
  'GET /agents':(req,res)=>json(res,200,{panelVersion:APP_VERSION,agents:store.data.agents.map(agentView).sort((a,b)=>a.sortOrder-b.sortOrder)}),
  'POST /agents/enrollment':createEnrollment,
  'GET /dashboard':(req,res)=>json(res,200,dashboardSnapshot()),
  'GET /events':(req,res)=>{res.writeHead(200,headers({'content-type':'text/event-stream','connection':'keep-alive'}));req.on('close',dashboardFeed.follow(res));},
  'GET /access':(req,res)=>json(res,200,{nodes:accessSnapshot()}),
  'GET /diagnostics':(req,res)=>json(res,200,{nodes:getRuntimeStatus(localAgent.routeSource.getRoutes())}),
  'GET /audit':(req,res)=>json(res,200,{audit:store.data.audit.slice(0,100)}),
  'GET /deployment':(req,res,cookiePath)=>json(res,200,{adminPath:cookiePath,secureCookies:cfg.secureCookies,publicBaseUrl:cfg.publicBaseUrl,localProxyBaseUrl:clientBaseUrl(),splitDomains:!!cfg.localProxyBaseUrl&&baseHostname(cfg.localProxyBaseUrl)!==baseHostname(cfg.publicBaseUrl),httpsReady:cfg.secureCookies&&cfg.publicBaseUrl.startsWith('https://'),certificateEmail:store.data.settings.certificateEmail||'',domainChange:localDomainStatus()}),
  'PUT /deployment':updateDeployment,
  'GET /steering':(req,res)=>json(res,200,steeringView()),
  'PUT /steering':updateSteering,
  'GET /notifications':(req,res)=>json(res,200,notifier.view()),
  'PUT /notifications':updateNotifications,
  'POST /notifications/test':testNotifications
};
// [pattern, handler]: each handler answers the methods it supports and 404s the rest.
const adminResources=[
  [/^\/agents\/([^/]+)$/,agentResource],
  [/^\/routes\/([^/]+)$/,routeResource],
  [/^\/routes\/([^/]+)\/credentials$/,routeCredentials],
  [/^\/routes\/([^/]+)\/rotate-key$/,rotateRouteKey],
  [/^\/routes\/([^/]+)\/channels$/,routeChannelList],
  [/^\/routes\/([^/]+)\/channels\/([^/]+)$/,routeChannel],
  [/^\/routes\/([^/]+)\/reminder-complete$/,completeReminder],
  [/^\/diagnostics\/([^/]+)$/,diagnose]
];

// Public endpoints answer first; everything else needs a live session and its CSRF token, even to learn
// that a path does not exist. Exact paths are matched before parameterised ones.
async function api(req, res, rel, cookiePath = cfg.adminPath) {
  const endpoint=`${req.method} ${rel}`;
  if(publicApi[endpoint])return publicApi[endpoint](req,res,cookiePath);
  requireAuth(req);
  if(adminApi[endpoint])return adminApi[endpoint](req,res,cookiePath);
  for(const [pattern,handle] of adminResources){const match=rel.match(pattern);if(match)return handle(req,res,match);}
  return notFound(res);
}

async function serveAdmin(req,res,prefix){
  try{
    const u=new URL(req.url,'http://admin.invalid');
    if(prefix!=='/'&&u.pathname===prefix&&req.method==='GET'){res.writeHead(308,headers({location:`${prefix}/`}));return res.end()}
    const rel=adminRelative(u.pathname,prefix);if(rel===null)return json(res,404,{error:'not found'});
    if(rel.startsWith('/api/'))return await api(req,res,rel.slice(4),prefix);
    if(req.method!=='GET')return json(res,405,{error:'method not allowed'});
    if(rel==='/app.js'){res.writeHead(200,headers({'content-type':'text/javascript; charset=utf-8'}));return res.end(appjs)}
    if(rel==='/style.css'){res.writeHead(200,headers({'content-type':'text/css; charset=utf-8'}));return res.end(stylesheet)}
    if(rel==='/help.css'){res.writeHead(200,headers({'content-type':'text/css; charset=utf-8'}));return res.end(helpStylesheet)}
    if(rel!=='/'&&rel!=='/index.html')return json(res,404,{error:'not found'});
    res.writeHead(200,headers({'content-type':'text/html; charset=utf-8'}));res.end(ui);
  }catch(e){json(res,e.status||400,{error:String(e.message||'request rejected').slice(0,160)});}
}
const admin=http.createServer((req,res)=>serveAdmin(req,res,cfg.adminPath));
admin.requestTimeout=35_000;admin.headersTimeout=10_000;admin.listen(cfg.adminPort,cfg.adminHost,()=>console.log(`AegisRelay admin listening on http://${cfg.adminHost}:${cfg.adminPort}${cfg.adminPath}`));
const steering=new SteeringEngine({selfId:LOCAL_AGENT_ID,lineOf:activeUpstreamLine,canServe:route=>metrics.canServe(route)});
steering.start(async payload=>steeringHub.exchange(LOCAL_AGENT_ID,payload),()=>localAgent.routeSource.getRoutes());
const relay=makeProxyHandler(localAgent.routeSource,key,metrics,steering);
const panelHostname=baseHostname(cfg.publicBaseUrl),proxyHostname=baseHostname(cfg.localProxyBaseUrl)||panelHostname,splitDomains=!!panelHostname&&!!proxyHostname&&panelHostname!==proxyHostname;
function requestHostname(req){try{return new URL(`http://${String(req.headers.host||'')}`).hostname.toLowerCase()}catch{return''}}
// The steering entry domain is a second public name of this machine's data plane.
function isEntryHost(hostname){const entry=steeringSettings(store.data).entryDomain;return !!entry&&hostname===entry}
// A single bad request must never take the relay down mid-playback; nginx keeps serving, so do we.
function relayFailed(res,err){console.error('[aegis] relay error',err&&err.stack||err);if(res.headersSent||res.destroyed||res.writableEnded)return;try{res.writeHead(502,{'cache-control':'no-store'});res.end('bad gateway')}catch{}}
const proxy=http.createServer(RELAY_SERVER_OPTIONS,(req,res)=>{
  res.on('error',()=>{});
  let pathname; try{pathname=new URL(req.url,'http://relay.invalid').pathname}catch{return relayFailed(res,new Error('invalid request target'))}
  try{
    const hostname=requestHostname(req),role=isEntryHost(hostname)?'proxy':domainRequestRole({panelHostname,proxyHostname,requestHostname:hostname});
    if(role==='reject')return json(res,421,{error:'misdirected request'});
    if(role==='proxy'){const out=relay(req,res);if(out&&typeof out.catch==='function')out.catch(err=>relayFailed(res,err));return}
    if(pathname==='/agent-install.sh'&&req.method==='GET'){res.writeHead(200,headers({'content-type':'text/x-shellscript; charset=utf-8'}));return res.end(agentInstaller)}
    if(pathname==='/agent-upgrade.sh'&&req.method==='GET'){res.writeHead(200,headers({'content-type':'text/x-shellscript; charset=utf-8'}));return res.end(agentUpgrader)}
    const out=pathname.startsWith('/api/agent/v1/')?agentApi.handle(req,res):(isRootAdminRequest(pathname)?serveAdmin(req,res,'/'):(role==='control'?json(res,404,{error:'not found'}):relay(req,res)));
    if(out&&typeof out.catch==='function')out.catch(err=>relayFailed(res,err));
  }
  catch(err){relayFailed(res,err)}
});
proxy.requestTimeout=0;proxy.keepAliveTimeout=75_000;proxy.keepAliveTimeoutBuffer=5_000;proxy.headersTimeout=80_000;
proxy.on('connection',socket=>{socket.setNoDelay(true);socket.setKeepAlive(true,15_000)});
proxy.on('clientError',(err,socket)=>{if(!socket.destroyed)socket.destroy()});
proxy.on('upgrade',(req,socket,head)=>{socket.on('error',()=>socket.destroy());try{if(splitDomains&&requestHostname(req)!==proxyHostname&&!isEntryHost(requestHostname(req)))return socket.destroy();handleUpgrade(req,socket,head,localAgent.routeSource,key)}catch(err){console.error('[aegis] upgrade error',err&&err.stack||err);socket.destroy()}});
proxy.listen(cfg.proxyPort,cfg.proxyHost,()=>console.log(`AegisRelay proxy listening on ${cfg.proxyHost}:${cfg.proxyPort}`));
process.on('uncaughtException',err=>console.error('[aegis] uncaught exception',err&&err.stack||err));
process.on('unhandledRejection',err=>console.error('[aegis] unhandled rejection',err&&err.stack||err));
const flushTimer=setInterval(()=>store.save(),60_000);flushTimer.unref();
const reminderTimer=setInterval(()=>notifier.tick(store.data.routes),60*60_000);reminderTimer.unref();
// Other machines joining, leaving or changing domain reshape the peers this machine forwards to.
const entryTimer=setInterval(syncLocalEntry,30_000);entryTimer.unref();syncLocalEntry();
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{clearInterval(flushTimer);clearInterval(reminderTimer);clearInterval(entryTimer);steering.stop();const saved=store.save();agentApi.close();admin.close();proxy.close(()=>saved.then(()=>process.exit(0)));setTimeout(()=>process.exit(1),10_000).unref();});
