import test from 'node:test';
import assert from 'node:assert/strict';
import { SteeringHub } from '../src/steering-hub.js';
import { SteeringEngine } from '../src/steering.js';
import { agentSnapshotNodes, agentSteeringIssues, normalizeEntryDomain, routeSteeringIssues, steeringEntryBaseUrl, steeringTopology } from '../src/steering-topology.js';
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
