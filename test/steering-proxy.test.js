import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { makeProxyHandler } from '../src/proxy.js';
import { SteeringEngine } from '../src/steering.js';
import { SteeringHub } from '../src/steering-hub.js';
import { deriveKey } from '../src/security.js';
import { newRouteAuthKey, ROUTE_AUTH_VERSION, routeTokenDigest } from '../src/route-auth.js';

const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const close=server=>new Promise(resolve=>{server.closeAllConnections?.();server.close(resolve)});
const get=(port,path,headers={})=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path,headers:{'x-forwarded-proto':'https','user-agent':'Infuse-Direct/8.1',...headers}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}))});req.on('error',reject);req.end()});

async function setup() {
  const seen=[];
  const upstream=http.createServer((req,res)=>{
    seen.push(req.url);
    if(req.url.includes('main.m3u8')){const body=zlib.gzipSync('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nhls1/main/0.ts\n');res.writeHead(200,{'content-type':'application/vnd.apple.mpegurl','content-encoding':'gzip','content-length':body.length});return res.end(body);}
    res.writeHead(200,{'content-type':'video/x-matroska','content-length':5});res.end('media');
  });
  const up=await listen(upstream),routeAuthKey=newRouteAuthKey();
  const route={id:'n1',alias:'movie',enabled:true,accessMode:'key',authVersion:ROUTE_AUTH_VERSION,routeAuthKey,keyDigest:routeTokenDigest('key123',routeAuthKey),upstreams:[`http://127.0.0.1:${up}`],allowPrivate:true,
    steering:{mode:'on',peers:[{id:'a',base:'https://a.example.com'},{id:'b',base:'https://b.example.com'}],params:{minRateMbps:0}}};
  const key=deriveKey('s'.repeat(32)),now=()=>Date.now();
  const a=new SteeringEngine({selfId:'a',clock:now}),b=new SteeringEngine({selfId:'b',clock:now});
  const relayA=http.createServer(makeProxyHandler({getRoutes:()=>[route]},key,null,a)),relayB=http.createServer(makeProxyHandler({getRoutes:()=>[route]},key,null,b));
  const portA=await listen(relayA),portB=await listen(relayB);
  return {seen,route,a,b,portA,portB,cleanup:async()=>{a.stop();b.stop();await Promise.all([close(relayA),close(relayB),close(upstream)])}};
}

test('a steered request is redirected to the peer, served there, and the token never reaches Emby',async()=>{
  const {seen,a,portA,portB,cleanup}=await setup();
  try {
    const path='/movie/key123/Videos/abc/stream.mkv?api_key=k%20x&DeviceId=d1&Static=true';
    const first=await get(portA,path);
    assert.equal(first.status,200);assert.equal(first.body.toString(),'media');
    const session=[...a.sessions.values()][0];
    session.scores.a={verdict:'starved_down',rateBps:1e6,at:a.now()};
    a.health.set('b',{healthy:true,at:a.now(),routes:{n1:{line:0,quotaExhausted:false}}});
    const steered=await get(portA,path);
    assert.equal(steered.status,302);assert.equal(steered.headers['cache-control'],'no-store');
    const location=new URL(steered.headers.location);
    assert.equal(location.origin,'https://b.example.com');
    assert.ok(location.search.startsWith('?api_key=k%20x&DeviceId=d1&Static=true&aegis_steer='),'the client query is kept byte-for-byte');
    const landed=await get(portB,`${location.pathname}${location.search}`);
    assert.equal(landed.status,200);assert.equal(landed.body.toString(),'media');
    assert.ok(seen.every(url=>!url.includes('aegis_steer')),'the steering token is stripped before the upstream');
    assert.equal(seen.at(-1),'/Videos/abc/stream.mkv?api_key=k%20x&DeviceId=d1&Static=true');
  } finally { await cleanup(); }
});

test('a VidHub direct-play session appears in the hub before its first speed verdict',async()=>{
  const {route,a,portA,cleanup}=await setup();
  const hub=new SteeringHub({store:{data:{agents:[],deployments:[{agentId:'a',routeId:route.id,enabled:true}]}}});
  try {
    const path='/movie/key123/videos/abc/original.mkv?api_key=test&DeviceId=d1&PlaySessionId=p1';
    const headers={'user-agent':'VidHub/3.0.9','x-emby-authorization':'MediaBrowser Client="VidHub", DeviceId="d1"','x-emby-token':'test',range:'bytes=0-'};
    const response=await get(portA,path,headers);
    assert.equal(response.status,200);
    assert.equal(a.sessions.size,1,'the real VidHub request shape is accepted by the engine');
    hub.exchange('a',a.syncPayload([route]));
    const sessions=hub.view().sessions;
    assert.equal(sessions.length,1,'playback must be visible without waiting for 120 seconds of samples');
    assert.equal(sessions[0].client,'VidHub');
    assert.equal(sessions[0].scores.a.verdict,'unknown');
    assert.equal(hub.view().events.length,0,'announcing playback must not trigger a switch');
    await get(portA,path,headers);
    assert.equal(a.syncPayload([route]).reports.length,0,'repeated requests must not announce the same session again');
  } finally { await cleanup(); }
});

test('Rex custom video paths retain their steering identity through encrypted CDN redirects',async()=>{
  let relayA,relayB,a,b;
  const seen=[];
  const cdn=http.createServer((req,res)=>{
    seen.push(req.headers.range);
    const match=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range||'');
    const start=Number(match?.[1]||0),end=match?.[2]?Number(match[2]):31;
    const body=Buffer.alloc(end-start+1,0x41);
    res.writeHead(206,{'content-type':'video/mp4','content-range':`bytes ${start}-${end}/32`,'content-length':body.length});res.end(body);
  });
  const origin=http.createServer((_req,res)=>{res.writeHead(302,{location:`http://127.0.0.1:${cdn.address().port}/opaque.mp4?sig=private`});res.end()});
  try{
    await listen(cdn);const up=await listen(origin),routeAuthKey=newRouteAuthKey();
    const route={id:'rex',alias:'movie',enabled:true,accessMode:'key',authVersion:ROUTE_AUTH_VERSION,routeAuthKey,keyDigest:routeTokenDigest('key123',routeAuthKey),upstreams:[`http://127.0.0.1:${up}`],allowPrivate:true,
      steering:{mode:'on',peers:[{id:'a',base:'https://a.example.com'},{id:'b',base:'https://b.example.com'}],params:{minRateMbps:0}}};
    a=new SteeringEngine({selfId:'a'});b=new SteeringEngine({selfId:'b'});
    for(const engine of [a,b]){engine.bounded.add('rex');engine.boundBytes=8;}
    relayA=http.createServer(makeProxyHandler({getRoutes:()=>[route]},deriveKey('s'.repeat(32)),null,a));
    relayB=http.createServer(makeProxyHandler({getRoutes:()=>[route]},deriveKey('t'.repeat(32)),null,b));
    const portA=await listen(relayA),portB=await listen(relayB);
    const headers={'user-agent':'Rex-Standard/1.0.2','x-emby-authorization':'MediaBrowser Client="Rex", DeviceId="rex-device"','x-emby-token':'test',range:'bytes=0-'};
    const first=await get(portA,'/movie/key123/emby/play/video/abc?api_key=test&MediaSourceId=source1',headers);
    assert.equal(first.status,302);
    assert.equal(a.sessions.size,1,'the actual Rex video path must establish a steering session');
    const session=[...a.sessions.values()][0],location=new URL(first.headers.location),path=location.pathname+location.search;
    assert(!first.headers.location.includes('private'),'upstream credentials stay encrypted');
    const streamed=await get(portA,path,headers);
    assert.equal(streamed.status,206);assert.equal(streamed.headers['content-range'],'bytes 0-7/32');
    assert.equal(a.sessions.size,1,'the CDN continuation belongs to the original playback');
    await get(portA,path,{...headers,range:'bytes=8-'});
    assert(a.syncPayload([route]).bounds.some(result=>result.client==='Rex'&&result.continued));
    session.scores.a={verdict:'starved_down',rateBps:1,at:a.now()};
    a.health.set('b',{healthy:true,at:a.now(),routes:{rex:{line:0,quotaExhausted:false}}});
    const moved=await get(portA,path,{...headers,range:'bytes=16-'});
    assert.equal(moved.status,302);
    const target=new URL(moved.headers.location);
    assert.equal(target.origin,'https://b.example.com');
    const landed=await get(portB,target.pathname+target.search,{...headers,range:'bytes=16-'});
    assert.equal(landed.status,206);assert.equal(landed.headers['content-range'],'bytes 16-23/32');
    assert.deepEqual(seen,['bytes=0-7','bytes=8-15','bytes=16-23']);
    assert.equal([...b.sessions.values()][0].key,session.key);
    assert.equal(b.syncPayload([route]).landings.length,1);
  }finally{
    a?.stop();b?.stop();
    await Promise.all([relayA&&close(relayA),relayB&&close(relayB),close(origin),close(cdn)]);
  }
});

test('a node without steering still strips a stray steer token and is never redirected',async()=>{
  const {seen,route,portA,cleanup}=await setup();
  try {
    delete route.steering;
    const out=await get(portA,'/movie/key123/Videos/abc/stream.mkv?aegis_steer=abc&DeviceId=d1');
    assert.equal(out.status,200);
    assert.equal(seen.at(-1),'/Videos/abc/stream.mkv?DeviceId=d1');
  } finally { await cleanup(); }
});

test('plain HTTP requests are never steered',async()=>{
  const {a,portA,cleanup}=await setup();
  try {
    const path='/movie/key123/Videos/abc/stream.mkv?DeviceId=d1';
    await get(portA,path);
    const session=[...a.sessions.values()][0];
    session.scores.a={verdict:'starved_down',rateBps:1e6,at:a.now()};
    a.health.set('b',{healthy:true,at:a.now(),routes:{n1:{line:0,quotaExhausted:false}}});
    assert.equal((await get(portA,path,{'x-forwarded-proto':'http'})).status,200);
  } finally { await cleanup(); }
});

test('the HLS segment length is read off a gzip playlist as it passes through',async()=>{
  const {a,portA,cleanup}=await setup();
  try {
    const out=await get(portA,'/movie/key123/Videos/abc/main.m3u8?DeviceId=d1&PlaySessionId=p1');
    assert.equal(out.status,200);
    assert.equal(zlib.gunzipSync(out.body).toString().includes('#EXT-X-TARGETDURATION:6'),true,'the playlist is delivered untouched');
    await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal([...a.sessions.values()][0].segmentSeconds,6);
  } finally { await cleanup(); }
});
