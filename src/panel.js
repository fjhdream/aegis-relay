import path from 'node:path';
import { cleanAlias, randomToken } from './security.js';
import { validateUpstreamList } from './proxy.js';
import { dropRouteRuntime } from './upstream-exchange.js';
import { clientCredentials, savedCredentials } from './credentials.js';
import { customConnectionKey } from './connection-key.js';
import { isRouteAuthKey, newRouteAuthKey, ROUTE_AUTH_VERSION, routeChannels, routeTokenDigest } from './route-auth.js';
import { agentEntryUrl, agentKnows, deploymentId, ensureLocalDeployment, LOCAL_AGENT_ID, normalizeAgentDomain, publicAgent, removeRouteDeployments, replaceAgentDeployments, routeEntryBaseUrl } from './agent-registry.js';
import { enrollmentInstallCommand, issueEnrollment, normalizeCertificateEmail } from './agent-api.js';
import { baseHostname, followEntry, readDomainStatus, readEntryStatus, requestDomainSwitch } from './domain-control.js';
import { STEERING_MODES } from './steering.js';
import { agentSteeringIssues, desiredEntry, egressIssues, egressTopology, ENTRY_CAPABILITY, entryCommand, entryCoverageGaps, normalizeClientList, normalizeEntryDomain, routeSteeringIssues, steeringEntryBaseUrl, steeringSettings } from './steering-topology.js';
import { nodeLines } from './line-sync.js';

// The panel: every change an operator makes to nodes, their distribution channels, machines, steering
// and deployment settings, and the views of them the admin pages show. Each change checks the whole
// request before it writes anything, then commits the same way: every machine's desired snapshot is
// refreshed, the panel machine's entry domain is brought in line, and the change is audited and saved.
// Errors carry the HTTP status the admin API answers with. How a request arrives (HTTP, sessions,
// CSRF) is server.js's business.

const fail=(status,message)=>Object.assign(new Error(message),{status});
const notFound=(message='not found')=>fail(404,message);

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
function cleanAutoSteer(value={}){if(!value||typeof value!=='object')return{enabled:false,minRateMbps:0};return{enabled:value.enabled===true,minRateMbps:numeric(value.minRateMbps,0,100000)}}
function connectionKey(value){return customConnectionKey(value)||randomToken(24)}
function routeAuthFields(accessKey) {
  if (!accessKey) return { keyDigest:null, accessKey:null };
  const routeAuthKey=newRouteAuthKey();
  return { authVersion:ROUTE_AUTH_VERSION, routeAuthKey, keyDigest:routeTokenDigest(accessKey,routeAuthKey), accessKey };
}
// One extra distribution channel (a labeled per-user connection key) beyond the node's default key.
function newChannel(label,accessKey){const key=connectionKey(accessKey),routeAuthKey=newRouteAuthKey();return{id:randomToken(8),label:String(label||'').slice(0,40),accessKey:key,routeAuthKey,keyDigest:routeTokenDigest(key,routeAuthKey),authVersion:ROUTE_AUTH_VERSION,createdAt:new Date().toISOString()};}
// Channel list without secrets (for the node view and the access mapping).
export function channelList(r){return routeChannels(r).map(ch=>({id:ch.id,label:ch.label||(ch.id==='default'?'默认':''),createdAt:ch.createdAt||r.createdAt||null,isDefault:ch.id==='default'}));}
// Channel list WITH each channel's client URL (for the operator to copy and hand out).
function channelCredentials(r){return routeChannels(r).map(ch=>({id:ch.id,label:ch.label||(ch.id==='default'?'默认':''),isDefault:ch.id==='default',clientPath:ch.accessKey?`/${r.alias}/${ch.accessKey}/`:`/${r.alias}/`}));}
function checkedAlias(value){const alias=cleanAlias(value);if(['r','api','gateway','app','index','index.html','favicon.ico'].includes(alias))throw new Error('alias is reserved');return alias;}
// A switch that finished and already matches the live endpoint is not news: the "当前生效域名"
// field and the sync pill already show it, so surfacing a permanent green "已生效" banner is just
// noise. Keep only in-progress (pending/applying) and failed states.
function ongoingDomainChange(change,liveEndpoint){
  if(!change)return null;
  if(change.state==='active'&&(!change.currentDomain||change.currentDomain===liveEndpoint))return null;
  return change;
}

export class Panel {
  // dataFile locates the panel machine's host request and status files (domain switch, entry domain).
  constructor({store,snapshots,localAgent,steeringHub=null,metrics=null,dataFile,publicBaseUrl='',localProxyBaseUrl='',configuredLocalDomain=''}) {
    Object.assign(this,{store,snapshots,localAgent,steeringHub,metrics,publicBaseUrl,localProxyBaseUrl,configuredLocalDomain});
    this.dataDir=path.dirname(dataFile);
    // The machine a node's upstream traffic all leaves from (see egressTopology). Import keeps only known
    // machines; an explicit edit naming an unknown one is rejected.
    const knownEgressAgent=value=>{const id=String(value||'').trim().slice(0,64);return id&&this.data.agents.some(agent=>agent.id===id&&agent.state!=='revoked')?id:''};
    const cleanEgressAgent=value=>{const id=knownEgressAgent(value);if(String(value||'').trim()&&!id)throw fail(400,'unknown egress machine');return id};
    // A node's simple settings: one cleaner per field, shared by create (and import), PATCH and the view,
    // so each field's default and limits are written once. A field may clean differently on PATCH: an
    // imported config may name a machine of another panel (dropped), but an explicit edit naming an
    // unknown machine is a mistake (rejected). The identity fields (alias, upstreams, access mode and key,
    // name, enabled) have checks of their own and are set where those run.
    this.fields={
      tlsVerify:{clean:v=>v!==false},showOnHome:{clean:v=>v===true},clientProfile:{clean:cleanProfile},streamRewrite:{clean:cleanStreamRewrite},autoSteer:{clean:cleanAutoSteer},
      egressAgentId:{clean:knownEgressAgent,patch:cleanEgressAgent,view:v=>String(v||'')},lineSync:{clean:v=>v!==false},lineSyncUpstream:{clean:v=>v===true},
      tags:{clean:cleanTags},notes:{clean:v=>String(v||'').slice(0,500)},favorite:{clean:v=>v===true},
      sortOrder:{clean:v=>numeric(v,-10000,10000)},speedLimitMbps:{clean:v=>numeric(v,0,100000)},monthlyQuotaGB:{clean:v=>numeric(v,0,1000000)},reminderDays:{clean:v=>numeric(v,0,365)},accessAlertThreshold:{clean:v=>numeric(v,0,100000)}
    };
  }

  get data() { return this.store.data; }
  clientBaseUrl() { return this.localProxyBaseUrl||this.publicBaseUrl; }

  // Every change ends here, whatever it touched: a refresh is a no-op for machines it did not reshape,
  // and the entry request is only filed when the panel machine's entry actually needs one.
  commit(event,actor,detail) {
    this.snapshots.refresh();
    this.syncEntry();
    this.store.audit(event,actor,detail);
  }

  // The panel machine serves the entry domain like every other participating machine; its host unit
  // applies the request (agents do the same from their check-in).
  syncEntry() {
    try{followEntry({dir:this.dataDir,entry:desiredEntry(this.data,LOCAL_AGENT_ID)})}
    catch(error){console.error('[aegis] entry domain request failed',error?.message||error)}
  }

  // --- Nodes ---
  findRoute(id) { return this.data.routes.find(route=>route.id===id)||null; }
  route(id) { const route=this.findRoute(id);if(!route)throw notFound();return route; }

  routeView(r) {
    // Shown as stored; a value the cleaner no longer accepts (an old record) shows as the field's default.
    const fields=Object.fromEntries(Object.entries(this.fields).map(([field,{clean,view}])=>{const read=view||clean;try{return [field,read(r[field])]}catch{return [field,read(undefined)]}}));
    return { id:r.id, alias:r.alias, name:r.name, enabled:r.enabled, upstreams:routeUpstreams(r), allowPrivate:r.allowPrivate, accessMode:r.accessMode||'key', authMigrationRequired:r.authMigrationRequired===true, ...fields, channels:channelList(r), reminderLastAt:r.reminderLastAt||null, createdAt:r.createdAt, updatedAt:r.updatedAt };
  }

  // The lines a client syncs for this node (see line-sync.js), shown in the node editor whether or not
  // the node shares them yet.
  previewLines(route) { return nodeLines(this.data,{...route,lineSync:true},{entryBase:steeringEntryBaseUrl(this.data,route),localBase:this.clientBaseUrl()}); }

  routes() {
    return this.data.routes.map(r=>({...this.routeView(r),syncLines:this.previewLines(r)})).sort((a,b)=>a.sortOrder-b.sortOrder||Number(b.favorite)-Number(a.favorite)||a.name.localeCompare(b.name));
  }

  exportRoutes() {
    return {version:1,exportedAt:new Date().toISOString(),routes:this.data.routes.map(r=>{const x=this.routeView(r);delete x.id;delete x.createdAt;delete x.updatedAt;return x})};
  }

  // A node deployed to a remote agent is distributed on that agent's own domain/IP, not the panel's, so
  // its shown client address must reflect that entry (falling back to the panel when served locally).
  // A steered node is handed out on the shared entry domain, which every participating machine serves.
  routeBaseUrl(route) { return steeringEntryBaseUrl(this.data,route)||routeEntryBaseUrl(this.data,route.id,this.clientBaseUrl()); }
  credentialsFor(route,accessKey) { return {...clientCredentials(route,accessKey),publicBaseUrl:this.routeBaseUrl(route)}; }

  // The node record shared by create and import. Callers validate the alias and upstreams and pick the key.
  buildRoute(input,{alias,upstreams,accessMode,accessKey,enabled}) {
    const now=new Date().toISOString();
    const fields=Object.fromEntries(Object.entries(this.fields).map(([field,{clean}])=>[field,clean(input[field])]));
    return {id:randomToken(12),alias,name:String(input.name||alias).slice(0,80),upstreams,allowPrivate:input.allowPrivate===true,enabled,accessMode,
      ...fields,...routeAuthFields(accessKey),createdAt:now,updatedAt:now};
  }

  async createRoute(input,actor) {
    const alias=checkedAlias(input.alias);if(this.data.routes.some(r=>r.alias===alias))throw fail(409,'alias already exists');
    const upstreams=await validateUpstreamList(input.upstreams||input.upstream,input.allowPrivate===true);
    const accessMode=input.accessMode==='alias_only'?'alias_only':'key',accessKey=accessMode==='key'?connectionKey(input.accessKey):'';
    const r=this.buildRoute(input,{alias,upstreams,accessMode,accessKey,enabled:true}),now=r.createdAt;
    // After the await: another request may have taken the alias meanwhile.
    if(this.data.routes.some(x=>x.alias===alias))throw fail(409,'alias already exists');
    this.data.routes.push(r);
    // Deploy the new node onto exactly the machine picked in the drawer, so its shown client address
    // uses that machine's domain (routeBaseUrl prefers the remote deployment). A panel machine used
    // only for management must not silently pick up every new node as well — that deployment would
    // have to be turned off by hand after every single create. The panel keeps serving the node when
    // no agent is picked, when the picked one is unknown, or when it has no usable entry host yet
    // (freshly enrolled, no domain/IP): without that fallback the address handed out would be dead.
    const deployAgentId=String(input.agentId||''),deployAgent=deployAgentId&&deployAgentId!==LOCAL_AGENT_ID?this.data.agents?.find(a=>a.id===deployAgentId):null;
    if(deployAgent)this.data.deployments.push({id:deploymentId(deployAgentId,r.id),agentId:deployAgentId,routeId:r.id,enabled:true,createdAt:now,updatedAt:now});
    if(!deployAgent||!agentEntryUrl(deployAgent))ensureLocalDeployment(this.data,r.id,now);
    this.commit('route.created',actor,alias);
    return {route:this.routeView(r),...this.credentialsFor(r,accessKey)};
  }

  async importRoutes(input,actor) {
    const items=Array.isArray(input.routes)?input.routes.slice(0,50):[],credentials=[],errors=[];
    for(const item of items){
      try{
        const alias=checkedAlias(item.alias);if(this.data.routes.some(r=>r.alias===alias))throw new Error('alias already exists');
        const upstreams=await validateUpstreamList(item.upstreams||item.upstream,item.allowPrivate===true),accessMode=item.accessMode==='alias_only'?'alias_only':'key',accessKey=accessMode==='key'?randomToken(24):'';
        const r=this.buildRoute(item,{alias,upstreams,accessMode,accessKey,enabled:item.enabled!==false});
        if(this.data.routes.some(x=>x.alias===alias))throw new Error('alias already exists');
        this.data.routes.push(r);ensureLocalDeployment(this.data,r.id,r.createdAt);credentials.push({alias,...this.credentialsFor(r,accessKey)});
      }catch(e){errors.push({alias:String(item?.alias||''),error:e.message})}
    }
    this.commit('routes.imported',actor,`${credentials.length} imported`);
    return {imported:credentials.length,credentials,errors};
  }

  async updateRoute(id,input,actor) {
    const r=this.route(id);
    // Work out and validate every change before touching the node. Fields used to be written as they were
    // read, so a request rejected half-way (an alias conflict, a blocked upstream) still left the earlier
    // ones applied in memory — unpublished, yet persisted by the next flush — including a freshly switched
    // access key the operator was never shown. Nothing is written until the request is known to succeed,
    // and the write itself has no await in it, so no other request can interleave with it.
    let mode=null,accessKey;
    if(input.accessMode!==undefined){const wanted=input.accessMode==='alias_only'?'alias_only':'key';if(wanted!==r.accessMode){mode=wanted;if(mode==='key')accessKey=connectionKey(input.accessKey);}}
    const fields={};
    if(input.name!==undefined)fields.name=String(input.name).slice(0,80);
    if(input.enabled!==undefined)fields.enabled=input.enabled===true;
    for(const [field,{clean,patch}] of Object.entries(this.fields))if(input[field]!==undefined)fields[field]=(patch||clean)(input[field]);
    const alias=input.alias===undefined?undefined:checkedAlias(input.alias);
    let allowPrivate=r.allowPrivate,upstreams;
    if(input.upstreams!==undefined||input.upstream!==undefined||input.allowPrivate!==undefined){allowPrivate=input.allowPrivate===undefined?r.allowPrivate:input.allowPrivate===true;upstreams=await validateUpstreamList(input.upstreams||input.upstream||routeUpstreams(r),allowPrivate);}
    // After the await: another request may have taken the alias meanwhile.
    if(alias!==undefined&&this.data.routes.some(x=>x!==r&&x.alias===alias))throw fail(409,'alias already exists');
    let switchedKey=null;
    if(mode==='alias_only'){r.accessMode='alias_only';r.keyDigest=null;r.accessKey=null;delete r.routeAuthKey;delete r.authVersion;delete r.authMigrationRequired;switchedKey='';}
    else if(mode==='key'){r.accessMode='key';Object.assign(r,routeAuthFields(accessKey));delete r.authMigrationRequired;switchedKey=accessKey;}
    Object.assign(r,fields);
    if(alias!==undefined)r.alias=alias;
    if(upstreams){r.allowPrivate=allowPrivate;r.upstreams=upstreams;delete r.upstream;}
    r.updatedAt=new Date().toISOString();
    this.commit(switchedKey===null?'route.updated':'route.access_mode_changed',actor,r.alias);
    return {route:this.routeView(r),...(switchedKey===null?{}:clientCredentials(r,switchedKey))};
  }

  deleteRoute(id,actor) {
    const r=this.route(id);
    this.data.routes=this.data.routes.filter(x=>x!==r);removeRouteDeployments(this.data,r.id);this.metrics?.drop(r.id);dropRouteRuntime(r.id);
    this.commit('route.deleted',actor,r.alias);
    return {ok:true};
  }

  routeCredentials(id,actor) {
    const r=this.route(id);
    this.store.audit('route.credentials_viewed',actor,r.alias);
    return {...savedCredentials(r),publicBaseUrl:this.routeBaseUrl(r)};
  }

  rotateRouteKey(id,input,actor) {
    const r=this.route(id);
    if(r.accessMode==='alias_only')throw fail(409,'this node does not use an access key');
    const accessKey=connectionKey(input.accessKey),routeAuthKey=r.authVersion===ROUTE_AUTH_VERSION&&isRouteAuthKey(r.routeAuthKey)?r.routeAuthKey:newRouteAuthKey();
    r.authVersion=ROUTE_AUTH_VERSION;r.routeAuthKey=routeAuthKey;r.keyDigest=routeTokenDigest(accessKey,routeAuthKey);r.accessKey=accessKey;delete r.authMigrationRequired;r.updatedAt=new Date().toISOString();
    this.commit('route.key_rotated',actor,r.alias);
    return this.credentialsFor(r,accessKey);
  }

  channels(id) { const r=this.route(id);return {channels:channelCredentials(r),publicBaseUrl:this.routeBaseUrl(r)}; }

  // Checked before the request body is read, as the HTTP API always has.
  assertChannelsOpen(id) {
    const r=this.route(id);
    if(r.accessMode!=='key')throw fail(409,'该节点未启用连接密码，无法添加分发通道；请先在编辑里开启连接密码');
    return r;
  }

  addChannel(id,input,actor) {
    const r=this.assertChannelsOpen(id);r.channels=Array.isArray(r.channels)?r.channels:[];
    if(r.channels.length>=32)throw fail(409,'一个节点最多 32 个分发通道');
    const channel=newChannel(input.label,input.accessKey);r.channels.push(channel);r.updatedAt=new Date().toISOString();
    this.commit('route.channel_added',actor,`${r.alias}:${channel.label}`);
    return {channel:{id:channel.id,label:channel.label,clientPath:`/${r.alias}/${channel.accessKey}/`},publicBaseUrl:this.routeBaseUrl(r)};
  }

  channel(id,cid) {
    const r=this.route(id);
    if(cid==='default')throw fail(409,'默认通道不能在此删除/改名，请用列表中的“密码”按钮');
    r.channels=Array.isArray(r.channels)?r.channels:[];const channel=r.channels.find(c=>c.id===cid);if(!channel)throw notFound('通道不存在');
    return {route:r,channel};
  }

  removeChannel(id,cid,actor) {
    const {route:r,channel}=this.channel(id,cid);
    r.channels=r.channels.filter(c=>c!==channel);r.updatedAt=new Date().toISOString();
    this.commit('route.channel_removed',actor,`${r.alias}:${channel.label}`);
    return {ok:true};
  }

  renameChannel(id,cid,input,actor) {
    const {route:r,channel}=this.channel(id,cid);
    channel.label=String(input.label||'').slice(0,40);r.updatedAt=new Date().toISOString();
    this.commit('route.channel_renamed',actor,`${r.alias}:${channel.label}`);
    return {ok:true,label:channel.label};
  }

  completeReminder(id,actor) {
    const r=this.route(id);
    r.reminderLastAt=new Date().toISOString();r.reminderNotifiedAt=null;
    this.commit('route.reminder_completed',actor,r.alias);
    return {ok:true,at:r.reminderLastAt};
  }

  // --- Machines ---
  findAgent(id) { return this.data.agents.find(agent=>agent.id===id)||null; }

  localDomainStatus() {
    const status=readDomainStatus(this.dataDir);if(!status)return null;
    if(status.state==='active'&&status.currentDomain&&status.currentDomain!==this.configuredLocalDomain)return {...status,state:'applying',message:'Nginx 已切换，面板服务正在重新载入配置'};
    return status;
  }

  agentView(agent) {
    const local=agent.id===LOCAL_AGENT_ID,view=publicAgent(agent,this.data,local?this.localAgent.status():null);
    if(!local)return {...view,domainChange:ongoingDomainChange(agent.domainStatus||null,agent.domain||''),automaticDomainSwitch:true};
    const domain=this.configuredLocalDomain||view.domain||'';
    return {...view,domain,domainChange:ongoingDomainChange(this.localDomainStatus(),domain),automaticDomainSwitch:true};
  }

  // Sort is stable, so machines that never got an explicit order keep their registration order.
  agents() { return this.data.agents.map(agent=>this.agentView(agent)).sort((a,b)=>a.sortOrder-b.sortOrder); }

  createEnrollment(input,actor) {
    const issued=issueEnrollment(this.data,{name:input.name,domain:input.domain,routeIds:input.routeIds});
    let command;
    try{command=enrollmentInstallCommand({publicBaseUrl:this.publicBaseUrl,token:issued.token,name:issued.record.name,domain:issued.record.domain,email:this.data.settings.certificateEmail});}
    catch(error){this.data.enrollmentTokens=this.data.enrollmentTokens.filter(item=>item!==issued.record);throw error;}
    this.commit('agent.enrollment_created',actor,issued.record.id);
    return {expiresAt:issued.record.expiresAt,command,uninstallCommand:'sudo aegis-relay-agent uninstall'};
  }

  updateAgent(id,input,actor) {
    const agent=this.findAgent(id);if(!agent)throw notFound('agent not found');
    const now=new Date().toISOString(),local=agent.id===LOCAL_AGENT_ID,localDomainRequested=local&&input.domain!==undefined;
    // Validate the whole request before changing anything (see updateRoute): a domain or route-list error
    // used to arrive after the name had changed, and a local domain switch could already have been filed.
    let name,domain,routeIds,switching=false;
    if(input.name!==undefined){name=String(input.name||'').trim();if(!name||name.length>80)throw fail(400,'invalid agent name');}
    if(input.domain!==undefined){
      domain=normalizeAgentDomain(input.domain);
      if(local){
        if(!domain)throw fail(400,'本机代理域名不能为空，请填写与面板不同的子域名');
        if(!this.publicBaseUrl.startsWith('https://'))throw fail(409,'请先在部署向导完成面板 HTTPS 配置');
        if(domain===baseHostname(this.publicBaseUrl))throw fail(409,'代理域名不能与面板域名相同');
        const existing=this.localDomainStatus();switching=!!existing&&['pending','applying'].includes(existing.state);
        if(switching&&existing.desiredDomain!==domain)throw fail(409,`正在切换到 ${existing.desiredDomain}，完成后再提交新域名`);
      }else if(domain&&!this.data.settings.certificateEmail)throw fail(409,'请先在部署向导保存统一证书邮箱');
    }
    if(input.routeIds!==undefined){
      if(!Array.isArray(input.routeIds))throw fail(400,'routeIds must be an array');
      routeIds=[...new Set(input.routeIds.map(String))];
      if(routeIds.some(routeId=>!this.data.routes.some(route=>route.id===routeId)))throw fail(400,'unknown route id');
    }
    // Apply. The local domain switch goes first: it is the one step that can still fail, and it checks its
    // input before writing anything.
    if(domain!==undefined){
      if(local){
        if(domain!==this.configuredLocalDomain&&!switching)requestDomainSwitch({dir:this.dataDir,domain,email:this.data.settings.certificateEmail,currentDomain:this.configuredLocalDomain});
        else if(domain===this.configuredLocalDomain)agent.domain=domain;
      }else{
        const currentMode=agent.proxyMode||(agent.domain?'domain':'ip');
        if(domain){if(currentMode!=='domain'||domain!==agent.domain){agent.desiredMode='domain';agent.desiredDomain=domain;agent.domainStatus={requestId:'',state:'pending',mode:'domain',desiredDomain:domain,currentDomain:agent.domain||'',message:'等待机器申请证书并切换 Nginx',updatedAt:new Date().toISOString()};}}
        else if(currentMode!=='ip'){agent.desiredMode='ip';delete agent.desiredDomain;agent.domainStatus={requestId:'',state:'pending',mode:'ip',desiredDomain:'',currentDomain:agent.domain||'',message:'等待机器切换为 IP 反代（HTTP）',updatedAt:new Date().toISOString()};}
      }
    }
    if(name!==undefined)agent.name=name;
    if(routeIds)replaceAgentDeployments(this.data,agent.id,routeIds,now);
    if(input.sortOrder!==undefined)agent.sortOrder=numeric(input.sortOrder,-10000,10000);
    if(input.steerTarget!==undefined)agent.steerTarget=input.steerTarget===true;
    agent.updatedAt=now;
    this.commit(localDomainRequested?'agent.local_domain_requested':'agent.updated',actor,agent.id);
    return {agent:this.agentView(agent)};
  }

  deleteAgent(id,actor) {
    const agent=this.findAgent(id);if(!agent)throw notFound('agent not found');
    if(agent.id===LOCAL_AGENT_ID)throw fail(409,'the local agent cannot be deleted');
    this.data.agents=this.data.agents.filter(item=>item!==agent);this.data.deployments=this.data.deployments.filter(item=>item.agentId!==agent.id);
    this.commit('agent.deleted',actor,agent.id);
    return {ok:true};
  }

  // --- Settings ---
  updateCertificateEmail(input,actor) {
    this.data.settings.certificateEmail=normalizeCertificateEmail(input.certificateEmail);
    this.commit('deployment.certificate_email_updated',actor);
    return {ok:true,certificateEmail:this.data.settings.certificateEmail};
  }

  // What the 自动切流 page needs: settings, per-machine/per-node readiness, the entry-domain command each
  // machine has to run once, and the live view from the hub.
  steering() {
    const data=this.data,settings=steeringSettings(data),agents=this.agents();
    const machines=data.agents.filter(agent=>agent.state!=='revoked').map(agent=>{const view=agents.find(item=>item.id===agent.id)||{};return{id:agent.id,name:agent.name||agent.id,domain:view.domain||agent.domain||'',local:agent.id===LOCAL_AGENT_ID,status:view.status,agentVersion:view.agentVersion||'',steerTarget:agent.steerTarget!==false,issues:agentSteeringIssues({...agent,domain:view.domain||agent.domain},settings)}});
    const email=data.settings.certificateEmail||'',entryCommands=[];
    // Machines that know entry-v1 (and the panel itself) set the entry domain up on their own; the command
    // stays available for older agents and for re-running by hand.
    for(const machine of machines){
      const agent=data.agents.find(item=>item.id===machine.id),entry=desiredEntry(data,machine.id);
      if(!entry)continue;
      const status=machine.local?readEntryStatus(this.dataDir):agent.entryStatus||null,current=!!status&&status.entryDomain===entry.domain&&status.peers.join(' ')===entry.peers.join(' ');
      entryCommands.push({id:machine.id,name:machine.name,command:entryCommand(entry,machine.local),auto:agentKnows(agent,ENTRY_CAPABILITY),state:current?status.state:'waiting',message:current?status.message:'',attempt:current?status.attempt:0,updatedAt:current?status.updatedAt:''});
    }
    const routes=data.routes.map(route=>{const issues=routeSteeringIssues(data,route,settings),gaps=settings.entryDomain&&!issues.length?entryCoverageGaps(data,route,settings):[];return{id:route.id,alias:route.alias,name:route.name,enabled:route.autoSteer?.enabled===true,issues,entryGaps:gaps.map(agent=>agent.name||agent.id),entryAddress:!!steeringEntryBaseUrl(data,route),egressAgentId:route.egressAgentId||'',egressIssues:egressIssues(data,route),egressActive:!!egressTopology(data,route)}});
    return {settings:{mode:settings.mode,entryDomain:settings.entryDomain,excludedClients:settings.excludedClients,autoExcluded:settings.autoExcluded,boundedClients:settings.boundedClients,boundAuto:settings.boundAuto,autoBounded:settings.autoBounded,autoUnbounded:settings.autoUnbounded,boundMB:settings.boundMB},certificateEmail:email,machines,routes,entryCommands,live:this.steeringHub?.view()||null};
  }

  updateSteering(input,actor) {
    // Validate everything before writing (see updateRoute).
    if(input.mode!==undefined&&!STEERING_MODES.includes(input.mode))throw fail(400,'invalid steering mode');
    const entry=input.entryDomain===undefined?undefined:normalizeEntryDomain(input.entryDomain);
    if(entry&&entry===baseHostname(this.publicBaseUrl))throw fail(409,'入口域名不能与面板域名相同');
    const settings=steeringSettings(this.data);
    if(input.mode!==undefined)settings.mode=input.mode;
    if(entry!==undefined)settings.entryDomain=entry;
    if(input.excludedClients!==undefined)settings.excludedClients=normalizeClientList(input.excludedClients);
    if(input.boundedClients!==undefined)settings.boundedClients=normalizeClientList(input.boundedClients);
    if(input.boundMB!==undefined)settings.boundMB=Math.round(numeric(input.boundMB,8,1024));
    if(input.clearAutoExcluded===true)settings.autoExcluded={};
    if(input.boundAuto!==undefined)settings.boundAuto=input.boundAuto===true;
    if(input.clearRangeAuto===true){settings.autoBounded={};settings.autoUnbounded={};this.steeringHub?.clearRangeVerdicts();}
    this.commit('steering.updated',actor,settings.mode);
    return this.steering();
  }
}
