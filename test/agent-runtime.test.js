import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AgentApi, issueEnrollment } from '../src/agent-api.js';
import { replaceAgentDeployments } from '../src/agent-registry.js';
import { enrollAgent, startAgent } from '../src/agent-runtime.js';
import { DesiredSnapshots } from '../src/desired-snapshots.js';
import { DOMAIN_REQUEST_FILE, readDomainStatus } from '../src/domain-control.js';
import { openLocal } from '../src/snapshot-follower.js';

// The real agent against the real panel API, in one process. The panel's agent API listens on a
// loopback port; the agent is handed a fetch that reaches it under the HTTPS origin the agent pinned,
// and a sleep the test releases by hand, so a test decides when the next attempt happens and sees how
// long the agent meant to wait.

const ORIGIN='https://panel.test',HEARTBEAT_MS=30_000;
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const close=server=>new Promise(resolve=>{server.closeAllConnections?.();server.close(resolve)});
const get=(port,urlPath)=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path:urlPath,agent:false},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}))});req.on('error',reject);req.end()});
async function until(check,what){const deadline=Date.now()+8_000;for(;;){const value=await check();if(value)return value;if(Date.now()>deadline)assert.fail(`timed out waiting for ${what}`);await new Promise(resolve=>setTimeout(resolve,5));}}

// What the agent is waiting on right now. next(match) resolves with the first pending wait whose
// length matches, once there is one; release() ends that wait.
function handSleep(){
  const pending=[];
  const sleep=(ms,signal)=>new Promise(resolve=>{
    const entry={ms,release(){const at=pending.indexOf(entry);if(at>=0)pending.splice(at,1);resolve()}};
    if(signal?.aborted)return resolve();
    pending.push(entry);signal?.addEventListener('abort',entry.release,{once:true});
  });
  const next=(match,what)=>until(()=>pending.find(entry=>match(entry.ms,entry)),what);
  return {sleep,next,pending};
}
const heartbeatWait=ms=>ms===HEARTBEAT_MS,otherWait=ms=>ms!==HEARTBEAT_MS;
// The n-th wait of a backoff: 2s doubled n-1 times, held to the cap, a quarter shorter to a quarter
// longer and never over the cap.
const backoffWait=(ms,n,cap)=>{const nominal=Math.min(cap,2_000*2**(n-1));return ms>=nominal*0.75&&ms<=Math.min(cap,nominal*1.25)};
// Release wait after wait of one loop and return how long each was; the last one is left pending.
async function waitsOf(sleeps,match,count){const seen=[];for(let i=0;i<count;i++){const wait=await sleeps.next(match,`wait ${i+1}`);seen.push(wait.ms);if(i<count-1)wait.release()}return seen}
const assertBackoff=(seen,cap,what)=>seen.forEach((ms,i)=>assert.ok(backoffWait(ms,i+1,cap),`${what}: wait ${i+1} was ${ms}ms`));

// A panel with one node deployed to whoever enrolls, an Emby stand-in behind it, and the machines the
// test starts. Everything is torn down in order when the test ends.
async function world(t){
  const logs=[],original={log:console.log,error:console.error};
  console.log=(...args)=>logs.push(args.map(String).join(' '));console.error=console.log;
  const emby=http.createServer((req,res)=>res.end(`emby:${req.url}`)),upstream=await listen(emby);
  const node=alias=>({id:`node-${alias}`,alias,name:alias,enabled:true,upstreams:[`http://127.0.0.1:${upstream}`],allowPrivate:true,accessMode:'alias_only'});
  const audits=[],data={routes:[node('movies')],agents:[],deployments:[],enrollmentTokens:[],controlPlane:{},settings:{certificateEmail:'ops@example.com'}};
  const store={data,save(){},audit(event,_actor,detail){audits.push(`${event} ${detail}`)}};
  const snapshots=new DesiredSnapshots({store}),api=new AgentApi({store,version:'9.9.9',snapshots});
  const requests=[],server=http.createServer((req,res)=>{requests.push(`${req.method} ${req.url.split('?')[0].replace('/api/agent/v1/','')}`);api.handle(req,res)}),port=await listen(server);
  const panel={data,api,audits,requests,port,unreachable:()=>false,tamper:null,
    count:name=>requests.filter(item=>item===name).length,
    token:(options={})=>issueEnrollment(data,{name:'HK 01',domain:'hk.example.com',routeIds:['node-movies'],...options}).token,
    // Deploy exactly these nodes to the machine, as the panel does after an operator's change.
    deploy(agentId,aliases){for(const alias of aliases)if(!data.routes.some(route=>route.alias===alias))data.routes.push(node(alias));replaceAgentDeployments(data,agentId,aliases.map(alias=>`node-${alias}`));snapshots.refresh();},
    applied:(agentId,revision)=>audits.filter(item=>item===`agent.config_applied ${agentId} revision ${revision}`).length,
    async fetch(url,options){
      const pathname=new URL(url).pathname;
      if(panel.unreachable(pathname))throw new TypeError('fetch failed');
      const response=await fetch(String(url).replace(ORIGIN,`http://127.0.0.1:${port}`),options);
      return panel.tamper?panel.tamper(pathname,response):response;
    }};
  const dirs=[],agents=[];
  const dataDir=()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-agent-'));dirs.push(dir);return dir};
  const start=async(dir,options={})=>{const sleeps=handSleep(),agent=await startAgent({dataDir:dir,panelUrl:ORIGIN,domain:'hk.example.com',proxyPort:0,proxyHost:'127.0.0.1',version:'1.2.3',fetch:panel.fetch,sleep:sleeps.sleep,...options});agents.push(agent);return {agent,sleeps}};
  t.after(async()=>{
    for(const agent of agents)await agent.stop();
    api.close();await close(server);await close(emby);
    for(const dir of dirs)fs.rmSync(dir,{recursive:true,force:true});
    console.log=original.log;console.error=original.error;
  });
  return {panel,logs,dataDir,start,enroll:(dir,options={})=>enrollAgent({dataDir:dir,panelUrl:ORIGIN,version:'1.2.3',fetch:panel.fetch,...options})};
}

// An enrolled agent that has applied its first snapshot and finished a heartbeat reporting it.
async function runningAgent(t,options={}){
  const w=await world(t),dir=w.dataDir(),{agentId}=await w.enroll(dir,{token:w.panel.token()}),{agent,sleeps}=await w.start(dir,options);
  const record=w.panel.data.agents.find(item=>item.id===agentId);
  // One heartbeat: let the agent's current wait end and see the next check-in through.
  const beat=async()=>{const before=w.panel.count('POST check-in');(await sleeps.next(heartbeatWait,'the heartbeat wait')).release();await until(()=>w.panel.count('POST check-in')>before,'the next check-in');await sleeps.next(heartbeatWait,'the wait after the check-in');};
  await until(()=>w.panel.applied(agentId,1),'the first snapshot to be applied');
  await beat();
  return {...w,dir,agent,agentId,record,sleeps,beat};
}

test('an agent enrolls, serves the nodes deployed to it, and reports what it runs',async t=>{
  const w=await world(t),dir=w.dataDir();
  const enrolled=await w.enroll(dir,{token:w.panel.token(),name:'the hostname is not the name'});
  const record=w.panel.data.agents[0];
  assert.deepEqual([enrolled.registered,enrolled.agentId],[true,record.id]);
  assert.deepEqual([record.name,record.agentVersion,record.machine.platform],['HK 01','1.2.3',process.platform],'the name comes with the token');
  assert.ok(record.capabilities.includes('config-longpoll-v1')&&record.capabilities.includes('steering-v1'));
  assert.equal(fs.statSync(path.join(dir,'identity.json')).mode&0o777,0o600);
  assert.ok(w.logs.includes(`AegisRelay Agent registered: ${record.id}`));

  const {agent,sleeps}=await w.start(dir);
  assert.equal(agent.agentId,record.id);
  await until(()=>w.panel.applied(record.id,1),'the first snapshot to be applied');
  assert.deepEqual(await get(agent.port,'/movies/System/Info'),{status:200,body:'emby:/System/Info'});
  // Let one more heartbeat through, so what it reports is from after the snapshot was applied.
  (await sleeps.next(heartbeatWait,'the first heartbeat wait')).release();
  await until(()=>w.panel.count('POST check-in')>=2,'the second check-in');
  const wait=await sleeps.next(heartbeatWait,'the wait the panel asked for');
  assert.equal(wait.ms,30_000,'an agent on the long poll is handed the relaxed beat');
  assert.deepEqual([record.applyState,record.appliedRevision,record.desiredRevision,record.proxyHealthy,record.reportedDomain,record.proxyMode,record.lastAck.status],['active',1,1,true,'hk.example.com','domain','applied']);
  assert.ok(record.lastSeen&&record.telemetry,'health and telemetry ride the heartbeat');
  assert.equal(w.panel.applied(record.id,1),1,'one snapshot, one acknowledgement');
});

test('a node change reaches the agent over the long poll, not on the next heartbeat',async t=>{
  const {panel,agent,agentId,record}=await runningAgent(t),heartbeats=panel.count('POST check-in');
  panel.deploy(agentId,['movies','shows']);
  await until(()=>panel.applied(agentId,2),'the second snapshot to be applied');
  assert.deepEqual(await get(agent.port,'/shows/Items'),{status:200,body:'emby:/Items'});
  panel.deploy(agentId,['shows']);
  await until(()=>panel.applied(agentId,3),'the third snapshot to be applied');
  assert.equal((await get(agent.port,'/movies/System/Info')).status,404,'a node taken off the machine stops being served');
  assert.equal((await get(agent.port,'/shows/Items')).status,200);
  assert.equal(panel.count('POST check-in'),heartbeats,'no heartbeat was needed');
  assert.deepEqual([record.appliedRevision,panel.applied(agentId,2),panel.applied(agentId,3)],[3,1,1],'each snapshot is fetched and acknowledged once');
});

test('a wake-up that brings nothing new waits out the poll floor instead of spinning',async t=>{
  const {panel,agentId,sleeps}=await runningAgent(t);
  // A snapshot has just been applied, so the poll that is parked now started a moment ago.
  panel.deploy(agentId,['movies','shows']);
  await until(()=>panel.applied(agentId,2),'the second snapshot to be applied');
  const polls=await until(()=>panel.count('GET config')>=3&&panel.count('GET config'),'the poll after it');
  // The panel answers 204 at once: a wake-up for nothing, or a panel older than the long poll.
  panel.api.wake([agentId]);
  const floor=await sleeps.next(otherWait,'the wait after an empty answer');
  assert.ok(floor.ms>4_000&&floor.ms<=5_000,`waits the rest of five seconds, got ${floor.ms}`);
  assert.equal(panel.count('GET config'),polls,'and does not ask again meanwhile');
  floor.release();
  await until(()=>panel.count('GET config')===polls+1,'the next poll');
});

test('the heartbeat brings down the domain the panel wants, and reports how the host got on',async t=>{
  const {panel,dir,record,beat}=await runningAgent(t),requestFile=path.join(dir,DOMAIN_REQUEST_FILE),statusFile=path.join(dir,'host-domain-status.json');
  const request=()=>{try{return JSON.parse(fs.readFileSync(requestFile,'utf8'))}catch{return null}};
  assert.equal(request(),null,'nothing to ask the host while the panel wants nothing changed');
  // The operator sets a steering entry domain: every machine that can be a target sets it up itself.
  const entryFile=path.join(dir,'host-entry-request.json');
  panel.data.settings.steering={entryDomain:'entry.example.com'};
  await beat();
  const entry=JSON.parse(fs.readFileSync(entryFile,'utf8'));
  assert.deepEqual([entry.entryDomain,entry.certificateEmail,entry.peers],['entry.example.com','ops@example.com',[]]);
  await beat();
  assert.deepEqual([record.entryStatus.state,record.entryStatus.entryDomain],['pending','entry.example.com'],'and the panel hears how far the host has got');
  fs.rmSync(entryFile);
  // The operator gives the machine another domain (panel.js sets exactly these).
  record.desiredMode='domain';record.desiredDomain='jp.example.com';
  await beat();
  assert.deepEqual([request().mode,request().desiredDomain,request().certificateEmail],['domain','jp.example.com','ops@example.com']);
  await beat();
  assert.deepEqual([record.domainStatus.state,record.domainStatus.desiredDomain,record.domain],['pending','jp.example.com','hk.example.com'],'the panel sees the switch is under way');
  // The host unit finishes the switch.
  fs.rmSync(requestFile);fs.writeFileSync(statusFile,JSON.stringify({...readDomainStatus(dir),state:'active',currentDomain:'jp.example.com'}));
  await beat();
  assert.deepEqual([record.domain,record.reportedDomain,record.desiredDomain,record.proxyMode],['jp.example.com','jp.example.com',undefined,'domain'],'the machine now serves, and reports, the new domain');
  await beat();
  assert.equal(request(),null,'and asks for nothing more');
  // Clearing the domain in the panel moves the machine to its public IP.
  record.desiredMode='ip';
  await beat();
  assert.deepEqual([request().mode,request().desiredDomain],['ip',undefined]);
});

test('a snapshot the agent cannot apply is reported; it keeps serving the last one and recovers',async t=>{
  const {panel,dir,agent,agentId,record,sleeps,beat,logs}=await runningAgent(t),blocker=path.join(dir,'previous.snapshot');
  const beatWait=await sleeps.next(heartbeatWait,'the heartbeat wait'),retryWait=(_ms,entry)=>entry!==beatWait;
  // The disk refuses the next snapshot: the copy of the current one cannot be put in place.
  fs.mkdirSync(blocker);
  panel.deploy(agentId,['movies','shows']);
  const first=await sleeps.next(retryWait,'the wait after the refusal');
  assert.deepEqual([record.applyState,record.lastAck.status,record.lastAck.revision,record.appliedRevision,record.desiredRevision],['error','rejected',2,1,2]);
  assert.ok(record.lastAck.error&&record.error===record.lastAck.error,'the panel is told why');
  assert.ok(logs.includes(`[aegis-agent] ${record.lastAck.error}`.slice(0,174)));
  assert.equal((await get(agent.port,'/movies/System/Info')).status,200,'the last good snapshot is still served');
  assert.equal((await get(agent.port,'/shows/Items')).status,404);
  // It tries again, about twice as much later each time.
  first.release();
  const second=await sleeps.next(retryWait,'the second wait');second.release();
  const third=await sleeps.next(retryWait,'the third wait');
  assertBackoff([first.ms,second.ms,third.ms],60_000,'a refused snapshot');
  assert.equal(panel.audits.filter(item=>item===`agent.config_rejected ${agentId} revision 2`).length,3);
  // Meanwhile the heartbeat reports the snapshot it serves, and that the newer one is still refused.
  const reason=record.error;
  await beat();
  assert.deepEqual([record.applyState,record.appliedRevision,record.error],['error',1,reason]);
  // The disk is fine again: the next attempt applies it.
  fs.rmdirSync(blocker);third.release();
  await until(()=>panel.applied(agentId,2),'the snapshot to be applied at last');
  assert.deepEqual([record.applyState,record.lastAck.status,record.appliedRevision,record.error],['active','applied',2,undefined]);
  assert.equal((await get(agent.port,'/shows/Items')).status,200);
});

test('the agent keeps relaying while the panel is unreachable, backs off, and picks up where it left',async t=>{
  const {panel,agent,agentId,sleeps,logs}=await runningAgent(t),anyWait=()=>true;
  // Heartbeats fail. Only the heartbeat is waiting here: the long poll is parked at the panel.
  panel.unreachable=pathname=>pathname.endsWith('/check-in');
  (await sleeps.next(heartbeatWait,'the heartbeat wait')).release();
  const heartbeats=await waitsOf(sleeps,anyWait,11);
  assertBackoff(heartbeats,300_000,'heartbeat');
  assert.ok(heartbeats[0]<=2_500&&heartbeats.slice(-2).every(ms=>ms>=225_000&&ms<=300_000),`2 seconds first, five minutes at most: ${heartbeats}`);
  assert.ok(heartbeats.some((ms,i)=>ms!==Math.min(300_000,2_000*2**i)),`no two agents wait exactly alike: ${heartbeats}`);
  assert.ok(logs.includes('[aegis-agent] fetch failed'));
  assert.equal((await get(agent.port,'/movies/System/Info')).status,200,'the relay does not depend on the panel');
  // The panel is back: the next heartbeat goes through and the beat returns to what the panel asks.
  panel.unreachable=()=>false;
  const before=panel.count('POST check-in');
  (await sleeps.next(anyWait,'the last backoff')).release();
  await until(()=>panel.count('POST check-in')>before,'a check-in after the outage');
  const beatWait=await sleeps.next(anyWait,'the regular beat');
  assert.equal(beatWait.ms,HEARTBEAT_MS);
  // The next failure starts over at 2 seconds, not at twice the beat.
  panel.unreachable=pathname=>pathname.endsWith('/check-in');
  beatWait.release();
  assertBackoff(await waitsOf(sleeps,anyWait,1),300_000,'heartbeat after a recovery');
  panel.unreachable=()=>false;
  (await sleeps.next(anyWait,'the backoff')).release();
  const steady=await sleeps.next(heartbeatWait,'the regular beat again'),pollWait=(_ms,entry)=>entry!==steady;

  // The long poll fails: the same rule, up to a minute. A change made meanwhile is not lost.
  panel.unreachable=pathname=>pathname.endsWith('/config');
  panel.api.wake([agentId]);
  (await sleeps.next(pollWait,'the poll floor')).release();
  const polls=await waitsOf(sleeps,pollWait,8);
  assertBackoff(polls,60_000,'long poll');
  assert.ok(polls.slice(-2).every(ms=>ms>=45_000&&ms<=60_000),`a minute at most: ${polls}`);
  panel.deploy(agentId,['movies','shows']);
  assert.equal((await get(agent.port,'/shows/Items')).status,404);
  panel.unreachable=()=>false;
  (await sleeps.next(pollWait,'the last backoff')).release();
  await until(()=>panel.applied(agentId,2),'the change made during the outage');
  assert.equal((await get(agent.port,'/shows/Items')).status,200);
  // A later failure starts the backoff over.
  panel.unreachable=pathname=>pathname.endsWith('/config');
  panel.api.wake([agentId]);
  (await sleeps.next(pollWait,'the poll floor')).release();
  assertBackoff(await waitsOf(sleeps,pollWait,1),60_000,'long poll after a recovery');
});

test('an agent restarted while the panel is away serves from its cache; a stopped one frees the port',async t=>{
  const {panel,dir,agent,start}=await runningAgent(t),port=agent.port,metricsFile=path.join(dir,'metrics.enc');
  const storageKey=Buffer.from(JSON.parse(fs.readFileSync(path.join(dir,'identity.json'),'utf8')).agentStorageKey,'base64url');
  const counted=()=>JSON.stringify(openLocal(fs.readFileSync(metricsFile,'utf8'),storageKey)).includes('node-movies');
  // The counters were saved when the agent started, before it had relayed anything.
  await until(()=>fs.existsSync(metricsFile),'the first save of the counters');
  assert.equal(counted(),false);
  assert.equal((await get(port,'/movies/System/Info')).status,200);
  await agent.stop();
  assert.equal(counted(),true,'what was relayed since is saved on the way out');
  await assert.rejects(get(port,'/movies/System/Info'),/ECONNREFUSED/);
  panel.unreachable=()=>true;
  const {agent:restarted}=await start(dir);
  assert.deepEqual(await get(restarted.port,'/movies/System/Info'),{status:200,body:'emby:/System/Info'});
  await restarted.stop();await restarted.stop();
});

test('stopping ends the agent\'s own waits and its parked long poll at once, and nothing is sent afterwards',async t=>{
  const w=await world(t),dir=w.dataDir(),{agentId}=await w.enroll(dir,{token:w.panel.token()});
  // The agent's real timers this time: after the first heartbeat it waits 30 seconds, and its long
  // poll is parked at the panel for 25.
  const agent=await startAgent({dataDir:dir,panelUrl:ORIGIN,domain:'hk.example.com',proxyPort:0,proxyHost:'127.0.0.1',version:'1.2.3',fetch:w.panel.fetch});
  await until(()=>w.panel.applied(agentId,1)&&w.panel.count('POST check-in')>=1&&w.panel.count('GET config')>=2,'a heartbeat wait and a parked long poll');
  const started=Date.now();
  await agent.stop();
  assert.ok(Date.now()-started<2_000,`stop took ${Date.now()-started}ms`);
  const sent=w.panel.requests.length;
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(w.panel.requests.length,sent);
  await assert.rejects(get(agent.port,'/movies/System/Info'),/ECONNREFUSED/);
});

test('stop returns only when the heartbeat in flight is over',async t=>{
  const w=await world(t),dir=w.dataDir(),{agentId}=await w.enroll(dir,{token:w.panel.token()});
  // A check-in whose answer is on its way and cannot be called back.
  let holding=false,deliver;const held=new Promise(resolve=>{deliver=resolve});
  const fetchSlowly=async(url,options)=>{const checkIn=new URL(url).pathname.endsWith('/check-in'),response=await w.panel.fetch(url,checkIn?{...options,signal:undefined}:options);if(checkIn&&holding)await held;return response};
  const {agent,sleeps}=await w.start(dir,{fetch:fetchSlowly});
  await until(()=>w.panel.applied(agentId,1),'the first snapshot to be applied');
  const beats=w.panel.count('POST check-in');holding=true;
  (await sleeps.next(heartbeatWait,'the heartbeat wait')).release();
  await until(()=>w.panel.count('POST check-in')>beats,'the check-in to reach the panel');
  let stopped=false;const stopping=agent.stop().then(()=>{stopped=true});
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(stopped,false,'the agent is not done while a request of its own is still out');
  deliver();await stopping;
  assert.equal(sleeps.pending.length,0,'and it does not go back to waiting');
});

test('answers that are not signed by the panel the agent enrolled with are not acted on',async t=>{
  const w=await world(t),dir=w.dataDir(),{agentId}=await w.enroll(dir,{token:w.panel.token()});
  // Someone between the agent and the panel rewrites what the panel says.
  const resign=async response=>{const headers=new Headers(response.headers);headers.set('x-aegis-signature',Buffer.alloc(64,7).toString('base64url'));return new Response(response.status===204?null:await response.arrayBuffer(),{status:response.status,headers})};
  const rewrite=async response=>{const headers=new Headers(response.headers),body=Buffer.from(await response.arrayBuffer());return new Response(response.status===204?null:Buffer.concat([body,Buffer.from(' ')]),{status:response.status,headers})};
  w.panel.tamper=(pathname,response)=>pathname.endsWith('/config')?resign(response):response;
  const {agent,sleeps}=await w.start(dir);
  (await sleeps.next(ms=>backoffWait(ms,1,60_000),'the wait after the refused answer')).release();
  w.panel.tamper=(pathname,response)=>pathname.endsWith('/config')?rewrite(response):response;
  await sleeps.next(ms=>backoffWait(ms,2,60_000),'the wait after the second refused answer');
  assert.ok(w.logs.includes('[aegis-agent] panel response signature rejected')&&w.logs.includes('[aegis-agent] panel response identity rejected'));
  assert.equal(w.panel.applied(agentId,1),0);
  assert.equal((await get(agent.port,'/movies/System/Info')).status,404,'nothing from those answers is served');
  w.panel.tamper=null;
  (await sleeps.next(ms=>backoffWait(ms,2,60_000),'the pending wait')).release();
  await until(()=>w.panel.applied(agentId,1),'the genuine snapshot');
  assert.equal((await get(agent.port,'/movies/System/Info')).status,200);
});

test('enrolling again: a fresh token replaces the identity, anything else keeps the one that works',async t=>{
  const w=await world(t),dir=w.dataDir(),identityFile=path.join(dir,'identity.json'),identity=()=>fs.readFileSync(identityFile,'utf8');
  // A first enrollment needs a token the panel accepts, and an answer signed by the key it hands over.
  await assert.rejects(w.enroll(dir),/ENROLLMENT_TOKEN is required/);
  await assert.rejects(w.enroll(dir,{token:'not-a-token'}),/注册令牌无效、已使用或已过期/);
  const forged=w.panel.token();
  w.panel.tamper=async(_pathname,response)=>{const headers=new Headers(response.headers);headers.set('x-aegis-signature',Buffer.alloc(64,7).toString('base64url'));return new Response(await response.arrayBuffer(),{status:response.status,headers})};
  await assert.rejects(w.enroll(dir,{token:forged}),/panel response signature rejected/);
  w.panel.tamper=null;
  assert.equal(fs.existsSync(identityFile),false,'nothing is kept from a failed enrollment');
  await assert.rejects(enrollAgent({dataDir:dir,panelUrl:'http://panel.test',token:'x',fetch:w.panel.fetch}),/PANEL_URL must be an HTTPS origin/);

  const token=w.panel.token(),first=await w.enroll(dir,{token}),before=identity();
  // The installer run again: no token, or the token already spent.
  assert.deepEqual(await w.enroll(dir),{agentId:first.agentId,registered:false});
  assert.deepEqual(await w.enroll(dir,{token}),{agentId:first.agentId,registered:false});
  assert.equal(identity(),before);
  assert.ok(w.logs.some(line=>line.startsWith('注册令牌无效或已使用（')&&line.includes('保留现有身份')));
  // Even an identity file that cannot be read is kept, not replaced: the installer must not fail on it.
  const damaged=w.dataDir();fs.writeFileSync(path.join(damaged,'identity.json'),'not json');
  assert.deepEqual(await w.enroll(damaged),{agentId:null,registered:false});
  assert.deepEqual(await w.enroll(damaged,{token}),{agentId:null,registered:false});
  assert.equal(fs.readFileSync(path.join(damaged,'identity.json'),'utf8'),'not json');

  // A machine with a life behind it: a cached snapshot, counters, and a host switch on record.
  const {agent}=await w.start(dir);
  await until(()=>w.panel.applied(first.agentId,1),'the first snapshot to be applied');
  await agent.stop();
  fs.writeFileSync(path.join(dir,'host-domain-status.json'),JSON.stringify({state:'active',mode:'domain',currentDomain:'old.example.com'}));
  fs.writeFileSync(path.join(dir,DOMAIN_REQUEST_FILE),'{}');
  assert.deepEqual(['current.snapshot','metrics.enc'].map(name=>fs.existsSync(path.join(dir,name))),[true,true]);
  // A fresh token is the operator saying: register this machine anew.
  const second=await w.enroll(dir,{token:w.panel.token({name:'HK 02'})});
  assert.deepEqual([second.registered,second.agentId!==first.agentId,w.panel.data.agents.find(item=>item.id===second.agentId).name],[true,true,'HK 02']);
  assert.deepEqual(fs.readdirSync(dir),['identity.json'],'nothing sealed for, or done for, the previous identity is left');
  const {agent:reborn}=await w.start(dir);
  await until(()=>w.panel.applied(second.agentId,1),'the new identity to sync');
  assert.equal((await get(reborn.port,'/movies/System/Info')).status,200);
  await assert.rejects(w.start(dir,{panelUrl:'https://other-panel.test'}),/pinned panel URL mismatch/,'an agent runs only against the panel it enrolled with');
});

// agent-main.js as the image runs it. The agent insists on an HTTPS panel origin and the test panel
// has no TLS, so the process is started with a preload that sends that origin to the loopback port.
const ROOT=new URL('..',import.meta.url).pathname;
const freePort=()=>new Promise(resolve=>{const probe=net.createServer();probe.listen(0,'127.0.0.1',()=>{const {port}=probe.address();probe.close(()=>resolve(port))})});
function agentProcess(w,dir,env,args=[]){
  const shim=path.join(dir,'..',`aegis-panel-shim-${path.basename(dir)}.mjs`);
  fs.writeFileSync(shim,`const real=globalThis.fetch;globalThis.fetch=(url,options)=>real(String(url).replace(${JSON.stringify(ORIGIN)},${JSON.stringify(`http://127.0.0.1:${w.panel.port}`)}),options);\n`);
  const child=spawn(process.execPath,['--import',pathToFileURL(shim).href,'src/agent-main.js',...args],{cwd:ROOT,env:{PATH:process.env.PATH,PANEL_URL:ORIGIN,AGENT_DATA_DIR:dir,...env},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',chunk=>{output+=chunk});child.stderr.on('data',chunk=>{output+=chunk});
  const exited=new Promise(resolve=>child.on('exit',(code,signal)=>{fs.rmSync(shim,{force:true});resolve({code,signal,output})}));
  return {child,exited};
}

test('the image entry point enrolls, runs from the environment it is given, and exits on SIGTERM',{timeout:30_000},async t=>{
  const w=await world(t),dir=w.dataDir(),version=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8')).version;
  // The installer runs it once with --enroll; without a token on a fresh machine that is an error.
  const refused=await agentProcess(w,dir,{},['--enroll']).exited;
  assert.ok(refused.code!==0&&/ENROLLMENT_TOKEN is required/.test(refused.output),refused.output);
  const enrolled=await agentProcess(w,dir,{ENROLLMENT_TOKEN:w.panel.token({name:'SG 01',domain:''}),AGENT_NAME:'ignored'},['--enroll']).exited;
  const record=w.panel.data.agents[0];
  assert.deepEqual([enrolled.code,enrolled.output.trim()],[0,`AegisRelay Agent registered: ${record.id}`]);
  assert.deepEqual([record.name,record.agentVersion],['SG 01',version],'it reports the version of the code in the image');
  const again=await agentProcess(w,dir,{},['--enroll']).exited;
  assert.deepEqual([again.code,/保留现有身份/.test(again.output)],[0,true]);
  // Then it is the container's command, configured by the installer's environment file.
  const port=await freePort(),running=agentProcess(w,dir,{AGENT_PROXY_PORT:String(port),AGENT_PROXY_MODE:' IP ',AGENT_PROXY_IP:' 203.0.113.9 '});
  t.after(()=>{running.child.kill('SIGKILL')});
  await until(()=>w.panel.applied(record.id,1)||w.panel.applied(record.id,2),'the first snapshot to be applied');
  await until(()=>get(port,'/movies/System/Info').then(answer=>answer.status===200,()=>false),'the relay on the configured port');
  await until(()=>record.reportedDomain==='203.0.113.9','the first heartbeat');
  assert.deepEqual([record.proxyMode,record.agentVersion,record.proxyHealthy],['ip',version,true]);
  const asked=Date.now();running.child.kill('SIGTERM');
  const ended=await running.exited;
  assert.deepEqual([ended.code,ended.signal],[0,null],ended.output);
  assert.ok(Date.now()-asked<3_000,`exit took ${Date.now()-asked}ms`);
  await assert.rejects(get(port,'/movies/System/Info'),/ECONNREFUSED/);
  // A panel address that is not an HTTPS origin is refused before anything else.
  const plain=await agentProcess(w,dir,{PANEL_URL:'http://panel.test'}).exited;
  assert.ok(plain.code!==0&&/PANEL_URL must be an HTTPS origin/.test(plain.output),plain.output);
});
