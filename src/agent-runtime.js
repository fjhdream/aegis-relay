import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { b64u, randomToken, timingEqual } from './security.js';
import { agentRequestInput, panelResponseInput } from './agent-api.js';
import { openAgentSnapshot } from './agent-config.js';
import { openLocal, sealLocal, SnapshotFollower } from './snapshot-follower.js';
import { coalescedWriter, writeAtomic } from './store.js';
import { createRelayServer } from './proxy.js';
import { activeUpstreamLine } from './upstream-exchange.js';
import { EGRESS_CAPABILITY, SteeringEngine, STEERING_CAPABILITY } from './steering.js';
import { PLAYBACK_OBSERVATION_CAPABILITY } from './playback-observation.js';
import { cleanEntryRequest, ENTRY_CAPABILITY } from './steering-topology.js';
// The same host request files as the panel machine: domain status and the steering entry domain.
import { followDomain, followEntry, forgetDomainSwitch, readDomainStatus, readEntryStatus, servingAddress } from './domain-control.js';
import { LINE_SYNC_CAPABILITY } from './line-sync.js';
import { Metrics } from './metrics.js';
import { telemetryFromMetrics } from './telemetry.js';

// An agent (探针, see GLOSSARY.md): a machine other than the panel's that enrolls with the panel once,
// then follows its desired snapshot over a signed long poll, serves the nodes in it, and reports back
// on a heartbeat. This module is the whole of that machine's life; agent-main.js only reads the
// environment and starts it. What varies between a real agent and a test is passed in: `fetch` reaches
// the panel, `sleep(ms, signal)` waits between attempts, `now()` is the clock.

// config-longpoll-v1 tells the panel this agent follows config over a long poll, so it can relax the
// heartbeat it hands back; older agents still learn about changes from the heartbeat alone.
// steering-v1: this machine runs the steering engine and can be a steering target.
// entry-v1: it sets up the steering entry domain itself when the panel asks (no command to run by hand).
// egress-v1: it relays a node's upstream traffic through the node's egress machine (see proxy.js).
// line-sync-v1: it answers a client's line request for a node with the node's lines (see line-sync.js).
const CAPABILITIES=['registry-v1','config-v1','proxy-v1','telemetry-v1','config-longpoll-v1',STEERING_CAPABILITY,ENTRY_CAPABILITY,EGRESS_CAPABILITY,PLAYBACK_OBSERVATION_CAPABILITY,LINE_SYNC_CAPABILITY];
const sha256=value=>b64u(crypto.createHash('sha256').update(value).digest());
// Resolves early when the agent is stopped.
const timerSleep=(ms,signal)=>new Promise(resolve=>{
  if(signal?.aborted)return resolve();
  const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',done);resolve()},timer=setTimeout(done,ms);
  signal?.addEventListener('abort',done,{once:true});
});

function cleanPanel(value){const url=new URL(String(value||''));if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('PANEL_URL must be an HTTPS origin');return url.origin;}
// Everything an agent keeps lives in its data directory.
const agentFiles=dataDir=>({identity:path.join(dataDir,'identity.json'),current:path.join(dataDir,'current.snapshot'),previous:path.join(dataDir,'previous.snapshot'),metrics:path.join(dataDir,'metrics.enc')});
function publicDer(key){return b64u(key.export({format:'der',type:'spki'}));}
function privateDer(key){return b64u(key.export({format:'der',type:'pkcs8'}));}
function signPrivateKey(identity){return crypto.createPrivateKey({key:Buffer.from(identity.signPrivateKey,'base64url'),format:'der',type:'pkcs8'});}
function panelPublicKey(identity){return crypto.createPublicKey({key:Buffer.from(identity.panelSigningPublicKey,'base64url'),format:'der',type:'spki'});}
function storageKey(identity){const key=Buffer.from(identity.agentStorageKey||'','base64url');if(key.length!==32)throw new Error('invalid agent storage key');return key;}

function newIdentity(){const sign=crypto.generateKeyPairSync('ed25519'),box=crypto.generateKeyPairSync('x25519');return{signPublicKey:publicDer(sign.publicKey),signPrivateKey:privateDer(sign.privateKey),boxPublicKey:publicDer(box.publicKey),boxPrivateKey:privateDer(box.privateKey),agentStorageKey:randomToken(32)}}
function loadIdentity(file){const identity=JSON.parse(fs.readFileSync(file,'utf8'));if(!identity.agentStorageKey){identity.agentStorageKey=randomToken(32);writeAtomic(file,JSON.stringify(identity));}storageKey(identity);return identity;}

// Every answer the panel gives is signed over the nonce of the request it answers.
function verifyResponse(response,raw,identity,nonce,now){const timestamp=Number(response.headers.get('x-aegis-timestamp')),contentHash=response.headers.get('x-aegis-content-sha256')||'',signature=response.headers.get('x-aegis-signature')||'',keyId=response.headers.get('x-aegis-panel-key-id')||'';if(!Number.isSafeInteger(timestamp)||Math.abs(Math.floor(now()/1000)-timestamp)>300||!timingEqual(contentHash,sha256(raw))||!timingEqual(keyId,identity.panelKeyId))throw new Error('panel response identity rejected');const input=panelResponseInput({status:response.status,requestNonce:nonce,timestamp,contentHash});if(!crypto.verify(null,Buffer.from(input),panelPublicKey(identity),Buffer.from(signature,'base64url')))throw new Error('panel response signature rejected');}

// Register this machine with the panel, or keep the identity it already has. Returns
// {agentId, registered}: `registered` is false when the existing identity was kept.
export async function enrollAgent({dataDir,panelUrl,token='',name='',version='0.0.0',fetch=globalThis.fetch,now=Date.now}){
  const panel=cleanPanel(panelUrl),files=agentFiles(dataDir);
  fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
  const alreadyEnrolled=fs.existsSync(files.identity),kept=()=>({agentId:JSON.parse(fs.readFileSync(files.identity,'utf8')).agentId,registered:false});
  token=String(token||'');
  // Enrollment is driven by the token, not merely by whether an identity file exists. A fresh valid
  // token is explicit intent to (re-)register THIS machine, so it must go through even when a stale
  // identity is left over from an earlier install — otherwise a reinstall silently keeps the old,
  // panel-unknown identity and the agent never appears / can't sync (502s). Without a token there is
  // nothing to do but keep what is already there.
  if(!token){
    if(alreadyEnrolled){console.log('AegisRelay Agent 已注册，且未提供注册令牌，保留现有身份。');return kept();}
    throw new Error('ENROLLMENT_TOKEN is required');
  }
  const identity=newIdentity(),requestNonce=randomToken(16),payload={protocolVersion:1,requestNonce,token,agent:{name:String(name||os.hostname()).slice(0,80),signPublicKey:identity.signPublicKey,boxPublicKey:identity.boxPublicKey,agentVersion:version,capabilities:CAPABILITIES},machine:{hostname:os.hostname().slice(0,80),architecture:process.arch,platform:process.platform}};
  const response=await fetch(`${panel}/api/agent/v1/enroll`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)}),raw=Buffer.from(await response.arrayBuffer()),result=JSON.parse(raw.toString('utf8'));
  if(!response.ok){
    // A spent/expired token on an already-enrolled machine is just an accidental re-run of the same
    // install command — keep the working identity instead of aborting the installer with a stack
    // trace. A failed first-time enrollment is a real error.
    if(alreadyEnrolled){console.log(`注册令牌无效或已使用（${String(result.error||response.status)}）；本机已注册，保留现有身份。如需重新注册，请在面板重新生成安装命令。`);return kept();}
    throw new Error(result.error||`enrollment failed (${response.status})`);
  }
  const pinned={...identity,agentId:result.agentId,panelKeyId:result.panelKeyId,panelSigningPublicKey:result.panelSigningPublicKey,panelUrl:panel,enrolledAt:new Date(now()).toISOString()};verifyResponse(response,raw,pinned,requestNonce,now);
  // A re-enrollment replaces the machine's identity; the cached snapshot and metrics were sealed with
  // the old storage key and are unreadable now, and a leftover host-domain status would make the agent
  // keep reporting the previous life's domain — drop them all so the agent re-syncs and reports the
  // freshly configured domain.
  if(alreadyEnrolled){for(const file of [files.current,files.previous,files.metrics]){try{fs.rmSync(file,{force:true});}catch{}}forgetDomainSwitch(dataDir);}
  writeAtomic(files.identity,JSON.stringify(pinned));console.log(`AegisRelay Agent registered: ${result.agentId}`);
  return {agentId:result.agentId,registered:true};
}

function loadMetricStore(file,key){let data={};if(fs.existsSync(file)){try{const loaded=openLocal(fs.readFileSync(file,'utf8'),key);if(loaded&&typeof loaded==='object'&&!Array.isArray(loaded))data=loaded}catch(error){console.error(`[aegis-agent] cached metrics rejected: ${error.message}`)}}const writer=coalescedWriter(file,()=>sealLocal(data,key));return{data,save:writer.save}}

// Config follows a long poll that the panel releases the moment this machine's node set changes, so a
// change lands within about a second instead of on the next heartbeat. A panel that predates long
// polling answers 204 at once; the floor keeps that, and wake-ups for other machines' changes, from
// turning into a busy loop.
const CONFIG_WAIT_SECONDS=25,CONFIG_POLL_FLOOR_MS=5_000;

// Run an enrolled machine: serve from the snapshot it cached, then follow the panel. Resolves once the
// relay is listening, with {agentId, port, stop()}. The agent never stops relaying because the panel
// is unreachable; stop() ends the loops, saves the metrics and closes the relay.
//   domain, proxyMode, proxyIp   what the machine was installed with (the host may have switched it
//                                since, see domain-control.js)
export async function startAgent({dataDir,panelUrl,domain='',proxyMode='',proxyIp='',proxyPort=8080,proxyHost='0.0.0.0',version='0.0.0',fetch=globalThis.fetch,sleep=timerSleep,now=Date.now}){
  const panel=cleanPanel(panelUrl),files=agentFiles(dataDir),identity=loadIdentity(files.identity);
  if(identity.panelUrl!==panel)throw new Error('pinned panel URL mismatch');
  const key=storageKey(identity),installed={mode:String(proxyMode||'').trim().toLowerCase(),domain:String(domain||'').trim(),ip:String(proxyIp||'').trim()};
  const stopping=new AbortController(),stopped=stopping.signal;
  const report=error=>console.error(`[aegis-agent] ${String(error?.message||error).slice(0,160)}`);

  const follower=new SnapshotFollower({cacheFile:files.current,previousFile:files.previous,storageKey:key,panelIdentity:{algorithm:'Ed25519',keyId:identity.panelKeyId,publicKey:identity.panelSigningPublicKey}});
  const cacheRejected=!follower.load()&&follower.applyState==='error',routes=()=>follower.routeSource.getRoutes();
  // What the heartbeat reports: 'active' once any snapshot is applied, whatever happened since.
  const applyState=()=>follower.revision?'active':cacheRejected?'error':'waiting';

  async function signedRequest(method,pathAndQuery,payload=null,timeoutMs=0){
    const body=payload===null?Buffer.alloc(0):Buffer.from(JSON.stringify(payload)),timestamp=Math.floor(now()/1000),nonce=randomToken(16),contentHash=sha256(body);
    const signature=b64u(crypto.sign(null,Buffer.from(agentRequestInput({method,path:pathAndQuery,agentId:identity.agentId,timestamp,nonce,contentHash})),signPrivateKey(identity))),headers={'x-aegis-agent-id':identity.agentId,'x-aegis-timestamp':String(timestamp),'x-aegis-nonce':nonce,'x-aegis-content-sha256':contentHash,'x-aegis-signature':signature};
    if(payload!==null)headers['content-type']='application/json';
    const options={method,headers,signal:timeoutMs?AbortSignal.any([stopped,AbortSignal.timeout(timeoutMs)]):stopped};if(method!=='GET'&&payload!==null)options.body=body;
    const response=await fetch(`${panel}${pathAndQuery}`,options),raw=Buffer.from(await response.arrayBuffer());verifyResponse(response,raw,identity,nonce,now);return{response,raw,data:raw.length?JSON.parse(raw.toString('utf8')):null};
  }

  const metricStore=loadMetricStore(files.metrics,key),metrics=new Metrics(metricStore);
  const steering=new SteeringEngine({selfId:identity.agentId,lineOf:activeUpstreamLine,canServe:route=>metrics.canServe(route)});
  const server=createRelayServer({routeSource:follower.routeSource,key,metrics,steering,label:'aegis-agent'});
  let proxyHealthy=true;
  await new Promise((resolve,reject)=>{let started=false;server.on('error',error=>{if(!started)return reject(error);proxyHealthy=false;console.error(`[aegis-agent] proxy server error: ${error?.message||error}`)});server.on('close',()=>{proxyHealthy=false});server.listen(proxyPort,proxyHost,()=>{started=true;resolve()})});
  const healthy=()=>proxyHealthy&&server.listening,startedAt=now(),bootId=randomToken(16);

  async function acknowledge(revision,hash,status,error=''){const result=await signedRequest('POST','/api/agent/v1/ack',{protocolVersion:1,revision,hash,status,error:String(error||'').slice(0,240),proxyHealthy:healthy()});if(!result.response.ok)throw new Error(result.data?.error||`ack failed (${result.response.status})`);}

  // True when a snapshot arrived and was applied; a refused one is reported to the panel and thrown.
  async function pollConfig(wait){
    const result=await signedRequest('GET',`/api/agent/v1/config?after=${follower.revision}&wait=${wait}`,null,wait?(wait+20)*1000:0);
    if(result.response.status===204)return false;
    if(!result.response.ok)throw new Error(result.data?.error||`config poll failed (${result.response.status})`);
    const snapshot=openAgentSnapshot({envelope:result.data,identity}),accepted=follower.accept(snapshot);
    if(accepted.ok){await acknowledge(accepted.revision,accepted.hash,'applied');return true;}
    try{await acknowledge(snapshot.revision,snapshot.hash,'rejected',accepted.error)}catch{}
    throw new Error(accepted.error);
  }

  async function followConfig(){
    let backoff=0;
    while(!stopped.aborted){
      const started=now();let pause;
      try{const applied=await pollConfig(CONFIG_WAIT_SECONDS);backoff=0;pause=applied?0:CONFIG_POLL_FLOOR_MS-(now()-started)}
      catch(error){if(stopped.aborted)return;report(error);backoff=Math.min(60_000,Math.max(2_000,backoff*2));pause=backoff}
      if(pause>0)await sleep(pause,stopped);
    }
  }

  async function checkIn(telemetry){
    const serving=servingAddress({dir:dataDir,installed}),payload={protocolVersion:1,agentVersion:version,bootId,uptimeSeconds:Math.floor((now()-startedAt)/1000),currentRevision:follower.revision,currentConfigId:follower.hash,applyState:applyState(),proxyHealthy:healthy(),domain:serving.domain,proxyMode:serving.mode,domainStatus:readDomainStatus(dataDir),entryStatus:readEntryStatus(dataDir),certificateNotAfter:null,capabilities:CAPABILITIES,telemetry};
    const result=await signedRequest('POST','/api/agent/v1/check-in',payload);
    if(!result.response.ok)throw new Error(result.data?.error||`check-in failed (${result.response.status})`);
    return result.data;
  }

  // The heartbeat carries health and telemetry up, and brings down what the panel wants of the host:
  // the domain or IP to serve on and the steering entry domain.
  async function heartbeat(){
    let delay=2_000,lastMetricSave=0;
    while(!stopped.aborted){
      try{
        const telemetry=telemetryFromMetrics(metrics.snapshot(routes()));
        if(now()-lastMetricSave>=60_000){metricStore.save();lastMetricSave=now()}
        const status=await checkIn(telemetry);
        followDomain({dir:dataDir,desired:{mode:status.desiredMode,domain:status.desiredDomain,email:status.certificateEmail},installed,nowMs:now()});
        if(status.entry)followEntry({dir:dataDir,entry:cleanEntryRequest(status.entry),nowMs:now()});
        delay=Math.max(5_000,Number(status.heartbeatSeconds||15)*1000);
      }catch(error){if(stopped.aborted)return;report(error);delay=Math.min(300_000,Math.max(2_000,delay*2))}
      await sleep(delay,stopped);
    }
  }

  steering.start(async payload=>{const result=await signedRequest('POST','/api/agent/v1/steering',payload,20_000);if(!result.response.ok)throw new Error(result.data?.error||`steering sync failed (${result.response.status})`);return result.data;},routes);
  const loops=[followConfig(),heartbeat()].map(loop=>loop.catch(report));

  return {
    agentId:identity.agentId,port:server.address().port,
    async stop(){
      stopping.abort();steering.stop();
      const saved=metricStore.save(),closed=new Promise(resolve=>server.close(resolve));server.closeIdleConnections?.();
      await Promise.all([saved,closed,...loops]);
    }
  };
}
