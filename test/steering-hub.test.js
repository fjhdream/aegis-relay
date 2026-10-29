import test from 'node:test';
import assert from 'node:assert/strict';
import { SteeringHub } from '../src/steering-hub.js';
import { SteeringEngine } from '../src/steering.js';
import { agentSnapshotNodes, agentSteeringIssues, cleanEntryRequest, desiredEntry, egressIssues, egressTopology, entryAttempt, entryCoverageGaps, normalizeEntryDomain, routeSteeringIssues, steeringEntryBaseUrl, steeringTopology } from '../src/steering-topology.js';
import { compileAgentDesiredSnapshot, generatePanelSigningIdentity } from '../src/snapshot.js';
import { newRouteAuthKey, ROUTE_AUTH_VERSION, routeTokenDigest } from '../src/route-auth.js';

const KEY=/^[A-Za-z0-9_-]{22}$/;
function fixture({mode='on',entryDomain='entry.example.com'}={}) {
  const routeAuthKey=newRouteAuthKey();
  const route={id:'n1',alias:'movie',name:'Movie',enabled:true,accessMode:'key',authVersion:ROUTE_AUTH_VERSION,routeAuthKey,keyDigest:routeTokenDigest('key123',routeAuthKey),upstreams:['https://emby.example.net'],autoSteer:{enabled:true,minRateMbps:0},speedLimitMbps:0};
  const now=new Date().toISOString();
  const data={
    settings:{steering:{mode,entryDomain}},routes:[route],
    agents:[
      {id:'local',name:'panel',domain:'s1.example.com',state:'active'},
      {id:'b',name:'hk',domain:'s2.example.com',proxyMode:'domain',state:'active',capabilities:['steering-v1'],lastSeen:now,proxyHealthy:true,desiredRevision:3,appliedRevision:3},
      {id:'c',name:'jp',domain:'s3.example.com',proxyMode:'domain',state:'active',capabilities:['config-v1'],lastSeen:now,proxyHealthy:true}
    ],
    deployments:[{agentId:'local',routeId:'n1',enabled:true},{agentId:'b',routeId:'n1',enabled:true},{agentId:'c',routeId:'n1',enabled:true}]
  };
  return {data,route,store:{data}};
}

test('topology lists only machines that can be steered to, on their direct HTTPS domains',()=>{
  const {data,route}=fixture();
  const topology=steeringTopology(data,route);
  assert.deepEqual(topology.peers,[{id:'b',base:'https://s2.example.com'},{id:'local',base:'https://s1.example.com'}]);
  assert.equal(topology.mode,'on');
  assert.deepEqual(agentSteeringIssues(data.agents[2],{entryDomain:'entry.example.com'}),['探针版本不支持切流，需要升级']);
  assert.match(agentSteeringIssues({...data.agents[1],domain:'entry.example.com'},{entryDomain:'entry.example.com'})[0],/入口域名相同/);
  assert.match(agentSteeringIssues({...data.agents[1],proxyMode:'ip'},{entryDomain:''})[0],/IP 反代/);
  assert.match(agentSteeringIssues({...data.agents[1],steerTarget:false},{entryDomain:''})[0],/已关闭/);
});

test('a node needs a key, no speed limit and two participating machines',()=>{
  const {data,route}=fixture();
  assert.deepEqual(routeSteeringIssues(data,route),[]);
  assert.match(routeSteeringIssues(data,{...route,speedLimitMbps:10}).join(),/限速/);
  assert.match(routeSteeringIssues(data,{...route,accessMode:'alias_only',routeAuthKey:null}).join(),/连接密码/);
  assert.match(routeSteeringIssues({...data,deployments:data.deployments.slice(0,1)},route).join(),/两台/);
  assert.equal(steeringTopology({...data,settings:{steering:{mode:'off'}}},route),null);
});

test('snapshots only change for machines that steer, and stay identical when steering is off',()=>{
  const {data}=fixture(),identity=generatePanelSigningIdentity();
  const steered=agentSnapshotNodes(data,'b');
  assert.equal(steered[0].steering.peers.length,2);
  assert.equal(agentSnapshotNodes(data,'c')[0].steering,undefined,'an old agent keeps its exact snapshot');
  const off=structuredClone(data);off.settings.steering.mode='off';
  const withoutSteering=compileAgentDesiredSnapshot({data:off,agentId:'b',signingIdentity:identity}).snapshot;
  const missing=structuredClone(data);delete missing.settings;
  assert.equal(compileAgentDesiredSnapshot({data:missing,agentId:'b',signingIdentity:identity}).snapshot.hash,withoutSteering.hash);
  const withSteering=compileAgentDesiredSnapshot({data,agentId:'b',signingIdentity:identity}).snapshot;
  assert.notEqual(withSteering.hash,withoutSteering.hash);
  assert.deepEqual(withSteering.nodes[0].steering,{mode:'on',peers:[{id:'b',base:'https://s2.example.com'},{id:'local',base:'https://s1.example.com'}],params:{minRateMbps:0}});
});

test('entry domains are validated and only steered nodes are handed out on them',()=>{
  assert.equal(normalizeEntryDomain('https://Entry.Example.com/'),'entry.example.com');
  assert.equal(normalizeEntryDomain(''),'');
  assert.throws(()=>normalizeEntryDomain('entry.example.com:8443'));
  const {data,route}=fixture();
  assert.equal(steeringEntryBaseUrl(data,route),'https://entry.example.com');
  assert.equal(steeringEntryBaseUrl(data,{...route,autoSteer:{enabled:false}}),'');
  assert.equal(steeringEntryBaseUrl({...data,settings:{steering:{mode:'off',entryDomain:'entry.example.com'}}},route),'','not while steering is off');
  assert.equal(steeringEntryBaseUrl(data,{...route,speedLimitMbps:5}),'','not for a node that cannot steer');
});

test('the entry address is only handed out when every machine behind the entry domain serves the node',()=>{
  const {data,route}=fixture();
  // A third participating machine serves the entry domain but not this node: a client sent there would get 404.
  data.agents.push({id:'d',name:'sg',domain:'s4.example.com',proxyMode:'domain',state:'active',capabilities:['steering-v1']});
  assert.deepEqual(entryCoverageGaps(data,route).map(agent=>agent.id),['d']);
  assert.equal(steeringEntryBaseUrl(data,route),'');
  data.deployments.push({agentId:'d',routeId:'n1',enabled:true});
  assert.deepEqual(entryCoverageGaps(data,route),[]);
  assert.equal(steeringEntryBaseUrl(data,route),'https://entry.example.com');
  // A machine that opted out does not serve the entry domain, so it leaves no gap.
  data.deployments.pop();data.agents.at(-1).steerTarget=false;
  assert.equal(steeringEntryBaseUrl(data,route),'https://entry.example.com');
});

test('the hub keeps each machine to its own score and arbitrates reassignments by epoch',()=>{
  let now=1_000_000;
  const {store}=fixture(),hub=new SteeringHub({store,clock:()=>now});
  const s='A'.repeat(22);
  hub.exchange('local',{cursor:0,reports:[{s,r:'n1',verdict:'starved_down',rateBps:1e6,at:now}],health:{routes:{n1:{line:0}}}});
  // b may not speak for local
  hub.exchange('b',{cursor:0,reports:[{s,r:'n1',verdict:'ok',rateBps:5e6,at:now}],health:{routes:{n1:{line:0}}}});
  const session=hub.sessions.get(s);
  assert.deepEqual(Object.keys(session.scores).sort(),['b','local']);
  assert.equal(session.scores.local.verdict,'starved_down');
  hub.exchange('local',{decisions:[{s,r:'n1',assigned:'b',epoch:1,switched:true,from:'local',reason:'better_line',at:now}]});
  const response=hub.exchange('c',{decisions:[{s,r:'n1',assigned:'local',epoch:1,switched:true,at:now}]});
  assert.equal(session.assigned,'b','first to reach the epoch wins');
  assert.equal(response.sessions.find(item=>item.s===s).assigned,'b','the loser learns the winner in the same response');
  hub.exchange('c',{decisions:[{s,r:'n1',assigned:'ghost',epoch:5,at:now}]});
  assert.equal(session.assigned,'b','unknown machines are never assigned');
  assert.equal(hub.events.filter(event=>event.mode==='on').length,1);
});

test('the hub hands out only changes since the cursor, for deployed nodes, with peer health',()=>{
  let now=2_000_000;
  const {store}=fixture(),hub=new SteeringHub({store,clock:()=>now});
  const s='B'.repeat(22);
  hub.exchange('local',{reports:[{s,r:'n1',verdict:'ok',rateBps:1,at:now}],health:{routes:{n1:{line:0,quotaExhausted:false}}}});
  const first=hub.exchange('b',{cursor:0,health:{routes:{n1:{line:0}}}});
  assert.equal(first.sessions.length,1);assert.equal(first.serverTime,now);
  const again=hub.exchange('b',{cursor:first.cursor});
  assert.equal(again.sessions.length,0);
  const peers=Object.fromEntries(first.peers.map(peer=>[peer.id,peer]));
  assert.equal(peers.local.healthy,true);assert.equal(peers.b.healthy,true);assert.equal(peers.c.healthy,false,'no steering capability');
  assert.equal(peers.local.routes.n1.line,0);
  // a session of a node the machine does not serve is ignored entirely
  hub.exchange('b',{reports:[{s:'C'.repeat(22),r:'other',verdict:'ok',rateBps:1,at:now}]});
  assert.equal(hub.sessions.has('C'.repeat(22)),false);
  // a cursor from before a panel restart restarts from zero
  assert.equal(hub.exchange('b',{cursor:999999}).sessions.length,1);
});

test('a client type that keeps failing to follow redirects is excluded automatically',()=>{
  const {store,data}=fixture(),excluded=[];
  const hub=new SteeringHub({store,onAutoExclude:client=>{excluded.push(client);data.settings.steering.autoExcluded={[client]:'now'}}});
  for(let i=0;i<10;i++){const s=String.fromCharCode(65+i).repeat(22);hub.exchange('local',{failures:[{s,r:'n1',epoch:1,target:'b',client:'OddPlayer',at:1}]});}
  assert.deepEqual(excluded,['OddPlayer']);
  assert.ok(hub.exchange('b',{}).excludedClients.includes('OddPlayer'));
  for(let i=0;i<10;i++){const s=String.fromCharCode(97+i).repeat(22);hub.exchange('b',{landings:[{s,r:'n1',epoch:1,client:'GoodPlayer',at:1}]});}
  assert.equal(excluded.length,1);
  assert.equal(hub.view().clients.find(item=>item.client==='GoodPlayer').landed,10);
});

test('two engines converge through the hub: a landing at the target confirms the redirect at the source',async()=>{
  let now=3_000_000_000;
  const {store,route:base}=fixture(),hub=new SteeringHub({store,clock:()=>now});
  const route={...base,steering:{mode:'on',peers:[{id:'b',base:'https://s2.example.com'},{id:'local',base:'https://s1.example.com'}],params:{minRateMbps:0}}};
  const a=new SteeringEngine({selfId:'local',clock:()=>now}),b=new SteeringEngine({selfId:'b',clock:()=>now});
  const sync=async(engine,id)=>engine.applySync(hub.exchange(id,engine.syncPayload([route])));
  await sync(a,'local');await sync(b,'b');await sync(a,'local');
  const url='/movie/key123/Videos/abc/stream.mkv?DeviceId=d1&api_key=x',plan=(engine,path=url)=>{const incoming=new URL(path,'http://relay.invalid');return engine.plan({route,found:{route,rest:incoming.pathname.replace('/movie/key123',''),prefix:'/movie/key123'},req:{method:'GET',headers:{'user-agent':'Infuse-Direct/8'}},incoming,publicContext:{proto:'https'}})};
  plan(a);
  const session=[...a.sessions.values()][0];
  session.scores.local={verdict:'starved_down',rateBps:1e6,at:now};
  const out=plan(a);
  assert.ok(out.redirect.startsWith('https://s2.example.com/movie/key123/'));
  await sync(a,'local');
  const landed=new URL(out.redirect);
  assert.ok(plan(b,`${landed.pathname}${landed.search}`).track);
  await sync(b,'b');await sync(a,'local');
  assert.equal(a.sessions.get(session.key).lastLanding.epoch,1);
  assert.equal(hub.sessions.get(session.key).assigned,'b');
  now+=20_000;await sync(b,'b');await sync(a,'local');
  assert.ok(plan(a).redirect,'still steered after the landing timeout because the landing was confirmed');
  assert.equal(a.failures.length,0);
  a.stop();b.stop();
});

test('switch outcomes: a real switch is judged at its target, a shadow one by whether the line recovered',()=>{
  let now=5_000_000;
  const {store}=fixture(),hub=new SteeringHub({store,clock:()=>now}),at=ms=>{now=5_000_000+ms;return now};
  const [s1,s2,s3,s4]=['D','E','F','G'].map(c=>c.repeat(22));
  hub.exchange('local',{decisions:[{s:s1,r:'n1',assigned:'b',epoch:1,switched:true,from:'local',reason:'explore',fromRateBps:1e6,at:at(0)}]});
  hub.exchange('b',{reports:[{s:s1,r:'n1',verdict:'unknown',rateBps:0,at:at(1000)}]});
  assert.equal(hub.view().effects.on.total,0,'still waiting for a verdict');
  hub.exchange('b',{reports:[{s:s1,r:'n1',verdict:'ok',rateBps:3e6,at:at(2000)}]});
  // a redirect that never lands
  hub.exchange('local',{decisions:[{s:s2,r:'n1',assigned:'b',epoch:1,switched:true,from:'local',at:at(3000)}]});
  hub.exchange('local',{failures:[{s:s2,r:'n1',epoch:1,target:'b',client:'X',at:at(19_000)}],decisions:[{s:s2,r:'n1',assigned:'',epoch:2,switched:false,reason:'landing_timeout',at:now}]});
  const on=hub.view().effects.on;
  assert.deepEqual([on.total,on.better,on.notLanded,on.medianGain],[2,1,1,3]);
  assert.deepEqual(on.pairs.map(pair=>[pair.from,pair.to,pair.total,pair.better]),[['local','b',2,1]]);
  // shadow: one line recovers by itself, one stays stuck
  hub.exchange('local',{shadow:[{s:s3,r:'n1',to:'b',reason:'explore',at:at(20_000)}],reports:[{s:s3,r:'n1',verdict:'starved_down',rateBps:1,at:now}]});
  hub.exchange('local',{reports:[{s:s3,r:'n1',verdict:'ok',rateBps:1,at:at(80_000)}]});
  hub.exchange('local',{shadow:[{s:s4,r:'n1',to:'b',reason:'explore',at:now}]});
  hub.exchange('local',{reports:[{s:s4,r:'n1',verdict:'starved_down',rateBps:1,at:at(140_000)}]});
  hub.exchange('local',{reports:[{s:s4,r:'n1',verdict:'starved_down',rateBps:1,at:at(210_000)}]});
  assert.deepEqual(hub.view().effects.shadow,{total:2,recovered:1,persisted:1,unmeasured:0});
  // an outcome nobody reports on is closed as unmeasured
  hub.exchange('local',{decisions:[{s:'H'.repeat(22),r:'n1',assigned:'b',epoch:1,switched:true,from:'local',at:now}]});
  at(900_000);hub.exchange('local',{});
  assert.equal(hub.view().effects.on.unmeasured,1);
});

test('history is kept per node and client network, at most one sample a minute per session and machine',()=>{
  let now=6_000_000;
  const {store}=fixture(),hub=new SteeringHub({store,clock:()=>now}),p='N'.repeat(16);
  for(let i=0;i<3;i++){
    const s=String.fromCharCode(75+i).repeat(22);
    hub.exchange('local',{reports:[{s,r:'n1',verdict:'starved_down',rateBps:1,at:now,p},{s,r:'n1',verdict:'starved_down',rateBps:1,at:now,p}]});
    hub.exchange('b',{reports:[{s,r:'n1',verdict:'ok',rateBps:1,at:now,p}]});
    now+=120_000;
    hub.exchange('local',{reports:[{s,r:'n1',verdict:'starved_up',rateBps:1,at:now,p}]});
  }
  const fresh='Q'.repeat(22),response=hub.exchange('local',{reports:[{s:fresh,r:'n1',verdict:'unknown',rateBps:0,at:now,p}]});
  assert.deepEqual(response.sessions.find(item=>item.s===fresh).prior,{local:{ok:0,n:3},b:{ok:1,n:3}});
  assert.equal(hub.view().networks,1);
  assert.equal(response.sessions.find(item=>item.s==='R'.repeat(22)),undefined);
  const other=hub.exchange('local',{reports:[{s:'S'.repeat(22),r:'n1',verdict:'unknown',rateBps:0,at:now,p:'M'.repeat(16)}]});
  assert.equal(other.sessions.find(item=>item.s==='S'.repeat(22)).prior,undefined);
});

test('capped ranges: a failed continuation switches a client off, a clean trial switches it on',()=>{
  const {store,data}=fixture(),verdicts=[];
  data.settings.steering.boundedClients=['Infuse'];
  const hub=new SteeringHub({store,onBoundVerdict:(client,works)=>{verdicts.push([client,works]);(works?data.settings.steering.autoBounded||={}:data.settings.steering.autoUnbounded||={})[client]='now'}});
  const send=items=>hub.exchange('local',{bounds:items.map(([client,continued,trial])=>({s:'T'.repeat(22),r:'n1',client,continued,trial,at:1}))});
  send([['Infuse',true,false],['Infuse',false,false]]);
  assert.deepEqual(verdicts,[]);
  assert.deepEqual(send([['Infuse',false,false]]).boundedClients,[],'2 of 3 failed: off, even though the operator listed it');
  // trials only run with automatic detection on, in active mode, for clients that follow redirects
  assert.deepEqual(hub.exchange('local',{}).trialClients,[]);
  data.settings.steering.boundAuto=true;
  for(let i=0;i<5;i++)hub.exchange('b',{landings:[{s:String.fromCharCode(97+i).repeat(22),r:'n1',epoch:1,client:'VLC',at:1}]});
  assert.deepEqual(hub.exchange('local',{}).trialClients,['VLC']);
  send([['VLC',true,true],['VLC',true,true]]);
  assert.equal(verdicts.length,1);
  const after=send([['VLC',true,true]]);
  assert.deepEqual(verdicts.at(-1),['VLC',true]);
  assert.deepEqual([after.boundedClients,after.trialClients],[['VLC'],[]]);
  send([['Kodi',false,true]]);
  assert.deepEqual(verdicts.at(-1),['Kodi',false],'one failed trial is enough');
  assert.deepEqual(hub.view().ranges.find(item=>item.client==='VLC').state,'on');
});

test('each participating machine is told to serve the entry domain and forward ACME challenges to the others',()=>{
  const {data}=fixture();
  assert.equal(desiredEntry(data,'local'),null,'no certificate email yet');
  data.settings.certificateEmail='Ops@Example.com';
  assert.deepEqual(desiredEntry(data,'local'),{domain:'entry.example.com',email:'ops@example.com',peers:['s2.example.com']});
  assert.deepEqual(desiredEntry(data,'b').peers,['s1.example.com']);
  assert.equal(desiredEntry(data,'c'),null,'a machine that cannot steer does not serve the entry domain');
  assert.deepEqual(cleanEntryRequest({domain:'Entry.Example.com',email:'a@b',peers:['s2.example.com','s2.example.com']}),{domain:'entry.example.com',email:'a@b',peers:['s2.example.com']});
  for(const bad of [{domain:'entry.example.com;reboot',email:'a@b',peers:[]},{domain:'entry.example.com',email:'a b@c',peers:[]},{domain:'entry.example.com',email:'a@b',peers:['x y']},{domain:'entry.example.com',email:'a@b',peers:['entry.example.com']},{domain:'entry.example.com',email:'a@b'}])assert.equal(cleanEntryRequest(bad),null);
});

test('an entry setup is filed once per configuration and a failure is retried with growing pauses',()=>{
  const desired={domain:'entry.example.com',email:'a@b',peers:['s2.example.com']},now=Date.parse('2026-10-29T00:00:00Z');
  const status=(state,attempt,minutesAgo,extra={})=>({requestId:'r',state,entryDomain:'entry.example.com',peers:['s2.example.com'],attempt,message:'',updatedAt:new Date(now-minutesAgo*60_000).toISOString(),...extra});
  assert.equal(entryAttempt(desired,null,now),1);
  assert.equal(entryAttempt(desired,status('active',1,0),now),0);
  assert.equal(entryAttempt(desired,status('applying',1,0),now),0);
  assert.equal(entryAttempt(desired,status('active',1,0,{peers:[]}),now),1,'a new machine joined');
  assert.equal(entryAttempt(desired,status('failed',1,2),now),0);
  assert.equal(entryAttempt(desired,status('failed',1,3),now),2);
  assert.equal(entryAttempt(desired,status('failed',2,8),now),0);
  assert.equal(entryAttempt(desired,status('failed',2,9),now),3);
  assert.equal(entryAttempt(desired,status('failed',9,59),now),0);
  assert.equal(entryAttempt(desired,status('failed',9,60),now),10);
});

test('an egress machine is compiled into every other machine serving the node, and only when all of them can relay',()=>{
  const {data,route}=fixture(),identity=generatePanelSigningIdentity();
  data.agents[1].capabilities.push('egress-v1');
  data.deployments=data.deployments.filter(item=>item.agentId!=='c');
  route.egressAgentId='b';
  assert.deepEqual(egressIssues(data,route),[]);
  assert.deepEqual(egressTopology(data,route),{id:'b',base:'https://s2.example.com'});
  assert.deepEqual(agentSnapshotNodes(data,'local')[0].egress,{id:'b',base:'https://s2.example.com'});
  assert.equal(agentSnapshotNodes(data,'b')[0].egress,undefined,'the egress machine goes upstream itself');
  assert.equal(agentSnapshotNodes(data,'local')[0].steering.params.anyLine,true,'line matching is moot through one egress');
  // also in force with steering switched off: the point is a single upstream address
  const off=structuredClone(data);off.settings.steering.mode='off';
  assert.equal(compileAgentDesiredSnapshot({data:off,agentId:'local',signingIdentity:identity}).snapshot.nodes[0].egress.base,'https://s2.example.com');
  // a machine serving the node that cannot relay would bring a second address back: not in force
  data.deployments.push({agentId:'c',routeId:'n1',enabled:true});
  assert.match(egressIssues(data,route).join(),/jp 的探针版本不支持统一出口/);
  assert.equal(agentSnapshotNodes(data,'local')[0].egress,undefined);
  data.deployments.pop();
  assert.match(egressIssues(data,{...route,egressAgentId:'c'}).join(),/没有部署该节点/);
  assert.match(egressIssues(data,{...route,egressAgentId:'gone'}).join(),/不存在/);
  assert.match(egressIssues({...data,agents:data.agents.map(agent=>agent.id==='b'?{...agent,proxyMode:'ip'}:agent)},route).join(),/HTTPS/);
  assert.match(egressIssues(data,{...route,accessMode:'alias_only',routeAuthKey:null}).join(),/连接密码/);
  off.agents=off.agents.map(agent=>agent.id==='b'?{...agent,domain:'s2.example.com/x'}:agent);
  assert.throws(()=>compileAgentDesiredSnapshot({data:off,agentId:'local',signingIdentity:identity}),/invalid egress machine/);
});
