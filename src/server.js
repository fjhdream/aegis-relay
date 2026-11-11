import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveKey, hashPassword, newTotpSecret, randomToken, RateLimiter, requestIp, tokenDigest, verifyPassword, verifyTotp, timingEqual } from './security.js';
import { Store } from './store.js';
import { handleUpgrade, makeProxyHandler, RELAY_SERVER_OPTIONS } from './proxy.js';
import { activeUpstreamLine, getRuntimeStatus } from './upstream-exchange.js';
import { Metrics } from './metrics.js';
import { diagnoseRoute } from './diagnostics.js';
import { Notifier } from './notifier.js';
import { adminRelative, isRootAdminRequest, normalizeAdminPath } from './admin-path.js';
import { LocalAgent } from './local-agent.js';
import { DesiredSnapshots } from './desired-snapshots.js';
import { LOCAL_AGENT_ID, publicAgent } from './agent-registry.js';
import { AgentApi, normalizeCertificateEmail } from './agent-api.js';
import { aggregateTelemetry, indexViewersByNode, nodeChannels, sanitizeTelemetry, telemetryFromMetrics } from './telemetry.js';
import { createDashboardFeed } from './dashboard-feed.js';
import { activeLocalDomain, baseHostname, domainRequestRole } from './domain-control.js';
import { qrRows } from './qr.js';
import { fetchPanelIcon, MAX_ICON_BYTES, normalizePanelIcon } from './panel-icon.js';
import { SteeringEngine } from './steering.js';
import { SteeringHub } from './steering-hub.js';
import { localTransport } from './steering-sync.js';
import { readEntryDomain, readSteeringSettings, steeringSettings } from './steering-topology.js';
import { channelList, Panel } from './panel.js';

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
// Every machine's desired snapshot, the panel's own included. Anything below that changes nodes,
// deployments, machines or steering settings calls snapshots.refresh(); it works out who changed.
const snapshots = new DesiredSnapshots({store,localBase:clientBaseUrl()});
const localAgent = new LocalAgent({store,snapshots}); localAgent.start();
// After the local agent: on a fresh install it is what creates this record, and the steering topology
// reads the domain from the record (an empty one left the panel machine out until the next restart).
const localRecord=store.data.agents.find(agent=>agent.id===LOCAL_AGENT_ID);
if(localRecord&&configuredLocalDomain&&localRecord.domain!==configuredLocalDomain){localRecord.domain=configuredLocalDomain;localRecord.updatedAt=new Date().toISOString();store.save();snapshots.refresh();}
// Automatic steering: the hub arbitrates sessions across machines; a client type that keeps failing to
// follow steering redirects is excluded for good (until the operator clears it).
// Capped ranges (direct play cut into requests): a client type that continued on trial is switched on
// until the operator clears the automatic results. None is switched off automatically; one an older
// version switched off (autoUnbounded) stays off until the operator clears it. The check only reads:
// steeringSettings() replaces the stored settings, so it is taken only when there is something to add.
function rangeVerdict(client,works){
  const stored=readSteeringSettings(store.data),lower=client.toLowerCase(),has=map=>Object.keys(map).some(item=>item.toLowerCase()===lower);
  if(!works||has(stored.autoUnbounded)||has(stored.autoBounded))return;
  steeringSettings(store.data).autoBounded[client]=new Date().toISOString();
  store.audit('steering.client_range_enabled','system',client);store.save();
}
const steeringHub = new SteeringHub({store,onBoundVerdict:rangeVerdict,onAutoExclude:client=>{const settings=steeringSettings(store.data);if(Object.keys(settings.autoExcluded).some(item=>item.toLowerCase()===client.toLowerCase()))return;settings.autoExcluded[client]=new Date().toISOString();store.audit('steering.client_auto_excluded','system',client);store.save();}});
const agentApi = new AgentApi({store,version:APP_VERSION,steering:steeringHub,snapshots});
// Compile every machine once at boot, so each card shows 「等待同步」 or 「已同步」 right away instead of
// after that machine's first poll. An unchanged machine keeps its revision.
snapshots.refresh();
const metrics = new Metrics(store);
// Stats for nodes deleted by earlier versions were never removed; sweep them once at boot.
metrics.retainOnly(store.data.routes.map(route=>route.id||route.alias));
const notifier = new Notifier(store,metrics);
// Every operator change to nodes, machines and settings, with the views of them (see panel.js).
const panel = new Panel({store,snapshots,localAgent,steeringHub,metrics,dataFile:cfg.dataFile,publicBaseUrl:cfg.publicBaseUrl,localProxyBaseUrl:cfg.localProxyBaseUrl,configuredLocalDomain});
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
function clientBaseUrl(){return cfg.localProxyBaseUrl||cfg.publicBaseUrl}
function machineTelemetryList(){
  const localSnapshot=metrics.snapshot(localAgent.routeSource.getRoutes()),localTelemetry=telemetryFromMetrics(localSnapshot),localRecord=store.data.agents.find(agent=>agent.id===LOCAL_AGENT_ID)||{id:LOCAL_AGENT_ID,name:'主代理机器'},localView=panel.agentView(localRecord);
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

// --- Machines, nodes and settings: the HTTP side of panel.js ---
// A resource is looked up before its body is read, so a missing one answers 404 whatever the body.
async function agentResource(req,res,[,id]){
  if(!panel.findAgent(id))return json(res,404,{error:'agent not found'});
  if(req.method==='PATCH')return json(res,200,panel.updateAgent(id,await body(req),ip(req)));
  if(req.method==='DELETE')return json(res,200,panel.deleteAgent(id,ip(req)));
  return notFound(res);
}
async function routeResource(req,res,[,id]){
  if(!panel.findRoute(id))return notFound(res);
  if(req.method==='PATCH')return json(res,200,await panel.updateRoute(id,await body(req),ip(req)));
  if(req.method==='DELETE')return json(res,200,panel.deleteRoute(id,ip(req)));
  return notFound(res);
}
function routeCredentials(req,res,[,id]){
  if(req.method!=='GET'||!panel.findRoute(id))return notFound(res);
  return json(res,200,panel.routeCredentials(id,ip(req)));
}
async function rotateRouteKey(req,res,[,id]){
  if(req.method!=='POST'||!panel.findRoute(id))return notFound(res);
  if(panel.findRoute(id).accessMode==='alias_only')return json(res,409,{error:'this node does not use an access key'});
  return json(res,200,panel.rotateRouteKey(id,await body(req),ip(req)));
}
async function routeChannelList(req,res,[,id]){
  if(!panel.findRoute(id))return notFound(res);
  if(req.method==='GET')return json(res,200,panel.channels(id));
  if(req.method==='POST'){panel.assertChannelsOpen(id);return json(res,201,panel.addChannel(id,await body(req),ip(req)));}
  return notFound(res);
}
async function routeChannel(req,res,[,id,cid]){
  if(!panel.findRoute(id))return notFound(res);
  panel.channel(id,cid);
  if(req.method==='DELETE')return json(res,200,panel.removeChannel(id,cid,ip(req)));
  if(req.method==='PATCH')return json(res,200,panel.renameChannel(id,cid,await body(req),ip(req)));
  return notFound(res);
}
function completeReminder(req,res,[,id]){
  if(req.method!=='POST'||!panel.findRoute(id))return notFound(res);
  return json(res,200,panel.completeReminder(id,ip(req)));
}
async function diagnose(req,res,[,id]){
  if(req.method!=='GET'&&req.method!=='POST')return notFound(res);
  const r=panel.findRoute(id);if(!r)return notFound(res);
  const result=await diagnoseRoute(r);store.audit('route.diagnosed',ip(req),r.alias);
  return json(res,200,result);
}

// --- Settings ---
async function updateNotifications(req,res){const b=await body(req),result=notifier.configure(b);store.audit('notifications.updated',ip(req));return json(res,200,result);}
async function testNotifications(req,res){await notifier.test();store.audit('notifications.tested',ip(req));return json(res,200,{ok:true});}
const adminApi={
  'GET /account':(req,res)=>json(res,200,{username:adminAccount().username,totpEnabled:!!adminAccount().totpSecret,recoveryRemaining:(adminAccount().recoveryDigests||[]).length}),
  'PUT /account/icon':updateIcon,
  'POST /account/password':changePassword,
  'POST /account/totp/begin':beginTotp,
  'POST /account/totp/enable':enableTotp,
  'POST /account/totp/disable':disableTotp,
  'GET /routes':(req,res)=>json(res,200,{routes:panel.routes()}),
  'POST /routes':async(req,res)=>json(res,201,await panel.createRoute(await body(req),ip(req))),
  'POST /import':async(req,res)=>json(res,200,await panel.importRoutes(await body(req),ip(req))),
  'GET /export':(req,res)=>json(res,200,panel.exportRoutes()),
  'GET /agents':(req,res)=>json(res,200,{panelVersion:APP_VERSION,agents:panel.agents()}),
  'POST /agents/enrollment':async(req,res)=>json(res,201,panel.createEnrollment(await body(req),ip(req))),
  'GET /dashboard':(req,res)=>json(res,200,dashboardSnapshot()),
  'GET /events':(req,res)=>{res.writeHead(200,headers({'content-type':'text/event-stream','connection':'keep-alive'}));req.on('close',dashboardFeed.follow(res));},
  'GET /access':(req,res)=>json(res,200,{nodes:accessSnapshot()}),
  'GET /diagnostics':(req,res)=>json(res,200,{nodes:getRuntimeStatus(localAgent.routeSource.getRoutes())}),
  'GET /audit':(req,res)=>json(res,200,{audit:store.data.audit.slice(0,100)}),
  'GET /deployment':(req,res,cookiePath)=>json(res,200,{adminPath:cookiePath,secureCookies:cfg.secureCookies,publicBaseUrl:cfg.publicBaseUrl,localProxyBaseUrl:clientBaseUrl(),splitDomains:!!cfg.localProxyBaseUrl&&baseHostname(cfg.localProxyBaseUrl)!==baseHostname(cfg.publicBaseUrl),httpsReady:cfg.secureCookies&&cfg.publicBaseUrl.startsWith('https://'),certificateEmail:store.data.settings.certificateEmail||'',domainChange:panel.localDomainStatus()}),
  'PUT /deployment':async(req,res)=>json(res,200,panel.updateCertificateEmail(await body(req),ip(req))),
  'GET /steering':(req,res)=>json(res,200,panel.steering()),
  'PUT /steering':async(req,res)=>json(res,200,panel.updateSteering(await body(req),ip(req))),
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
// The panel machine syncs with its own hub exactly as a remote machine would, minus the network.
steering.start(localTransport(steeringHub,LOCAL_AGENT_ID),()=>localAgent.routeSource.getRoutes());
const relay=makeProxyHandler(localAgent.routeSource,key,metrics,steering);
const panelHostname=baseHostname(cfg.publicBaseUrl),proxyHostname=baseHostname(cfg.localProxyBaseUrl)||panelHostname,splitDomains=!!panelHostname&&!!proxyHostname&&panelHostname!==proxyHostname;
function requestHostname(req){try{return new URL(`http://${String(req.headers.host||'')}`).hostname.toLowerCase()}catch{return''}}
// The steering entry domain is a second public name of this machine's data plane. Checked on every
// proxied request, so it only reads the stored domain; there is no cache, a panel edit applies at once.
function isEntryHost(hostname){const entry=readEntryDomain(store.data);return !!entry&&hostname===entry}
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
const entryTimer=setInterval(()=>panel.syncEntry(),30_000);entryTimer.unref();panel.syncEntry();
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{clearInterval(flushTimer);clearInterval(reminderTimer);clearInterval(entryTimer);steering.stop();const saved=store.save();agentApi.close();admin.close();proxy.close(()=>saved.then(()=>process.exit(0)));setTimeout(()=>process.exit(1),10_000).unref();});
