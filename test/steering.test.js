import test from 'node:test';
import assert from 'node:assert/strict';
import { clientPrefix, decide, hlsVerdict, prefixKeyFor, itemOf, openSteerToken, playIdentity, progressiveVerdict, requestKind, sealSteerToken, sessionKeyFor, STEER_DEFAULTS, SteeringEngine, steerTokenOf, stripSteerParam } from '../src/steering.js';
import { newRouteAuthKey } from '../src/route-auth.js';

const route=(extra={})=>({id:'n1',alias:'movie',routeAuthKey:newRouteAuthKey(),steering:{mode:'on',peers:[{id:'a',base:'https://a.example.com'},{id:'b',base:'https://b.example.com'}],params:{minRateMbps:0}},...extra});
const request=(url,headers={})=>({req:{method:'GET',headers:{'user-agent':'ExoPlayerLib/2.18',...headers}},incoming:new URL(url,'http://relay.invalid')});
const found=(r,url)=>{const path=new URL(url,'http://relay.invalid').pathname,rest=path.replace(/^\/movie\/key123/,'');return {route:r,rest,prefix:'/movie/key123'}};
const https={proto:'https',host:'entry.example.com'};
const healthy=(engine,at,ids=['b'],routeId='n1')=>{for(const id of ids)engine.health.set(id,{healthy:true,at,routes:{[routeId]:{line:0,quotaExhausted:false}}})};

test('the steer parameter is removed without touching any other query bytes',()=>{
  assert.equal(stripSteerParam('?api_key=a%20b&aegis_steer=xyz&Static=true'),'?api_key=a%20b&Static=true');
  assert.equal(stripSteerParam('?aegis_steer=xyz'),'');
  assert.equal(stripSteerParam('?a=1+2'),'?a=1+2');
  assert.equal(steerTokenOf('?x=1&aegis_steer=tok-en_1'),'tok-en_1');
  assert.equal(steerTokenOf('?x=1'),'');
});

test('requests are classified so only the stream itself is steered',()=>{
  assert.equal(requestKind('/Videos/abc/master.m3u8'),'manifest');
  assert.equal(requestKind('/videos/abc/hls1/main/12.ts'),'segment');
  assert.equal(requestKind('/Videos/abc/stream.mkv'),'progressive');
  assert.equal(requestKind('/Videos/abc/abc/Subtitles/3/Stream.vtt'),'other');
  assert.equal(requestKind('/LiveTV/LiveStreamFiles/x/stream.ts'),'other');
  assert.equal(itemOf('/emby/Videos/ABC123/stream'),'abc123');
  assert.equal(itemOf('/Items/77/Download'),'77');
  assert.equal(itemOf('/emby/play/video/ABC123'),'abc123');
  assert.equal(itemOf('/play/audio/ABC123/stream'),'abc123');
});

test('session keys are stable per playback, differ per device and need a playback identity',()=>{
  const r=route();
  const one=playIdentity(request('/x?PlaySessionId=p1&DeviceId=d1&MediaSourceId=m').req,request('/x?PlaySessionId=p1&DeviceId=d1&MediaSourceId=m').incoming);
  const same=playIdentity(request('/x?playsessionid=p1&deviceid=d1&mediasourceid=m').req,request('/x?playsessionid=p1&deviceid=d1&mediasourceid=m').incoming);
  const other=playIdentity(request('/x?PlaySessionId=p1&DeviceId=d2&MediaSourceId=m').req,request('/x?PlaySessionId=p1&DeviceId=d2&MediaSourceId=m').incoming);
  const key=sessionKeyFor(r,'abc',one);
  assert.match(key,/^[A-Za-z0-9_-]{22}$/);
  assert.equal(sessionKeyFor(r,'abc',same),key);
  assert.notEqual(sessionKeyFor(r,'abc',other),key);
  assert.notEqual(sessionKeyFor({...r,routeAuthKey:newRouteAuthKey()},'abc',one),key);
  assert.equal(sessionKeyFor(r,'abc',{deviceId:'',playSessionId:'',mediaSourceId:''}),null);
  const viaHeader=playIdentity({headers:{'x-emby-authorization':'MediaBrowser Client="Infuse", DeviceId="dev-9"'}},new URL('http://x/'));
  assert.equal(viaHeader.deviceId,'dev-9');assert.equal(viaHeader.client,'Infuse');
});

test('steer tokens bind the target machine, expire and reject tampering',()=>{
  const r=route(),key=sessionKeyFor(r,'abc',{deviceId:'d',playSessionId:'p',mediaSourceId:''}),now=Date.now();
  const token=sealSteerToken(r,{epoch:7,issuedAtMs:now,target:'b',sessionKey:key});
  assert.equal(token.length,66);
  const opened=openSteerToken(r,token,{self:'b',nowMs:now+1000});
  assert.equal(opened.epoch,7);assert.equal(opened.sessionKey,key);
  assert.equal(openSteerToken(r,token,{self:'c',nowMs:now}),null);
  assert.equal(openSteerToken(r,token,{self:'b',nowMs:now+STEER_DEFAULTS.tokenTtlMs+2000}),null);
  assert.equal(openSteerToken({...r,routeAuthKey:newRouteAuthKey()},token,{self:'b',nowMs:now}),null);
  const bytes=Buffer.from(token,'base64url');bytes[2]^=1;
  assert.equal(openSteerToken(r,bytes.toString('base64url'),{self:'b',nowMs:now}),null);
});

test('HLS verdicts follow the media-time ratio and who held up each segment',()=>{
  const nowMs=100_000,cycles=(cycleMs,upMs)=>Array.from({length:5},(_,i)=>({reqAt:nowMs-15_000+i*1000,cycleMs,upMs,bytes:2_000_000}));
  assert.equal(hlsVerdict(cycles(6000,500),6,{nowMs}).verdict,'ok');
  assert.equal(hlsVerdict(cycles(9000,1000),6,{nowMs}).verdict,'starved_down');
  assert.equal(hlsVerdict(cycles(9000,8000),6,{nowMs}).verdict,'starved_up');
  assert.equal(hlsVerdict(cycles(9000,1000),0,{nowMs}).verdict,'unknown');
  assert.equal(hlsVerdict(cycles(9000,1000).slice(0,3),6,{nowMs}).verdict,'unknown');
  assert.equal(hlsVerdict(cycles(9000,1000),6,{nowMs}).rateBps,Math.round(2_000_000*1000/9000));
});

test('progressive verdicts separate a full buffer, a slow line and a slow origin',()=>{
  const ticks=(n,make)=>Array.from({length:n},(_,i)=>make(i));
  assert.equal(progressiveVerdict(ticks(120,i=>i%10===0?{bytes:0,idle:true,blocked:false}:{bytes:1e6,idle:false,blocked:true})).verdict,'ok');
  assert.equal(progressiveVerdict(ticks(120,()=>({bytes:5e5,idle:false,blocked:true}))).verdict,'starved_down');
  assert.equal(progressiveVerdict(ticks(120,()=>({bytes:5e5,idle:false,blocked:false}))).verdict,'starved_up');
  assert.equal(progressiveVerdict(ticks(60,()=>({bytes:5e5,idle:false,blocked:true}))).verdict,'unknown');
  // a floor the operator set: a line that is "slow" for the player but above the floor is fine
  assert.equal(progressiveVerdict(ticks(120,()=>({bytes:5e6,idle:false,blocked:true})),{minRateMbps:20}).verdict,'ok');
});

test('decide only moves a starving session, respects dwell, budget, margin and the penalty box',()=>{
  const nowMs=10_000_000,candidates=new Map([['a',{eligible:true}],['b',{eligible:true}],['c',{eligible:true}]]);
  const base=()=>({assigned:'',lastSwitchAt:0,switches:[],tried:{},scores:{a:{verdict:'starved_down',rateBps:1e6,at:nowMs-1000}}});
  // healthy current line: stay
  assert.equal(decide({...base(),scores:{a:{verdict:'ok',rateBps:1e6,at:nowMs}}},{self:'a',nowMs,candidates}).changed,false);
  // stale verdict: stay
  assert.equal(decide({...base(),scores:{a:{verdict:'starved_down',rateBps:1e6,at:nowMs-120_000}}},{self:'a',nowMs,candidates}).changed,false);
  // unknown peers: explore the least recently tried
  const explore=decide({...base(),tried:{b:nowMs-5000,c:nowMs-900_000}},{self:'a',nowMs,candidates});
  assert.deepEqual([explore.target,explore.reason],['c','explore']);
  // a known faster peer wins, a known but not much faster one is not explored
  const better=decide({...base(),scores:{...base().scores,b:{verdict:'ok',rateBps:3e6,at:nowMs-60_000},c:{verdict:'ok',rateBps:1.1e6,at:nowMs-60_000}}},{self:'a',nowMs,candidates});
  assert.deepEqual([better.target,better.reason],['b','better_line']);
  assert.equal(decide({...base(),scores:{...base().scores,b:{verdict:'ok',rateBps:1.1e6,at:nowMs},c:{verdict:'starved_down',rateBps:0,at:nowMs-60_000}}},{self:'a',nowMs,candidates}).changed,false);
  // dwell and switch budget
  assert.equal(decide({...base(),lastSwitchAt:nowMs-60_000},{self:'a',nowMs,candidates}).changed,false);
  assert.equal(decide({...base(),switches:[nowMs-500_000,nowMs-400_000,nowMs-300_000]},{self:'a',nowMs,candidates}).changed,false);
  // an assigned target that went unhealthy is released back to the machine holding the request
  const released=decide({...base(),assigned:'b'},{self:'a',nowMs,candidates:new Map([['a',{eligible:true}],['b',{eligible:false}]])});
  assert.deepEqual([released.target,released.assigned,released.reason],['a','','target_unavailable']);
  // the penalty box expires, so a line that recovered becomes a candidate again
  const recovered=decide({...base(),scores:{...base().scores,b:{verdict:'starved_down',rateBps:0,at:nowMs-700_000}},tried:{c:nowMs}},{self:'a',nowMs,candidates});
  assert.equal(recovered.target,'b');
});

test('engine redirects a starving session to a healthy peer with a token, and the peer serves it',()=>{
  let clock=1_000_000_000;
  const r=route(),a=new SteeringEngine({selfId:'a',clock:()=>clock}),b=new SteeringEngine({selfId:'b',clock:()=>clock});
  const url='/movie/key123/Videos/abc/stream.mkv?api_key=k&DeviceId=d1&PlaySessionId=p1';
  const first=request(url),plan=a.plan({route:r,found:found(r,url),req:first.req,incoming:first.incoming,publicContext:https});
  assert.ok(plan.track&&!plan.redirect);
  const session=[...a.sessions.values()][0];
  session.scores.a={verdict:'starved_down',rateBps:1e6,at:clock};
  healthy(a,clock);
  const second=request(`${url}&aegis_steer=stale`),out=a.plan({route:r,found:found(r,url),req:second.req,incoming:second.incoming,publicContext:https});
  assert.ok(out.redirect.startsWith('https://b.example.com/movie/key123/Videos/abc/stream.mkv?api_key=k&DeviceId=d1&PlaySessionId=p1&aegis_steer='));
  assert.equal((out.redirect.match(/aegis_steer=/g)||[]).length,1);
  assert.equal(session.assigned,'b');assert.equal(session.epoch,1);
  assert.equal(a.decisions.length,1);assert.equal(a.decisions[0].reason,'explore');
  // the peer must serve a request it was steered to, even though it knows nothing yet
  const landed=new URL(out.redirect),third={req:{method:'GET',headers:{'user-agent':'ExoPlayerLib/2.18'}},incoming:new URL(`http://relay.invalid${landed.pathname}${landed.search}`)};
  const atB=b.plan({route:r,found:found(r,landed.pathname),req:third.req,incoming:third.incoming,publicContext:https});
  assert.ok(atB.track&&!atB.redirect);
  assert.equal(b.landings.length,1);assert.equal(b.landings[0].epoch,1);
  a.stop();b.stop();
});

test('shadow mode records what it would do and never redirects',()=>{
  const clock=2_000_000_000,r=route({steering:{...route().steering,mode:'shadow'}}),a=new SteeringEngine({selfId:'a',clock:()=>clock});
  const url='/movie/key123/Videos/abc/stream.mkv?DeviceId=d1';
  const call=()=>{const q=request(url);return a.plan({route:r,found:found(r,url),req:q.req,incoming:q.incoming,publicContext:https})};
  call();
  const session=[...a.sessions.values()][0];session.scores.a={verdict:'starved_down',rateBps:1e6,at:clock};healthy(a,clock);
  const out=call();
  assert.ok(out.track&&!out.redirect);
  assert.equal(a.shadow.length,1);assert.equal(a.shadow[0].to,'b');
  assert.equal(session.assigned,'');
  call();assert.equal(a.shadow.length,1,'dwell keeps the shadow log from repeating');
  a.stop();
});

test('steering never applies to plain HTTP, browsers, excluded clients, other methods or side files',()=>{
  const clock=3_000_000_000,r=route(),a=new SteeringEngine({selfId:'a',clock:()=>clock});
  const url='/movie/key123/Videos/abc/stream.mkv?DeviceId=d1';
  const plan=(headers={},ctx=https,method='GET',path=url)=>{const q=request(path,headers);q.req.method=method;return a.plan({route:r,found:found(r,path),req:q.req,incoming:q.incoming,publicContext:ctx})};
  assert.equal(plan({}, {proto:'http',host:'x'}),null);
  assert.equal(plan({'user-agent':'Mozilla/5.0 (Windows NT 10.0) Chrome/122'}),null);
  assert.equal(plan({authorization:'MediaBrowser Token="x"'}),null);
  assert.equal(plan({},https,'HEAD'),null);
  assert.equal(plan({},https,'GET','/movie/key123/Videos/abc/abc/Subtitles/1/Stream.vtt?DeviceId=d1'),null);
  a.excluded=new Set(['vlc']);
  assert.equal(plan({'x-emby-client':'VLC'}),null);
  assert.equal(a.plan({route:{...r,steering:undefined},found:found(r,url),req:request(url).req,incoming:request(url).incoming,publicContext:https}),null);
  a.stop();
});

test('a peer that is unhealthy, stale, on another upstream line or out of quota is never a target',()=>{
  let clock=4_000_000_000;
  const r=route(),a=new SteeringEngine({selfId:'a',clock:()=>clock});
  const eligible=()=>a.candidatesFor(r,clock).get('b').eligible;
  assert.equal(eligible(),false);
  healthy(a,clock);assert.equal(eligible(),true);
  clock+=STEER_DEFAULTS.peerStaleMs+1;assert.equal(eligible(),false);
  healthy(a,clock);a.health.get('b').routes.n1.line=1;assert.equal(eligible(),false);
  healthy(a,clock);a.health.get('b').routes.n1.quotaExhausted=true;assert.equal(eligible(),false);
  healthy(a,clock);a.health.get('b').healthy=false;assert.equal(eligible(),false);
  a.stop();
});

test('a redirect that never lands releases the session and penalises the target',()=>{
  let clock=5_000_000_000;
  const r=route(),a=new SteeringEngine({selfId:'a',clock:()=>clock});
  const url='/movie/key123/Videos/abc/stream.mkv?DeviceId=d1',call=()=>{const q=request(url);return a.plan({route:r,found:found(r,url),req:q.req,incoming:q.incoming,publicContext:https})};
  call();const session=[...a.sessions.values()][0];
  session.scores.a={verdict:'starved_down',rateBps:1e6,at:clock};healthy(a,clock);
  assert.ok(call().redirect);
  clock+=STEER_DEFAULTS.landingTimeoutMs+1000;healthy(a,clock);
  const after=call();
  assert.ok(after.track,'served locally after the failed hop');
  assert.equal(session.assigned,'');assert.equal(session.scores.b.verdict,'starved_down');
  assert.equal(a.failures.length,1);assert.equal(a.failures[0].target,'b');
  a.stop();
});

test('a confirmed landing keeps the assignment, and the panel wins a same-epoch conflict',()=>{
  let clock=6_000_000_000;
  const r=route(),a=new SteeringEngine({selfId:'a',clock:()=>clock});
  const url='/movie/key123/Videos/abc/stream.mkv?DeviceId=d1',call=()=>{const q=request(url);return a.plan({route:r,found:found(r,url),req:q.req,incoming:q.incoming,publicContext:https})};
  call();const session=[...a.sessions.values()][0];
  session.scores.a={verdict:'starved_down',rateBps:1e6,at:clock};healthy(a,clock);
  call();
  a.applySync({serverTime:clock,cursor:5,sessions:[{s:session.key,r:'n1',assigned:'b',epoch:1,lastLanding:{epoch:1,at:clock+10},scores:{b:{verdict:'ok',rateBps:4e6,at:clock+10}}}],peers:[{id:'b',healthy:true,at:clock,routes:{n1:{line:0,quotaExhausted:false}}}]});
  clock+=STEER_DEFAULTS.landingTimeoutMs+1000;
  a.applySync({serverTime:clock,peers:[{id:'b',healthy:true,at:clock,routes:{n1:{line:0,quotaExhausted:false}}}]});
  assert.ok(call().redirect,'still steered: the landing was confirmed');
  assert.equal(a.failures.length,0);
  assert.equal(a.cursor,5);assert.equal(session.scores.b.rateBps,4e6);
  // same epoch, different choice: the panel's choice is authoritative
  a.applySync({sessions:[{s:session.key,r:'n1',assigned:'a',epoch:1}]});
  assert.equal(session.assigned,'a');
  // an older epoch is ignored
  a.applySync({sessions:[{s:session.key,r:'n1',assigned:'b',epoch:0}]});
  assert.equal(session.assigned,'a');
  a.stop();
});

test('HLS segments are judged by the client request cadence, even on long segments',()=>{
  let clock=7_000_000_000;
  const r=route(),a=new SteeringEngine({selfId:'a',clock:()=>clock});
  const segment=n=>{const url=`/movie/key123/videos/abc/hls1/main/${n}.ts?DeviceId=d1`,q=request(url);return a.plan({route:r,found:found(r,url),req:q.req,incoming:q.incoming,publicContext:https})};
  const session=()=>[...a.sessions.values()][0];
  for(let n=0;n<6;n++){const plan=segment(n);plan.track.headers();clock+=300;plan.track.bytes(2_000_000);plan.track.close();clock+=8700;}
  session().segmentSeconds=6;
  segment(6);
  assert.equal(session().scores.a.verdict,'starved_down');
  a.stop();
});

test('bounded ranges are only applied to opted-in clients in active mode',()=>{
  const clock=8_000_000_000,r=route(),a=new SteeringEngine({selfId:'a',clock:()=>clock});
  const url='/movie/key123/Videos/abc/stream.mkv?DeviceId=d1';
  const call=headers=>{const q=request(url,headers);return a.plan({route:r,found:found(r,url),req:q.req,incoming:q.incoming,publicContext:https})};
  assert.equal(call({range:'bytes=100-','x-emby-client':'Infuse'}).range,null);
  a.bounded=new Set(['infuse']);a.boundBytes=1024*1024;
  assert.equal(call({range:'bytes=100-','x-emby-client':'Infuse'}).range,`bytes=100-${100+1024*1024-1}`);
  assert.equal(call({range:'bytes=100-200','x-emby-client':'Infuse'}).range,null);
  a.stop();
});

test('client networks are reduced to a /24 or /48 and only ever leave as a per-node digest',()=>{
  assert.equal(clientPrefix('203.0.113.77'),'203.0.113.0/24');
  assert.equal(clientPrefix('::ffff:203.0.113.77'),'203.0.113.0/24');
  assert.equal(clientPrefix('2001:db8:abcd:12::1'),'2001:db8:abcd::/48');
  assert.equal(clientPrefix('2001:db8::1'),'2001:db8:0::/48');
  assert.equal(clientPrefix('not-an-ip'),'');
  const r=route(),key=prefixKeyFor(r,'203.0.113.5');
  assert.match(key,/^[A-Za-z0-9_-]{16}$/);
  assert.equal(prefixKeyFor(r,'203.0.113.200'),key,'same /24');
  assert.notEqual(prefixKeyFor(r,'203.0.114.5'),key);
  assert.notEqual(prefixKeyFor({...r,routeAuthKey:newRouteAuthKey()},'203.0.113.5'),key,'keyed per node');
});

test('history moves a fresh session off a machine its network keeps starving on, and ranks untested machines',()=>{
  const nowMs=20_000_000,candidates=new Map([['a',{eligible:true}],['b',{eligible:true}],['c',{eligible:true}]]);
  const prior={a:{ok:0.1,n:5},b:{ok:0.9,n:4},c:{ok:0.5,n:6}};
  const fresh=decide({assigned:'',lastSwitchAt:0,switches:[],tried:{},scores:{},prior},{self:'a',nowMs,candidates});
  assert.deepEqual([fresh.target,fresh.reason,fresh.switched],['b','history',true]);
  // not once it is measured fine here, not after it already moved, not on thin evidence
  assert.equal(decide({assigned:'',lastSwitchAt:0,switches:[],tried:{},scores:{a:{verdict:'ok',rateBps:1,at:nowMs}},prior},{self:'a',nowMs,candidates}).changed,false);
  assert.equal(decide({assigned:'',lastSwitchAt:nowMs-900_000,switches:[],tried:{},scores:{},prior},{self:'a',nowMs,candidates}).changed,false);
  assert.equal(decide({assigned:'',lastSwitchAt:0,switches:[],tried:{},scores:{},prior:{a:{ok:0.1,n:2},b:{ok:1,n:9}}},{self:'a',nowMs,candidates}).changed,false);
  assert.equal(decide({assigned:'',lastSwitchAt:0,switches:[],tried:{},scores:{},prior:{a:{ok:0.1,n:5},b:{ok:0.6,n:9}}},{self:'a',nowMs,candidates}).changed,false,'no clearly better machine');
  // starving with nothing measured elsewhere: the machine this network did best on goes first
  const starving={assigned:'',lastSwitchAt:0,switches:[],tried:{b:nowMs-900_000,c:nowMs-950_000},scores:{a:{verdict:'starved_down',rateBps:1e6,at:nowMs}},prior:{b:{ok:0.8,n:5}}};
  assert.deepEqual([decide(starving,{self:'a',nowMs,candidates}).target,decide({...starving,prior:{}},{self:'a',nowMs,candidates}).target],['b','c']);
});

test('the engine reports the client network digest and adopts the panel history for a session',()=>{
  const clock=9_000_000_000,r=route(),a=new SteeringEngine({selfId:'a',clock:()=>clock});
  const url='/movie/key123/Videos/abc/stream.mkv?DeviceId=d1&PlaySessionId=p1',q=request(url,{'x-real-ip':'198.51.100.9'});
  a.plan({route:r,found:found(r,url),req:q.req,incoming:q.incoming,publicContext:https});
  const session=[...a.sessions.values()][0],report=a.syncPayload([r]).reports[0];
  assert.equal(report.p,prefixKeyFor(r,'198.51.100.1'));
  a.applySync({sessions:[{s:session.key,r:'n1',epoch:0,assigned:'',prior:{a:{ok:0.1,n:4},b:{ok:0.95,n:4},x:{ok:7,n:1}}}]});
  assert.deepEqual(session.prior,{a:{ok:0.1,n:4},b:{ok:0.95,n:4}});
  healthy(a,clock);
  const next=a.plan({route:r,found:found(r,url),req:q.req,incoming:q.incoming,publicContext:https});
  assert.ok(next.redirect.startsWith('https://b.example.com/'));
  assert.equal(a.decisions.at(-1).reason,'history');
  a.stop();
});

test('a capped range is judged by whether the player comes back for the next byte',()=>{
  let clock=10_000_000_000;
  const r=route(),a=new SteeringEngine({selfId:'a',clock:()=>clock});a.bounded=new Set(['infuse']);a.boundBytes=1000;
  const url='/movie/key123/Videos/abc/stream.mkv?DeviceId=d1&PlaySessionId=p1';
  const call=(range,client='Infuse',key='d1')=>{const u=url.replace('d1',key),q=request(u,{range,'x-emby-client':client});return a.plan({route:r,found:found(r,u),req:q.req,incoming:q.incoming,publicContext:https})};
  const serve=(plan,{status=206,contentRange='bytes 0-999/50000',sent=1000}={})=>{plan.track.headers(status,{'content-range':contentRange});plan.track.bytes(sent);plan.track.close()};
  serve(call('bytes=0-'));
  assert.equal(a.bounds.length,0,'waiting for the player');
  call('bytes=1000-');
  assert.deepEqual(a.bounds.map(item=>[item.client,item.continued,item.trial]),[['Infuse',true,false]]);
  // the player never comes back
  serve(call('bytes=0-',undefined,'d2'));clock+=31_000;a.tick();
  assert.deepEqual(a.bounds.map(item=>item.continued),[true,false]);
  // nothing was cut (end of file, origin ignored Range, client left early): no verdict at all
  serve(call('bytes=0-',undefined,'d3'),{contentRange:'bytes 0-999/1000'});
  serve(call('bytes=0-',undefined,'d4'),{status:200,contentRange:''});
  serve(call('bytes=0-',undefined,'d5'),{sent:10});
  clock+=31_000;a.tick();
  assert.equal(a.bounds.length,2);
  a.stop();
});

test('a client on trial gets one capped range per session and one session at a time',()=>{
  let clock=11_000_000_000;
  const r=route(),a=new SteeringEngine({selfId:'a',clock:()=>clock});a.trials=new Set(['vlc']);a.boundBytes=1000;
  const url='/movie/key123/Videos/abc/stream.mkv?DeviceId=d1&PlaySessionId=p1';
  const call=(key,range='bytes=0-')=>{const u=url.replace('d1',key),q=request(u,{range,'x-emby-client':'VLC'});return a.plan({route:r,found:found(r,u),req:q.req,incoming:q.incoming,publicContext:https})};
  const first=call('d1');
  assert.equal(first.range,'bytes=0-999');
  assert.equal(call('d2').range,null,'another session waits for the running trial');
  first.track.headers(206,{'content-range':'bytes 0-999/9999'});first.track.bytes(1000);first.track.close();
  call('d1','bytes=1000-');
  assert.deepEqual(a.bounds.map(item=>[item.continued,item.trial]),[[true,true]]);
  assert.equal(call('d1','bytes=5000-').range,null,'one trial per session');
  assert.equal(call('d2').range,'bytes=0-999','the next session may try');
  a.stop();
});
