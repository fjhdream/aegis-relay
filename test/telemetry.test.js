import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateTelemetry, indexViewersByNode, nodeChannels, sanitizeTelemetry, telemetryFromMetrics } from '../src/telemetry.js';

test('agent telemetry is bounded and totals are recomputed from node counters',()=>{
  const telemetry=sanitizeTelemetry({totalBytes:999999,nodes:[{id:'route-a',alias:'alpha',name:'Alpha',requests:3,playbackRequests:2,bytesIn:12,bytesOut:1200,monthBytes:800,active:1,errors:-4,upstream:'must-not-pass'}],daily:{'2026-07-21':1200,'invalid':9}});
  assert.equal(telemetry.totalBytes,1200);assert.equal(telemetry.totalRequests,3);assert.equal(telemetry.errors,0);assert.deepEqual(telemetry.daily,{'2026-07-21':1200});assert.equal('upstream' in telemetry.nodes[0],false);
});

test('telemetry carries per-node viewers and distinct counts, capped and cleaned',()=>{
  const many=Array.from({length:80},(_,i)=>({ip:`10.0.0.${i}`,deviceName:'x\ny',client:'c',deviceId:`d${i}`,ua:'u',firstSeen:1,lastSeen:i,hits:i+1}));
  const telemetry=sanitizeTelemetry({nodes:[{id:'n',alias:'a',name:'N',distinctIps:80,distinctDevices:80,viewers:many}]});
  const node=telemetry.nodes[0];
  assert.equal(node.distinctIps,80);
  assert.equal(node.viewers.length,50); // capped to the report cap
  assert.equal(node.viewers[0].deviceName,'xy'); // newline stripped
  assert.equal(node.viewers[0].ip,'10.0.0.0');
});

test('control plane aggregates daily and per-machine traffic without double counting',()=>{
  const first=telemetryFromMetrics({startedAt:'2026-07-20T00:00:00Z',nodes:[{id:'local',requests:2,playbackRequests:1,bytesOut:100,monthBytes:100,active:0}],daily:{'2026-07-21':100}}),second=sanitizeTelemetry({nodes:[{id:'remote',requests:4,playbackRequests:3,bytesOut:250,monthBytes:200,active:1}],daily:{'2026-07-21':250}}),all=aggregateTelemetry([first,second]);
  assert.equal(all.totalBytes,350);assert.equal(all.monthBytes,300);assert.equal(all.totalRequests,6);assert.equal(all.playbackRequests,4);assert.equal(all.active,1);assert.equal(all.daily['2026-07-21'],350);
});

test('node channels merge viewers across machines and the dashboard counts match the access roster',()=>{
  const row=(ip,device,channelId,lastSeen,hits=1)=>({ip,deviceId:device,channelId,firstSeen:lastSeen,lastSeen,hits});
  const machines=[
    {name:'香港',telemetry:{nodes:[{id:'n1',viewers:[row('1.1.1.1','tv','default',10),row('2.2.2.2','phone','ch-a',30)]},{id:'n2',viewers:[row('9.9.9.9','other','default',5)]}]}},
    {name:'日本',telemetry:{nodes:[{id:'n1',viewers:[row('1.1.1.1','tv','default',20,4),row('3.3.3.3','pad','gone',15)]}]}},
    {name:'空机器',telemetry:null}
  ];
  const index=indexViewersByNode(machines),labels=new Map([['default','默认'],['ch-a','小明'],['ch-b','未使用']]),route={id:'n1',accessAlertThreshold:1};
  assert.deepEqual([...index.keys()],['n1','n2']);
  const counts=nodeChannels(index,route,labels,false),roster=nodeChannels(index,route,labels,true);
  assert.deepEqual({...counts,channels:counts.channels.map(({viewers,...c})=>c)},{...roster,channels:roster.channels.map(({viewers,...c})=>c)},'counts are identical with and without the roster');
  assert.equal(counts.channels.some(c=>c.viewers),false,'the dashboard path never builds the roster');
  const byId=Object.fromEntries(roster.channels.map(c=>[c.id,c]));
  assert.equal(byId.default.distinctDevices,1);
  assert.deepEqual(byId.default.viewers.map(v=>[v.ip,v.hits,v.lastSeen,v.machine]),[['1.1.1.1',5,20,'日本']],'one viewer seen on two machines is one row with summed hits');
  assert.equal(byId.gone.label,'(已删除通道)');
  assert.equal(byId['ch-b'].distinctDevices,0,'a channel nobody used is still listed');
  assert.equal(roster.distinctIps,3);assert.equal(roster.suspicious,false);
  assert.equal(nodeChannels(index,{id:'missing'},new Map(),true).channels.length,0);
});
