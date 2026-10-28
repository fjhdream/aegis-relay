import test from 'node:test';import assert from 'node:assert/strict';
import {Metrics,ThrottleTransform,summarizeViewers} from '../src/metrics.js';

test('recordAccess folds repeat requests per viewer and counts distinct IPs/devices',()=>{
  const store={data:{},save(){}},metrics=new Metrics(store),route={id:'v1',alias:'v1'};
  // same IP + device three times -> one entry, hits=3
  for(let i=0;i<3;i++)metrics.recordAccess(route,{ip:'1.1.1.1',deviceId:'dev-a',deviceName:'iPhone',client:'Emby'});
  // same IP, different device -> distinct device; different IP -> distinct IP
  metrics.recordAccess(route,{ip:'1.1.1.1',deviceId:'dev-b',client:'Web'});
  metrics.recordAccess(route,{ip:'2.2.2.2',deviceId:'dev-a'});
  const node=metrics.snapshot([route]).nodes[0];
  assert.equal(node.distinctIps,2);
  assert.equal(node.distinctDevices,2);
  const a=node.viewers.find(v=>v.ip==='1.1.1.1'&&v.deviceId==='dev-a');
  assert.equal(a.hits,3);assert.equal(a.deviceName,'iPhone');
  assert.equal(summarizeViewers({}).distinctIps,0);
});

test('a single device on many dynamic IPs stays one device (no false shared-relay signal)',()=>{
  const store={data:{},save(){}},metrics=new Metrics(store),route={id:'dyn',alias:'dyn'};
  for(let i=0;i<12;i++)metrics.recordAccess(route,{ip:`100.64.0.${i}`,deviceId:'phone-1',deviceName:'My Phone',client:'Emby'});
  const node=metrics.snapshot([route]).nodes[0];
  assert.equal(node.distinctDevices,1); // one physical device despite 12 IPs — the alert metric
  assert.equal(node.distinctIps,12);    // dynamic IPs are informational only
});

test('metrics account for requests, playback and quota',()=>{const store={data:{},save(){}};const metrics=new Metrics(store),route={id:'n1',alias:'home',monthlyQuotaGB:0.0000001};const done=metrics.begin(route,{playback:true,bytesIn:12});done(200,120,false);const view=metrics.snapshot([route]),node=view.nodes[0];assert.equal(node.requests,1);assert.equal(node.playbackRequests,1);assert.equal(node.bytesIn,12);assert.equal(node.bytesOut,120);assert.equal(metrics.canServe(route),false)});
test('zero-rate transform counts bytes without delaying',async()=>{const t=new ThrottleTransform(0),chunks=[];t.on('data',c=>chunks.push(c));t.end(Buffer.from('hello'));await new Promise(r=>t.on('end',r));assert.equal(t.bytes,5);assert.equal(Buffer.concat(chunks).toString(),'hello')});
test('streaming traffic is visible before a long response finishes',async()=>{const store={data:{},save(){}},metrics=new Metrics(store),route={id:'stream',alias:'stream'},done=metrics.begin(route,{playback:true}),transform=new ThrottleTransform(0,bytes=>done.addBytes(bytes));transform.resume();transform.write(Buffer.alloc(4096));assert.equal(metrics.snapshot([route]).totalBytes,4096);assert.equal(metrics.snapshot([route]).active,1);transform.end();await new Promise(resolve=>transform.on('end',resolve));done(200,0,false);assert.equal(metrics.snapshot([route]).active,0);assert.equal(metrics.snapshot([route]).totalBytes,4096)});
test('hot-path byte accounting performs no clock or daily-map churn per chunk',()=>{const store={data:{},save(){}},metrics=new Metrics(store),route={id:'fast',alias:'fast'},done=metrics.begin(route,{playback:true}),daily=store.data.metrics.daily,key=Object.keys(daily)[0];for(let i=0;i<10_000;i++)done.addBytes(64*1024);done(206,0,false);assert.equal(metrics.snapshot([route]).totalBytes,10_000*64*1024);assert.equal(daily[key],10_000*64*1024);assert.equal(Object.keys(daily).length,1)});
test('deleting a node drops its counters from the store and active table',()=>{
  const store={data:{},save(){}},metrics=new Metrics(store);
  const keep={id:'keep',alias:'keep'},gone={id:'gone',alias:'gone'};
  metrics.begin(keep)(200,10,false);metrics.begin(gone)(200,10,false);
  metrics.drop('gone');
  assert.deepEqual(Object.keys(store.data.metrics.routes),['keep']);
  metrics.begin(keep);
  metrics.retainOnly(['keep']);
  assert.equal(metrics.snapshot([keep]).active,1);
  metrics.retainOnly([]);
  assert.deepEqual(Object.keys(store.data.metrics.routes),[]);
  assert.equal(metrics.active.size,0);
});

test('the viewer roster is trimmed at the same point with a running count as with a recount',()=>{
  const store={data:{},save(){}},metrics=new Metrics(store),route={id:'roster',alias:'roster'};
  const roster=()=>Object.keys(store.data.metrics.routes.roster.viewers).length;
  for(let i=0;i<232;i++)metrics.recordAccess(route,{ip:`10.0.${i>>8}.${i&255}`,deviceId:`d${i}`});
  assert.equal(roster(),232,'up to 32 over the cap is tolerated before an amortized prune');
  metrics.recordAccess(route,{ip:'10.0.0.0',deviceId:'d0'});
  assert.equal(roster(),232,'a repeat viewer never grows the roster');
  metrics.recordAccess(route,{ip:'10.9.9.9',deviceId:'new'});
  assert.equal(roster(),200,'the first new viewer past the slack trims to the cap');
  for(let i=0;i<32;i++)metrics.recordAccess(route,{ip:`10.1.0.${i}`,deviceId:`e${i}`});
  assert.equal(roster(),232);
  metrics.snapshot([route]); // expiry pass: nothing is old enough, but the count must stay right after it
  metrics.recordAccess(route,{ip:'10.2.0.1',deviceId:'f1'});
  assert.equal(roster(),200);
});

test('a roster loaded from disk above the slack is trimmed on its first access, as before',()=>{
  const now=Date.now(),viewers={};
  for(let i=0;i<300;i++)viewers[`10.3.${i>>8}.${i&255} d${i} default`]={ip:`10.3.${i>>8}.${i&255}`,deviceId:`d${i}`,channelId:'default',firstSeen:now-i,lastSeen:now-i,hits:1};
  const store={data:{metrics:{startedAt:new Date().toISOString(),daily:{},routes:{disk:{requests:0,playbackRequests:0,errors:0,bytesIn:0,bytesOut:0,month:new Date().toISOString().slice(0,7),monthBytes:0,viewers}}}},save(){}};
  const metrics=new Metrics(store),route={id:'disk',alias:'disk'};
  metrics.recordAccess(route,{ip:'10.3.0.0',deviceId:'d0'});
  assert.equal(Object.keys(viewers).length,200);
  assert.ok(viewers['10.3.0.0 d0 default'],'the most recent viewers are the ones kept');
});
