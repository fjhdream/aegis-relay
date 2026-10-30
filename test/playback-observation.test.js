import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import zlib from 'node:zlib';
import { PlaybackObservation, observeJson } from '../src/playback-observation.js';
import { SteeringEngine } from '../src/steering.js';
import { SteeringHub } from '../src/steering-hub.js';
import { newRouteAuthKey } from '../src/route-auth.js';

const START=1_000_000_000,MB=1024*1024,k='K'.repeat(22),source='S'.repeat(22);
function fixture(){
  const monitor=new PlaybackObservation();let now=START;
  const send=(event,machine='a')=>monitor.ingest(machine,{k,r:'n1',client:'VidHub',source,at:now,...event},now);
  const progress=(position,extra={})=>send({kind:'progress',phase:'progress',position,paused:false,rate:1,...extra});
  const transfer=(start,duration=5000,machine='b')=>send({kind:'transfer',start,end:start+64*MB-1,bytes:64*MB,requestAt:now-duration},machine);
  const row=()=>monitor.view(now)[0];
  return {monitor,send,progress,transfer,row,setTime:v=>{now=v},advance:ms=>{now+=ms}};
}

test('cached playback advances between bursts and retains cross-request bitrate samples',()=>{
  const f=fixture();f.send({kind:'metadata',bitrate:20e6,unique:true});
  f.progress(0);
  for(let i=0;i<3;i++){f.advance(100000);f.progress((i+1)*100-10);f.advance(10000);f.progress((i+1)*100);f.transfer(i*64*MB)}
  const row=f.row();assert.equal(row.state,'playing');assert.equal(row.machines[0].samples,3);
  assert.equal(row.machines[0].rateBps,Math.round(64*MB/5),'the cache wait is not counted as transfer time');
  assert.equal(row.machines[0].advice,'enough');assert.equal(row.machines[0].id,'b','progress and video may reach different machines');
  f.advance(30000);f.progress(330);assert.equal(f.row().state,'playing','no new video request does not imply a stopped player');
});

test('low transfer rates alone never recommend a switch; fresh repeated stalled progress is also required',()=>{
  const f=fixture();f.send({kind:'metadata',bitrate:20e6,unique:true});
  for(let i=0;i<3;i++){f.advance(100000);f.transfer(i*64*MB,100000)}
  assert.equal(f.row().machines[0].advice,'low_margin');
  f.progress(300);f.advance(10000);f.progress(310);assert.equal(f.row().state,'playing');
  assert.equal(f.row().machines[0].advice,'low_margin');
  for(let i=0;i<7;i++){f.advance(10000);f.progress(310)}
  assert.equal(f.row().state,'possible_stall');assert.equal(f.row().machines[0].advice,'would_switch');
  f.advance(50000);assert.equal(f.row().state,'unknown');assert.equal(f.row().machines[0].advice,'low_margin');
});

test('pause, resume, seek and source changes discard transfer evidence from the previous playback state',()=>{
  const f=fixture();f.progress(10);f.advance(10000);f.transfer(0);f.progress(20);
  f.advance(10000);f.progress(20,{paused:true});assert.equal(f.row().state,'paused');assert.equal(f.row().machines.length,0);
  f.advance(10000);f.transfer(64*MB);assert.equal(f.row().machines.length,0);
  f.progress(20,{paused:false});f.advance(10000);f.transfer(64*MB);assert.equal(f.row().machines.length,1);
  f.advance(10000);f.progress(1000);assert.equal(f.row().state,'seeking');assert.equal(f.row().machines.length,0);
  f.advance(10000);f.transfer(128*MB);f.progress(1010,{source:'T'.repeat(22)});assert.equal(f.row().machines.length,0);
  f.advance(10000);f.progress(null,{phase:'stop'});f.advance(120000);assert.equal(f.row().state,'stopped');
});

test('parallel reads, duplicates and unrelated ranges cannot manufacture a run of slow segments',()=>{
  const f=fixture();f.advance(10000);f.transfer(0);f.transfer(0);assert.equal(f.row().machines[0].samples,1);
  f.advance(1000);f.transfer(64*MB,5000);assert.equal(f.row().machines[0].samples,1,'overlapping prefetch is not serial delivery evidence');
  f.advance(10000);f.transfer(64*MB);assert.equal(f.row().machines[0].samples,2);
  f.advance(10000);f.transfer(500*MB);assert.equal(f.row().machines[0].samples,1,'a seek starts a new request window');
});

test('ambiguous or missing media bitrate stays unknown and old transfer samples cannot recommend switching',()=>{
  const f=fixture();f.send({kind:'metadata',source:'',bitrate:20e6,unique:false});
  for(let i=0;i<3;i++){f.advance(10000);f.transfer(i*64*MB)}
  assert.equal(f.row().machines[0].advice,'missing_bitrate');
  f.send({kind:'metadata',bitrate:20e6,unique:true});assert.equal(f.row().machines[0].advice,'enough');
  f.advance(181000);f.progress(200);assert.equal(f.row().machines[0].advice,'stale');
});

test('malformed observations are rejected before allocating state',()=>{
  const monitor=new PlaybackObservation(),base={k,r:'n1',kind:'transfer',at:START,requestAt:START-1000,start:0,end:MB-1,bytes:MB};
  for(const patch of [{k:'bad'},{source:'token'},{at:START-31*60_000},{at:Infinity},{start:-1},{bytes:1},{end:NaN},{requestAt:START},{kind:'progress',phase:'progress',position:Infinity,paused:false,rate:1},{kind:'metadata',bitrate:'20000',unique:true}])monitor.ingest('a',{...base,...patch},START);
  assert.equal(monitor.sessions.size,0);
  for(let i=0;i<1100;i++)monitor.ingest('a',{...base,k:Buffer.from(String(i).padStart(16,'0')).toString('base64url')},START);
  assert.equal(monitor.sessions.size,1000);
});

test('observation keys correlate progress and media without exposing device, item or source identities',()=>{
  const engine=new SteeringEngine({selfId:'a'}),route={id:'n1',routeAuthKey:newRouteAuthKey()};
  const identity={deviceId:'private-device',mediaSourceId:'private-source',client:'VidHub'};
  const one=engine.observationContext(route,'private-item',{...identity,playSessionId:'session-1'}),two=engine.observationContext(route,'private-item',identity);
  assert.equal(one.k,two.k);assert.match(one.k,/^[\w-]{22}$/);assert.match(one.source,/^[\w-]{22}$/);
  assert.doesNotMatch(JSON.stringify(one),/private|session-1/);
  assert.notEqual(one.k,engine.observationContext(route,'private-item',{...identity,deviceId:'other'}).k);
  assert.equal(engine.observationContext(route,'private-item',{}),null);
});

test('observations are retryable and cannot alter automatic steering decisions',()=>{
  const engine=new SteeringEngine({selfId:'a',clock:()=>START}),hub=new SteeringHub({clock:()=>START,store:{data:{agents:[],deployments:[{agentId:'a',routeId:'n1'}]}}});
  const event={k,r:'n1',client:'VidHub',at:START,kind:'progress',phase:'progress',position:12,paused:false,rate:1};
  engine.observe(event);const batch=engine.syncPayload([]);engine.requeue(batch);
  const retry=engine.syncPayload([]);assert.deepEqual(retry.playbackEvents,[event]);
  hub.exchange('a',retry);assert.equal(hub.view().playback[0].client,'VidHub');assert.equal(hub.sessions.size,0);assert.equal(hub.view().events.length,0);
  hub.exchange('a',{playbackEvents:[{...event,k:'F'.repeat(22),r:'foreign'}]});assert.equal(hub.playback.sessions.size,1);
});

test('JSON observation preserves forwarded bytes, limits compressed expansion and tolerates malformed input',async()=>{
  for(const [body,encoding,expected] of [[Buffer.from('{"PositionTicks":100}'),'identity',1],[zlib.gzipSync('{"PositionTicks":100}'),'gzip',1],[zlib.gzipSync(JSON.stringify({x:'x'.repeat(300000)})),'gzip',0],[Buffer.from('{broken'),'identity',0]]){
    const input=new PassThrough(),output=new PassThrough(),forwarded=[],seen=[];
    output.on('data',chunk=>forwarded.push(chunk));input.pipe(output);
    observeJson(input,{'content-type':'application/json','content-encoding':encoding},value=>seen.push(value));
    const ended=once(output,'end');input.end(body);await ended;
    for(let i=0;i<20&&seen.length<expected;i++)await new Promise(r=>setTimeout(r,5));
    if(encoding!=='identity'&&!expected)await new Promise(r=>setTimeout(r,25));
    assert(Buffer.concat(forwarded).equals(body));assert.equal(seen.length,expected);
  }
});
