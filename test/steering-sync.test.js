import test from 'node:test';
import assert from 'node:assert/strict';
import { localTransport, readSyncResponse, requeueReport, takeReport } from '../src/steering-sync.js';
import { SteeringEngine } from '../src/steering.js';
import { SteeringHub } from '../src/steering-hub.js';
import { canonicalJson as canonical } from '../src/canonical-json.js';

// As it goes over the wire: JSON, keys sorted.
const wire=value=>canonical(JSON.parse(JSON.stringify(value)));
const NOW=1_800_000_000_000,S='S'.repeat(22),T='T'.repeat(22),P='p'.repeat(16);
function panel() {
  const data={routes:[{id:'n1',alias:'movie'},{id:'n2',alias:'other'}],agents:[{id:'local',state:'active',domain:'panel.example.com'},{id:'hk',state:'active',domain:'hk.example.com',proxyHealthy:true,capabilities:['steering-v1'],lastSeen:new Date(NOW).toISOString(),desiredRevision:3,appliedRevision:3},{id:'gone',state:'revoked'}],
    deployments:[{agentId:'local',routeId:'n1',enabled:true},{agentId:'hk',routeId:'n1',enabled:true},{agentId:'hk',routeId:'n2',enabled:true}],settings:{steering:{mode:'on',excludedClients:['VLC'],boundedClients:['VidHub'],boundMB:16,autoExcluded:{'Odd':'2026-01-01'},autoBounded:{'Infuse':'2026-01-01'},autoUnbounded:{}}}};
  return new SteeringHub({store:{data,save(){},audit(){}},clock:()=>NOW});
}
// A machine's queues with one of everything in them.
function queues() {
  return {cursor:7,reports:new Map([[S,{s:S,r:'n1',verdict:'ok',rateBps:4e6,at:NOW-10,segmentSeconds:6,client:'Infuse',p:P}],[T,{s:T,r:'n1',verdict:'starved_down',rateBps:1e6,at:NOW-20}]]),
    decisions:[{s:S,r:'n1',assigned:'local',epoch:2,switched:true,from:'hk',reason:'explore',fromRateBps:1e6,toRateBps:0,client:'Infuse',at:NOW-5}],
    landings:[{s:S,r:'n1',epoch:1,client:'Infuse',at:NOW-30}],failures:[{s:T,r:'n1',epoch:1,target:'local',client:'VLC',at:NOW-40}],
    shadow:[{s:T,r:'n1',to:'local',reason:'better_line',fromRateBps:1e6,toRateBps:5e6,client:'VLC',at:NOW-50}],
    rangeEvents:[{s:S,r:'n1',phase:'request',item:'i1',start:0,end:999,total:5000,client:'VidHub',at:NOW-60}],playbackEvents:[{r:'n1',kind:'progress',item:'i1',at:NOW-70}]};
}
const HEALTH={routes:{n1:{line:1,quotaExhausted:false},n2:{line:0,quotaExhausted:true}}};

// Both directions, before steering-sync.js existed. Panels and machines of different versions talk to
// each other, so a change here is a protocol change, never an incidental one.
const REPORT="{\"cursor\":7,\"decisions\":[{\"assigned\":\"local\",\"at\":1799999999995,\"client\":\"Infuse\",\"epoch\":2,\"from\":\"hk\",\"fromRateBps\":1000000,\"r\":\"n1\",\"reason\":\"explore\",\"s\":\"SSSSSSSSSSSSSSSSSSSSSS\",\"switched\":true,\"toRateBps\":0}],\"failures\":[{\"at\":1799999999960,\"client\":\"VLC\",\"epoch\":1,\"r\":\"n1\",\"s\":\"TTTTTTTTTTTTTTTTTTTTTT\",\"target\":\"local\"}],\"health\":{\"routes\":{\"n1\":{\"line\":1,\"quotaExhausted\":false},\"n2\":{\"line\":0,\"quotaExhausted\":true}}},\"landings\":[{\"at\":1799999999970,\"client\":\"Infuse\",\"epoch\":1,\"r\":\"n1\",\"s\":\"SSSSSSSSSSSSSSSSSSSSSS\"}],\"playbackEvents\":[{\"at\":1799999999930,\"item\":\"i1\",\"kind\":\"progress\",\"r\":\"n1\"}],\"protocolVersion\":1,\"rangeEvents\":[{\"at\":1799999999940,\"client\":\"VidHub\",\"end\":999,\"item\":\"i1\",\"phase\":\"request\",\"r\":\"n1\",\"s\":\"SSSSSSSSSSSSSSSSSSSSSS\",\"start\":0,\"total\":5000}],\"reports\":[{\"at\":1799999999990,\"client\":\"Infuse\",\"p\":\"pppppppppppppppp\",\"r\":\"n1\",\"rateBps\":4000000,\"s\":\"SSSSSSSSSSSSSSSSSSSSSS\",\"segmentSeconds\":6,\"verdict\":\"ok\"},{\"at\":1799999999980,\"r\":\"n1\",\"rateBps\":1000000,\"s\":\"TTTTTTTTTTTTTTTTTTTTTT\",\"verdict\":\"starved_down\"}],\"shadow\":[{\"at\":1799999999950,\"client\":\"VLC\",\"fromRateBps\":1000000,\"r\":\"n1\",\"reason\":\"better_line\",\"s\":\"TTTTTTTTTTTTTTTTTTTTTT\",\"to\":\"local\",\"toRateBps\":5000000}]}";
const REQUEUED="{\"decisions\":[{\"assigned\":\"local\",\"at\":1799999999995,\"client\":\"Infuse\",\"epoch\":2,\"from\":\"hk\",\"fromRateBps\":1000000,\"r\":\"n1\",\"reason\":\"explore\",\"s\":\"SSSSSSSSSSSSSSSSSSSSSS\",\"switched\":true,\"toRateBps\":0}],\"failures\":[{\"at\":1799999999960,\"client\":\"VLC\",\"epoch\":1,\"r\":\"n1\",\"s\":\"TTTTTTTTTTTTTTTTTTTTTT\",\"target\":\"local\"}],\"landings\":[{\"at\":1799999999970,\"client\":\"Infuse\",\"epoch\":1,\"r\":\"n1\",\"s\":\"SSSSSSSSSSSSSSSSSSSSSS\"}],\"playbackEvents\":[{\"at\":1799999999930,\"item\":\"i1\",\"kind\":\"progress\",\"r\":\"n1\"}],\"rangeEvents\":[{\"at\":1799999999940,\"client\":\"VidHub\",\"end\":999,\"item\":\"i1\",\"phase\":\"request\",\"r\":\"n1\",\"s\":\"SSSSSSSSSSSSSSSSSSSSSS\",\"start\":0,\"total\":5000}],\"shadow\":[{\"at\":1799999999950,\"client\":\"VLC\",\"fromRateBps\":1000000,\"r\":\"n1\",\"reason\":\"better_line\",\"s\":\"TTTTTTTTTTTTTTTTTTTTTT\",\"to\":\"local\",\"toRateBps\":5000000}]}";
const RESPONSE="{\"boundBytes\":16777216,\"boundedClients\":[\"VidHub\",\"Infuse\"],\"cursor\":6,\"excludedClients\":[\"VLC\",\"Odd\"],\"peers\":[{\"at\":1800000000000,\"healthy\":true,\"id\":\"local\",\"routes\":{\"n1\":{\"line\":1,\"quotaExhausted\":false}}},{\"at\":1800000000000,\"healthy\":true,\"id\":\"hk\",\"routes\":{\"n1\":{\"line\":1,\"quotaExhausted\":false},\"n2\":{\"line\":0,\"quotaExhausted\":true}}}],\"protocolVersion\":1,\"serverTime\":1800000000000,\"sessions\":[{\"assigned\":\"\",\"epoch\":0,\"lastLanding\":null,\"lastSeen\":1800000000000,\"lastSwitchAt\":0,\"r\":\"n1\",\"s\":\"TTTTTTTTTTTTTTTTTTTTTT\",\"scores\":{\"hk\":{\"at\":1799999999980,\"rateBps\":1000000,\"verdict\":\"starved_down\"}},\"segmentSeconds\":0,\"switches\":[],\"tried\":{}},{\"assigned\":\"local\",\"epoch\":2,\"lastLanding\":{\"at\":1799999999970,\"epoch\":1},\"lastSeen\":1800000000000,\"lastSwitchAt\":1799999999995,\"prior\":{\"hk\":{\"n\":1,\"ok\":1}},\"r\":\"n1\",\"s\":\"SSSSSSSSSSSSSSSSSSSSSS\",\"scores\":{\"hk\":{\"at\":1799999999990,\"rateBps\":4000000,\"verdict\":\"ok\"},\"local\":{\"at\":1799999999900,\"rateBps\":2000000,\"verdict\":\"starved_up\"}},\"segmentSeconds\":6,\"switches\":[1799999999800,1799999999995],\"tried\":{\"hk\":1799999999800,\"local\":1799999999995}}],\"trialClients\":[]}";
const APPLIED="{\"boundBytes\":16777216,\"bounded\":[\"vidhub\",\"infuse\"],\"cursor\":6,\"excluded\":[\"vlc\",\"odd\"],\"health\":{\"hk\":{\"at\":1800000000000,\"healthy\":true,\"routes\":{\"n1\":{\"line\":1,\"quotaExhausted\":false},\"n2\":{\"line\":0,\"quotaExhausted\":true}}},\"local\":{\"at\":1800000000000,\"healthy\":true,\"routes\":{\"n1\":{\"line\":1,\"quotaExhausted\":false}}}},\"offsetMs\":1000,\"sessions\":[{\"assigned\":\"\",\"epoch\":0,\"key\":\"TTTTTTTTTTTTTTTTTTTTTT\",\"lastLanding\":null,\"lastSeen\":1800000000000,\"lastSwitchAt\":0,\"prior\":{},\"routeId\":\"n1\",\"scores\":{},\"segmentSeconds\":0,\"switches\":[],\"tried\":{}},{\"assigned\":\"local\",\"epoch\":2,\"key\":\"SSSSSSSSSSSSSSSSSSSSSS\",\"lastLanding\":{\"at\":1799999999970,\"epoch\":1},\"lastSeen\":1800000000000,\"lastSwitchAt\":1799999999995,\"prior\":{\"hk\":{\"n\":1,\"ok\":1}},\"routeId\":\"n1\",\"scores\":{\"local\":{\"at\":1799999999900,\"rateBps\":2000000,\"verdict\":\"starved_up\"}},\"segmentSeconds\":6,\"switches\":[1799999999800,1799999999995],\"tried\":{\"hk\":1799999999800,\"local\":1799999999995}}],\"trials\":[]}";

test('the sync on the wire is byte-for-byte what it was before the protocol module existed',()=>{
  const queue=queues(),report=takeReport(queue,HEALTH);
  assert.equal(wire(report),REPORT);
  assert.equal(queue.reports.size,0,'what was sent is taken off the queues');
  requeueReport(queue,report);
  assert.equal(wire({decisions:queue.decisions,landings:queue.landings,failures:queue.failures,shadow:queue.shadow,rangeEvents:queue.rangeEvents,playbackEvents:queue.playbackEvents}),REQUEUED,'a failed sync puts every event back, speed reports excepted');
  const hub=panel();
  hub.exchange('local',{cursor:0,reports:[{s:S,r:'n1',verdict:'starved_up',rateBps:2e6,at:NOW-100}],decisions:[{s:S,r:'n1',assigned:'hk',epoch:1,switched:true,from:'local',reason:'better_line',at:NOW-200}],health:{routes:{n1:{line:1}}}});
  const response=localTransport(hub,'hk')(JSON.parse(REPORT));
  assert.equal(wire(response),RESPONSE);
  const engine=new SteeringEngine({selfId:'hk',clock:()=>NOW-1000});
  engine.applySync(response);
  assert.equal(wire({offsetMs:engine.offsetMs,cursor:engine.cursor,excluded:[...engine.excluded],bounded:[...engine.bounded],trials:[...engine.trials],boundBytes:engine.boundBytes,health:Object.fromEntries(engine.health),
    sessions:[...engine.sessions.values()].map(({key,routeId,assigned,epoch,lastSwitchAt,switches,scores,tried,segmentSeconds,lastLanding,lastSeen,prior})=>({key,routeId,assigned,epoch,lastSwitchAt,switches,scores,tried,segmentSeconds,lastLanding,lastSeen,prior}))}),APPLIED);
  engine.stop();
});

test('a machine keeps what a response leaves out, and ignores what it cannot read',()=>{
  assert.equal(readSyncResponse(null),null);
  const sync=readSyncResponse({serverTime:'x',cursor:-1,sessions:[{s:'short'},null,{s:S,r:'n1',epoch:'2',scores:{a:{verdict:'bogus',rateBps:'9',at:'5'}},switches:[1,'x',3],prior:{a:{ok:2,n:1},b:{ok:0.5,n:3}}}],boundBytes:1000,boundedClients:['VidHub']});
  assert.deepEqual([sync.serverTime,sync.cursor,sync.peers,sync.excludedClients,sync.boundBytes,sync.boundedClients],[undefined,undefined,undefined,undefined,undefined,['vidhub']]);
  assert.equal(sync.sessions.length,1,'only a real session key is a session');
  assert.deepEqual([sync.sessions[0].epoch,sync.sessions[0].scores.a,sync.sessions[0].switches,sync.sessions[0].prior],[2,{verdict:'unknown',rateBps:9,at:5},[1,3],{b:{ok:0.5,n:3}}]);
});

test('the local transport shares nothing between the hub and the machine',()=>{
  const hub=panel(),send=localTransport(hub,'hk'),queue=queues(),report=takeReport(queue,HEALTH);
  const response=send(report);
  response.sessions[0].scores.hk.verdict='tampered';report.reports[0].verdict='tampered';
  const again=send({cursor:0});
  assert.notEqual(again.sessions.find(session=>session.s===response.sessions[0].s).scores.hk.verdict,'tampered');
});
