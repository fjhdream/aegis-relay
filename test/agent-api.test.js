import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { AgentApi, agentRequestInput, consumeEnrollment, enrollmentDigest, enrollmentInstallCommand, issueEnrollment, panelResponseInput } from '../src/agent-api.js';
import { openAgentSnapshot } from '../src/agent-config.js';
import { replaceAgentDeployments } from '../src/agent-registry.js';

const publicDer=key=>key.export({format:'der',type:'spki'}).toString('base64url');

test('enrollment tokens are short-lived digests, single use, and create selected deployments',()=>{
  const data={routes:[{id:'route-a'},{id:'route-b'}],agents:[],deployments:[],enrollmentTokens:[]},now=Date.parse('2026-07-21T08:00:00Z');
  const issued=issueEnrollment(data,{name:'Hong Kong 01',domain:'HK.Example.com',routeIds:['route-b'],now});
  assert.equal(data.enrollmentTokens[0].digest,enrollmentDigest(issued.token));
  assert.equal(JSON.stringify(data).includes(issued.token),false);
  assert.equal(issued.record.domain,'hk.example.com');
  assert.equal(new Date(issued.record.expiresAt).getTime()-now,10*60_000);
  const sign=crypto.generateKeyPairSync('ed25519'),box=crypto.generateKeyPairSync('x25519');
  const agent=consumeEnrollment(data,issued.token,{signPublicKey:publicDer(sign.publicKey),boxPublicKey:publicDer(box.publicKey),agentVersion:'0.5.0',capabilities:['registry-v1'],machine:{hostname:'relay-hk'}},now+1);
  assert.equal(agent.name,'Hong Kong 01');
  assert.equal(agent.domain,'hk.example.com');
  assert.deepEqual(data.deployments.map(item=>item.routeId),['route-b']);
  assert.equal(issued.record.digest,undefined);
  assert.throws(()=>consumeEnrollment(data,issued.token,{signPublicKey:'x',boxPublicKey:'x'},now+2),/无效、已使用或已过期/);
});

test('install command uses the HTTPS panel origin, global certificate email and safely quotes names',()=>{
  const command=enrollmentInstallCommand({publicBaseUrl:'https://panel.example.com',token:'secret-token',name:"HK relay's 01",domain:'hk.example.com',email:'ops@example.com'});
  assert.match(command,/https:\/\/panel\.example\.com\/agent-install\.sh/);
  assert.match(command,/--token 'secret-token'/);
  assert.match(command,/HK relay'"'"'s 01/);
  assert.match(command,/--email 'ops@example\.com'/);
  assert.throws(()=>enrollmentInstallCommand({publicBaseUrl:'http://panel.example.com',token:'x',name:'HK'}),/HTTPS/);
  assert.throws(()=>enrollmentInstallCommand({publicBaseUrl:'https://panel.example.com',token:'x',name:'HK',domain:'hk.example.com'}),/统一证书邮箱/);
});

test('an enrollment without a domain produces an IP reverse-proxy install command',()=>{
  const command=enrollmentInstallCommand({publicBaseUrl:'https://panel.example.com',token:'tok',name:'HK 01'});
  assert.match(command,/--mode ip/);
  assert.doesNotMatch(command,/--domain/);
  assert.doesNotMatch(command,/--email/);
  // No certificate email is required for IP mode.
  assert.equal(typeof enrollmentInstallCommand({publicBaseUrl:'https://panel.example.com',token:'tok',name:'HK 01',domain:''}),'string');
});

test('agent and panel signature inputs are fixed LF-delimited protocol strings',()=>{
  assert.equal(agentRequestInput({method:'post',path:'/api/agent/v1/check-in',agentId:'a',timestamp:1,nonce:'n',contentHash:'h'}),'AegisRelay-Agent-Request-v1\nPOST\n/api/agent/v1/check-in\na\n1\nn\nh');
  assert.equal(panelResponseInput({status:200,requestNonce:'n',timestamp:2,contentHash:'h'}),'AegisRelay-Panel-Response-v1\n200\nn\n2\nh');
});

function request(url,body,headers={},method='POST'){const req=Readable.from([Buffer.from(body)]);req.url=url;req.method=method;req.headers=headers;req.socket={remoteAddress:'127.0.0.1'};return req;}
function response(){return{status:0,headers:{},raw:Buffer.alloc(0),writeHead(status,headers){this.status=status;this.headers=headers},end(raw){this.raw=Buffer.from(raw||'')}}}
function signedHeaders({method,path,agentId,privateKey,body,nonce}){const timestamp=Math.floor(Date.now()/1000),contentHash=crypto.createHash('sha256').update(body).digest('base64url'),signature=crypto.sign(null,Buffer.from(agentRequestInput({method,path,agentId,timestamp,nonce,contentHash})),privateKey).toString('base64url');return{'x-aegis-agent-id':agentId,'x-aegis-timestamp':String(timestamp),'x-aegis-nonce':nonce,'x-aegis-content-sha256':contentHash,'x-aegis-signature':signature}}

test('signed check-in updates an enrolled agent and rejects a replayed nonce',async()=>{
  const data={routes:[],agents:[],deployments:[],enrollmentTokens:[],controlPlane:{}},store={data,save(){},audit(){}};
  const api=new AgentApi({store,version:'0.5.0'}),issued=issueEnrollment(data,{name:'JP 01'}),sign=crypto.generateKeyPairSync('ed25519'),box=crypto.generateKeyPairSync('x25519'),requestNonce='enrollment-request-nonce';
  const enrollBody=JSON.stringify({protocolVersion:1,requestNonce,token:issued.token,agent:{signPublicKey:publicDer(sign.publicKey),boxPublicKey:publicDer(box.publicKey),agentVersion:'0.5.0',capabilities:['registry-v1']},machine:{hostname:'jp'}}),enrollResponse=response();
  await api.handle(request('/api/agent/v1/enroll',enrollBody,{'content-type':'application/json'}),enrollResponse);
  assert.equal(enrollResponse.status,201);const enrolled=JSON.parse(enrollResponse.raw),body=Buffer.from(JSON.stringify({agentVersion:'0.5.0',currentRevision:0,applyState:'waiting',proxyHealthy:false,domain:'jp.example.com',capabilities:['registry-v1']})),timestamp=Math.floor(Date.now()/1000),nonce='0123456789abcdefghijkl',contentHash=crypto.createHash('sha256').update(body).digest('base64url'),signature=crypto.sign(null,Buffer.from(agentRequestInput({method:'POST',path:'/api/agent/v1/check-in',agentId:enrolled.agentId,timestamp,nonce,contentHash})),sign.privateKey).toString('base64url'),headers={'content-type':'application/json','x-aegis-agent-id':enrolled.agentId,'x-aegis-timestamp':String(timestamp),'x-aegis-nonce':nonce,'x-aegis-content-sha256':contentHash,'x-aegis-signature':signature};
  const first=response();await api.handle(request('/api/agent/v1/check-in',body,headers),first);assert.equal(first.status,200);assert.equal(data.agents[0].reportedDomain,'jp.example.com');assert.ok(data.agents[0].lastSeen);
  const replay=response();await api.handle(request('/api/agent/v1/check-in',body,headers),replay);assert.equal(replay.status,409);assert.match(replay.raw.toString(),/nonce/);
});

test('selected routes flow through encrypted config pull and applied ACK',async()=>{
  const route={id:'route-a',alias:'alpha',name:'Alpha',enabled:true,upstreams:['https://origin.example.com'],playbackUpstreams:[],allowPrivate:false,tlsVerify:true,showOnHome:false,clientProfile:{enabled:false},speedLimitMbps:0,monthlyQuotaGB:0,accessMode:'alias_only'},data={routes:[route],agents:[],deployments:[],enrollmentTokens:[],controlPlane:{}},store={data,save(){},audit(){}};
  const api=new AgentApi({store,version:'0.6.0'}),issued=issueEnrollment(data,{name:'HK proxy',routeIds:['route-a']}),sign=crypto.generateKeyPairSync('ed25519'),box=crypto.generateKeyPairSync('x25519'),enrollBody=JSON.stringify({protocolVersion:1,requestNonce:'enrollment-config-nonce',token:issued.token,agent:{signPublicKey:publicDer(sign.publicKey),boxPublicKey:publicDer(box.publicKey),agentVersion:'0.6.0',capabilities:['config-v1','proxy-v1']},machine:{hostname:'hk'}}),enrollResponse=response();
  await api.handle(request('/api/agent/v1/enroll',enrollBody),enrollResponse);const enrolled=JSON.parse(enrollResponse.raw),checkBody=Buffer.from(JSON.stringify({agentVersion:'0.7.0',currentRevision:0,applyState:'waiting',proxyHealthy:true,domain:'hk.example.com',capabilities:['config-v1','proxy-v1','telemetry-v1'],telemetry:{nodes:[{id:'route-a',requests:5,playbackRequests:3,bytesOut:4096,monthBytes:4096,active:1}],daily:{'2026-07-21':4096}}})),checkPath='/api/agent/v1/check-in',checkResponse=response();
  await api.handle(request(checkPath,checkBody,signedHeaders({method:'POST',path:checkPath,agentId:enrolled.agentId,privateKey:sign.privateKey,body:checkBody,nonce:'checkin-config-nonce-01'})),checkResponse);assert.equal(checkResponse.status,200);assert.equal(JSON.parse(checkResponse.raw).desiredRevision,1);assert.equal(data.agents[0].telemetry.totalBytes,4096);assert.equal(data.agents[0].telemetry.playbackRequests,3);
  const configPath='/api/agent/v1/config?after=0&wait=0',empty=Buffer.alloc(0),configResponse=response();await api.handle(request(configPath,empty,signedHeaders({method:'GET',path:configPath,agentId:enrolled.agentId,privateKey:sign.privateKey,body:empty,nonce:'config-request-nonce-01'}),'GET'),configResponse);assert.equal(configResponse.status,200);
  const snapshot=openAgentSnapshot({envelope:JSON.parse(configResponse.raw),identity:{agentId:enrolled.agentId,boxPrivateKey:box.privateKey.export({format:'der',type:'pkcs8'}).toString('base64url'),panelKeyId:enrolled.panelKeyId,panelSigningPublicKey:enrolled.panelSigningPublicKey}});assert.equal(snapshot.revision,1);assert.deepEqual(snapshot.nodes.map(node=>node.alias),['alpha']);
  const ackPath='/api/agent/v1/ack',ackBody=Buffer.from(JSON.stringify({revision:snapshot.revision,hash:snapshot.hash,status:'applied',proxyHealthy:true})),ackResponse=response();await api.handle(request(ackPath,ackBody,signedHeaders({method:'POST',path:ackPath,agentId:enrolled.agentId,privateKey:sign.privateKey,body:ackBody,nonce:'config-acknowledge-01'})),ackResponse);assert.equal(ackResponse.status,200);assert.equal(data.agents[0].appliedRevision,1);assert.equal(data.agents[0].applyState,'active');
});

test('enrollment endpoint rate-limits repeated attempts from one address',async()=>{
  const data={routes:[],agents:[],deployments:[],enrollmentTokens:[],controlPlane:{}},store={data,save(){},audit(){}};
  const api=new AgentApi({store,version:'0.8.0'});
  const bad=JSON.stringify({protocolVersion:1,requestNonce:'limit-check',token:'guess'});
  let limited=null;
  for(let i=0;i<20;i++){
    const res=response();
    await api.handle(request('/api/agent/v1/enroll',bad,{'content-type':'application/json'}),res);
    if(res.status===429){limited=res;break}
    assert.equal(res.status,401);
  }
  assert.ok(limited,'expected a 429 before 20 attempts');
  assert.match(limited.raw.toString(),/too many enrollment attempts/);
  const another=response();
  await api.handle(request('/api/agent/v1/enroll',bad,{'content-type':'application/json'}),another);
  assert.equal(another.status,429);
});

test('panel drives an agent from domain to IP mode and clears the desire when the agent reports it',async()=>{
  const data={routes:[],agents:[],deployments:[],enrollmentTokens:[],controlPlane:{},settings:{}},store={data,save(){},audit(){}};
  const api=new AgentApi({store,version:'0.8.0'}),sign=crypto.generateKeyPairSync('ed25519'),box=crypto.generateKeyPairSync('x25519');
  const issued=issueEnrollment(data,{name:'HK 01',domain:'hk.example.com'});
  const enrollBody=JSON.stringify({protocolVersion:1,requestNonce:'enroll-ipmode-nonce-000',token:issued.token,agent:{signPublicKey:publicDer(sign.publicKey),boxPublicKey:publicDer(box.publicKey),agentVersion:'0.8.0',capabilities:['proxy-v1']},machine:{hostname:'hk'}}),enrollResponse=response();
  await api.handle(request('/api/agent/v1/enroll',enrollBody,{'content-type':'application/json'}),enrollResponse);
  const enrolled=JSON.parse(enrollResponse.raw),agent=data.agents[0];
  // Panel operator switches this machine to IP reverse-proxy mode.
  agent.desiredMode='ip';agent.domain='hk.example.com';agent.proxyMode='domain';
  // 1) A plain check-in (agent has not switched yet) must carry the desiredMode so the agent acts.
  const b1=Buffer.from(JSON.stringify({agentVersion:'0.8.0',currentRevision:0,applyState:'active',proxyHealthy:true,domain:'hk.example.com',proxyMode:'domain'})),p1='/api/agent/v1/check-in',r1=response();
  await api.handle(request(p1,b1,signedHeaders({method:'POST',path:p1,agentId:enrolled.agentId,privateKey:sign.privateKey,body:b1,nonce:'ip-checkin-nonce-0000001'})),r1);
  assert.equal(r1.status,200);assert.equal(JSON.parse(r1.raw).desiredMode,'ip');
  // 2) The agent's host unit switched and reports an active IP-mode domainStatus.
  const b2=Buffer.from(JSON.stringify({agentVersion:'0.8.0',currentRevision:0,applyState:'active',proxyHealthy:true,domain:'203.0.113.9',proxyMode:'ip',domainStatus:{requestId:'r',state:'active',mode:'ip',currentDomain:'203.0.113.9',message:'已切换为 IP 反代（HTTP）',updatedAt:new Date().toISOString()}})),r2=response();
  await api.handle(request(p1,b2,signedHeaders({method:'POST',path:p1,agentId:enrolled.agentId,privateKey:sign.privateKey,body:b2,nonce:'ip-checkin-nonce-0000002'})),r2);
  assert.equal(r2.status,200);
  assert.equal(agent.domain,'203.0.113.9');
  assert.equal(agent.proxyMode,'ip');
  assert.equal(agent.desiredMode,undefined,'panel stops re-pushing once the agent confirms IP mode');
  assert.equal(JSON.parse(r2.raw).desiredMode,'');
});

async function enrolledAgent(capabilities){
  const route={id:'route-a',alias:'alpha',name:'Alpha',enabled:true,upstreams:['https://origin.example.com'],allowPrivate:false,tlsVerify:true,showOnHome:false,clientProfile:{enabled:false},speedLimitMbps:0,monthlyQuotaGB:0,accessMode:'alias_only'};
  const data={routes:[route],agents:[],deployments:[],enrollmentTokens:[],controlPlane:{},settings:{}},store={data,save(){},audit(){}};
  const api=new AgentApi({store,version:'0.10.21'}),issued=issueEnrollment(data,{name:'HK 01',routeIds:['route-a']}),sign=crypto.generateKeyPairSync('ed25519'),box=crypto.generateKeyPairSync('x25519');
  const enrollBody=JSON.stringify({protocolVersion:1,requestNonce:'enroll-longpoll-nonce-00',token:issued.token,agent:{signPublicKey:publicDer(sign.publicKey),boxPublicKey:publicDer(box.publicKey),agentVersion:'0.10.21',capabilities},machine:{hostname:'hk'}}),enrollResponse=response();
  await api.handle(request('/api/agent/v1/enroll',enrollBody,{'content-type':'application/json'}),enrollResponse);
  const enrolled=JSON.parse(enrollResponse.raw);let sequence=0;
  const call=async(method,path,payload,res=response(),privateKey=sign.privateKey)=>{const body=payload===null?Buffer.alloc(0):Buffer.from(JSON.stringify(payload));await api.handle(request(path,body,signedHeaders({method,path,agentId:enrolled.agentId,privateKey,body,nonce:`longpoll-request-nonce-${String(++sequence).padStart(4,'0')}`}),method),res);return res;};
  const checkIn=async currentRevision=>JSON.parse((await call('POST','/api/agent/v1/check-in',{agentVersion:'0.10.21',currentRevision,applyState:'active',proxyHealthy:true,capabilities})).raw);
  return {api,data,agentId:enrolled.agentId,box,enrolled,call,checkIn};
}

test('only agents that follow config over the long poll get the relaxed heartbeat',async()=>{
  const legacy=await enrolledAgent(['config-v1','proxy-v1']);
  const pending=await legacy.checkIn(0);
  assert.equal(pending.desiredRevision,1);
  assert.equal(pending.heartbeatSeconds,5,'a legacy agent with un-applied config is asked back sooner');
  assert.equal((await legacy.checkIn(1)).heartbeatSeconds,10,'an idle legacy agent keeps the short beat');
  const following=await enrolledAgent(['config-v1','proxy-v1','config-longpoll-v1']);
  assert.equal((await following.checkIn(0)).heartbeatSeconds,30,'a long-polling agent is woken by the change itself');
});

test('a parked config long poll is released as soon as the machine node set changes',async()=>{
  const agent=await enrolledAgent(['config-v1','proxy-v1','config-longpoll-v1']);
  const current=(await agent.checkIn(0)).desiredRevision;
  const parked=Object.assign(new EventEmitter(),response()),started=Date.now();
  const polling=agent.call('GET',`/api/agent/v1/config?after=${current}&wait=25`,null,parked);
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(parked.status,0,'nothing changed yet, so the poll stays parked');
  replaceAgentDeployments(agent.data,agent.agentId,[]);agent.api.invalidate();
  await polling;
  assert.equal(parked.status,200);
  assert.ok(Date.now()-started<2_000,'the change is delivered at once, not at the end of the wait');
  const snapshot=openAgentSnapshot({envelope:JSON.parse(parked.raw),identity:{agentId:agent.agentId,boxPrivateKey:agent.box.privateKey.export({format:'der',type:'pkcs8'}).toString('base64url'),panelKeyId:agent.enrolled.panelKeyId,panelSigningPublicKey:agent.enrolled.panelSigningPublicKey}});
  assert.equal(snapshot.revision,current+1);
  assert.deepEqual(snapshot.nodes,[]);
});

test('shutdown answers every parked long poll at once so the panel can exit inside the stop grace period',async()=>{
  const agent=await enrolledAgent(['config-v1','proxy-v1','config-longpoll-v1']);
  const current=(await agent.checkIn(0)).desiredRevision;
  const parked=Object.assign(new EventEmitter(),response()),started=Date.now();
  const polling=agent.call('GET',`/api/agent/v1/config?after=${current}&wait=25`,null,parked);
  await new Promise(resolve=>setTimeout(resolve,50));
  agent.api.close();
  await polling;
  assert.equal(parked.status,204);
  assert.equal(parked.headers.connection,'close','the freed keep-alive socket must not carry the next poll back in');
  assert.ok(Date.now()-started<2_000);
  const late=Object.assign(new EventEmitter(),response());
  await agent.call('GET',`/api/agent/v1/config?after=${current}&wait=25`,null,late);
  assert.equal(late.status,204,'a poll that arrives while shutting down is not parked');
});

test('agent signatures are checked against a cached key that follows the agent record',async()=>{
  const agent=await enrolledAgent(['config-v1']),record=agent.data.agents[0],path='/api/agent/v1/check-in',beat={agentVersion:'0.10.22',currentRevision:0,applyState:'active',proxyHealthy:true};
  assert.equal((await agent.call('POST',path,beat)).status,200);
  assert.equal((await agent.call('POST',path,beat)).status,200,'a second request reuses the parsed key');
  const replacement=crypto.generateKeyPairSync('ed25519');record.signPublicKey=publicDer(replacement.publicKey);
  const stale=await agent.call('POST',path,beat);
  assert.equal(stale.status,401);assert.match(stale.raw.toString(),/signature rejected/,'the old key must stop working once the record changes');
  assert.equal((await agent.call('POST',path,beat,response(),replacement.privateKey)).status,200);
  delete record.signPublicKey;
  const missing=await agent.call('POST',path,beat);
  assert.equal(missing.status,401);assert.match(missing.raw.toString(),/agent key invalid/);
});

test('the signed steering endpoint exchanges sessions, and an upgrade to steering recompiles every snapshot',async()=>{
  const { SteeringHub }=await import('../src/steering-hub.js'),{ newRouteAuthKey, ROUTE_AUTH_VERSION, routeTokenDigest }=await import('../src/route-auth.js');
  const routeAuthKey=newRouteAuthKey();
  const data={routes:[{id:'route-a',alias:'movie',enabled:true,accessMode:'key',authVersion:ROUTE_AUTH_VERSION,routeAuthKey,keyDigest:routeTokenDigest('key123',routeAuthKey),upstreams:['https://emby.example.net'],autoSteer:{enabled:true}}],
    agents:[{id:'local',domain:'s1.example.com',state:'active'}],deployments:[{agentId:'local',routeId:'route-a',enabled:true}],enrollmentTokens:[],controlPlane:{},settings:{steering:{mode:'on',entryDomain:'entry.example.com'}}},store={data,save(){},audit(){}};
  let topologyChanges=0;
  const hub=new SteeringHub({store}),api=new AgentApi({store,version:'0.11.0',steering:hub,onTopologyChange:()=>topologyChanges++});
  const issued=issueEnrollment(data,{name:'HK',domain:'s2.example.com',routeIds:['route-a']}),sign=crypto.generateKeyPairSync('ed25519'),box=crypto.generateKeyPairSync('x25519');
  const enrollResponse=response();
  await api.handle(request('/api/agent/v1/enroll',JSON.stringify({protocolVersion:1,requestNonce:'steer-enroll-nonce-0001',token:issued.token,agent:{signPublicKey:publicDer(sign.publicKey),boxPublicKey:publicDer(box.publicKey),agentVersion:'0.10.22',capabilities:['config-v1']},machine:{}})),enrollResponse);
  assert.equal(topologyChanges,1,'enrolling a machine while steering is on recompiles the local snapshot');topologyChanges=0;
  const agentId=JSON.parse(enrollResponse.raw).agentId,signed=(path,body,nonce,method='POST')=>request(path,body,signedHeaders({method,path,agentId,privateKey:sign.privateKey,body,nonce}),method);
  // Before the upgrade the machine is not part of the node's steering topology.
  assert.equal(api.desired(data.agents[1]).nodes[0].steering,undefined);
  const checkBody=Buffer.from(JSON.stringify({agentVersion:'0.11.0',currentRevision:0,applyState:'waiting',proxyHealthy:true,domain:'s2.example.com',proxyMode:'domain',capabilities:['config-v1','steering-v1']}));
  const checkResponse=response();await api.handle(signed('/api/agent/v1/check-in',checkBody,'steer-checkin-nonce-0001'),checkResponse);
  assert.equal(checkResponse.status,200);
  assert.equal(topologyChanges,1,'the local snapshot is recompiled too');
  assert.deepEqual(api.desired(data.agents[1]).nodes[0].steering.peers.map(peer=>peer.id).sort(),[agentId,'local'].sort());
  const s='Q'.repeat(22),steerBody=Buffer.from(JSON.stringify({protocolVersion:1,cursor:0,reports:[{s,r:'route-a',verdict:'ok',rateBps:1000,at:Date.now()}],health:{routes:{'route-a':{line:0,quotaExhausted:false}}}}));
  const steerResponse=response();await api.handle(signed('/api/agent/v1/steering',steerBody,'steer-sync-nonce-00001'),steerResponse);
  assert.equal(steerResponse.status,200);
  const payload=JSON.parse(steerResponse.raw);
  assert.equal(payload.sessions[0].scores[agentId].verdict,'ok');
  assert.ok(payload.peers.some(peer=>peer.id==='local'&&peer.healthy));
  const unsigned=response();await api.handle(request('/api/agent/v1/steering',steerBody,{}),unsigned);
  assert.equal(unsigned.status,401);
  // An agent that sets up the entry domain itself (entry-v1) is told what to serve and reports back.
  data.settings.certificateEmail='ops@example.com';
  assert.equal(JSON.parse(checkResponse.raw).entry,undefined,'older agents are not sent the entry setup');
  const entryBody=Buffer.from(JSON.stringify({agentVersion:'0.11.1',currentRevision:0,applyState:'waiting',proxyHealthy:true,domain:'s2.example.com',proxyMode:'domain',capabilities:['config-v1','steering-v1','entry-v1'],entryStatus:{requestId:'r1',state:'failed',entryDomain:'entry.example.com',peers:['s1.example.com'],attempt:2,message:'x'.repeat(900)}}));
  const entryResponse=response();await api.handle(signed('/api/agent/v1/check-in',entryBody,'entry-checkin-nonce-001'),entryResponse);
  assert.deepEqual(JSON.parse(entryResponse.raw).entry,{domain:'entry.example.com',email:'ops@example.com',peers:['s1.example.com']});
  assert.deepEqual([data.agents[1].entryStatus.state,data.agents[1].entryStatus.attempt,data.agents[1].entryStatus.message.length],['failed',2,500]);
});
