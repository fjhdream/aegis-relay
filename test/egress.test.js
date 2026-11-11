import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { handleUpgrade, makeProxyHandler } from '../src/proxy.js';
import { SteeringEngine, egressToken, relayedEgress, EGRESS_HEADER, EGRESS_HOST_HEADER } from '../src/steering.js';
import { deriveKey } from '../src/security.js';
import { newRouteAuthKey, ROUTE_AUTH_VERSION, routeTokenDigest } from '../src/route-auth.js';

const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const close=server=>new Promise(resolve=>{server.closeAllConnections?.();server.close(resolve)});
const get=(port,path,headers={})=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path,headers:{host:'b.example.com','x-forwarded-proto':'https','user-agent':'Infuse-Direct/8.1',...headers}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}))});req.on('error',reject);req.end()});

test('relay proofs are bound to the node key and expire within minutes',()=>{
  const route={routeAuthKey:newRouteAuthKey()},now=Date.parse('2026-10-29T10:00:30Z'),token=egressToken(route,now);
  assert.match(token,/^[A-Za-z0-9_-]{22}$/);
  const headers=extra=>({[EGRESS_HEADER]:token,[EGRESS_HOST_HEADER]:'Entry.Example.com',...extra});
  assert.deepEqual(relayedEgress(route,headers(),now),{host:'entry.example.com',proto:'https'});
  assert.deepEqual(relayedEgress(route,headers(),now+120_000),{host:'entry.example.com',proto:'https'},'a little clock drift is fine');
  assert.equal(relayedEgress(route,headers(),now+4*60_000),null);
  assert.equal(relayedEgress({routeAuthKey:newRouteAuthKey()},headers(),now),null,'another node key');
  assert.equal(relayedEgress(route,headers({[EGRESS_HOST_HEADER]:'evil.example.com/x'}),now),null);
  assert.equal(relayedEgress(route,headers({[EGRESS_HEADER]:''}),now),null);
  assert.equal(relayedEgress({},headers(),now),null,'no node key, no relaying');
  // The client's scheme rides in the standard Forwarded header (see EGRESS_PROTO_HEADER); the name is
  // spelled out here on purpose, since older machines stay compatible only because they strip exactly
  // that header. Anything but what a relaying machine sends keeps the answer HTTPS, as it always was.
  assert.deepEqual(relayedEgress(route,headers({forwarded:'proto=http'}),now),{host:'entry.example.com',proto:'http'});
  assert.deepEqual(relayedEgress(route,headers({forwarded:'proto=https'}),now),{host:'entry.example.com',proto:'https'});
  for(const forwarded of ['','http','proto=HTTP','proto=ftp','for=198.51.100.7;proto=http','proto=http, proto=https'])assert.deepEqual(relayedEgress(route,headers({forwarded}),now),{host:'entry.example.com',proto:'https'},forwarded);
  assert.equal(relayedEgress(route,headers({[EGRESS_HEADER]:'A'.repeat(22),forwarded:'proto=http'}),now),null,'no proof, no scheme');
});

async function setup() {
  const seen=[];
  const external=http.createServer((req,res)=>{seen.push({at:'external',url:req.url});res.end('external-body')});
  const portX=await listen(external);
  const upstream=http.createServer((req,res)=>{
    seen.push({at:'emby',url:req.url,headers:req.headers});
    if(req.url==='/web')return res.writeHead(302,{location:`http://127.0.0.1:${upstream.address().port}/web/index.html`}).end();
    if(req.url==='/away')return res.writeHead(302,{location:`http://127.0.0.1:${portX}/file`}).end();
    if(req.url.startsWith('/Videos/'))return res.writeHead(200,{'content-type':'video/mp4','content-length':5}).end('media');
    if(req.url.startsWith('/Items/'))return res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({url:'https://vod.example.com/v/1.mp4',live:'wss://vod.example.com/live'}));
    res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true}');
  });
  upstream.on('upgrade',(req,socket)=>{seen.push({at:'emby-ws',url:req.url,headers:req.headers});socket.end('HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: websocket\r\n\r\n')});
  const up=await listen(upstream),routeAuthKey=newRouteAuthKey();
  const base={id:'n1',alias:'movie',enabled:true,accessMode:'key',authVersion:ROUTE_AUTH_VERSION,routeAuthKey,keyDigest:routeTokenDigest('key123',routeAuthKey),upstreams:[`http://127.0.0.1:${up}`],allowPrivate:true,clientProfile:{enabled:true,userAgent:'Profile/1.0'},streamRewrite:{enabled:true,domains:['vod.example.com']}};
  // A is the egress machine; B relays through it. Different master keys: B never has to read A's links.
  const counts={a:0,b:0},a=new SteeringEngine({selfId:'a'}),b=new SteeringEngine({selfId:'b'}),keyA=deriveKey('a'.repeat(32)),keyB=deriveKey('b'.repeat(32));
  const handlerA=makeProxyHandler({getRoutes:()=>[base]},keyA,null,a);
  const relayA=http.createServer((req,res)=>{counts.a++;handlerA(req,res)}),portA=await listen(relayA);
  relayA.on('upgrade',(req,socket,head)=>handleUpgrade(req,socket,head,{getRoutes:()=>[base]},keyA));
  const routeB={...base,egress:{id:'a',base:`http://127.0.0.1:${portA}`}};
  const handlerB=makeProxyHandler({getRoutes:()=>[routeB]},keyB,null,b);
  const relayB=http.createServer((req,res)=>{counts.b++;handlerB(req,res)}),portB=await listen(relayB);
  relayB.on('upgrade',(req,socket,head)=>handleUpgrade(req,socket,head,{getRoutes:()=>[routeB]},keyB));
  return {seen,counts,portA,portB,up,route:base,cleanup:async()=>{a.stop();b.stop();await Promise.all([relayA,relayB,upstream,external].map(close))}};
}
// The links a client gets back, all built by the machine that reaches the upstream (the egress machine,
// for B): the upstream's own redirect, a sealed redirect elsewhere (followed back through the machine
// the client talks to), and the stream
// URLs rewritten in an API body; plus what the upstream itself was told about the public side.
async function linksVia(port,headers,seen) {
  const web=(await get(port,'/movie/key123/web',headers)).headers.location;
  const away=new URL((await get(port,'/movie/key123/away',headers)).headers.location);
  const followed=(await get(port,`${away.pathname}${away.search}`,{...headers,host:away.host,'x-forwarded-proto':away.protocol.slice(0,-1)})).body;
  const info=await get(port,'/movie/key123/Items/1/PlaybackInfo',headers),emby=seen.filter(item=>item.at==='emby').at(-1).headers;
  return {web,away:`${away.protocol}//${away.host}`,followed,info:JSON.parse(info.body),told:[emby['x-forwarded-proto'],emby['x-forwarded-host']],leaked:Object.keys(emby).filter(name=>name==='forwarded'||name.startsWith('x-aegis-'))};
}
const upgrade=(port,headers)=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path:'/movie/key123/socket',headers:{connection:'Upgrade',upgrade:'websocket',...headers}});req.on('upgrade',(res,socket)=>{socket.destroy();resolve(res.statusCode)});req.on('response',res=>{res.resume();reject(new Error(`no upgrade: ${res.statusCode}`))});req.on('error',reject);req.end()});

test('a node with an egress machine reaches the upstream only through it, and its links lead back to the client host',async()=>{
  const {seen,counts,portA,portB,up,cleanup}=await setup();
  try {
    const info=await get(portB,'/movie/key123/System/Info?api_key=x');
    assert.equal(info.status,200);assert.equal(info.body,'{"ok":true}');
    assert.deepEqual([counts.b,counts.a],[1,1],'the request went B -> A -> upstream');
    const emby=seen.find(item=>item.at==='emby');
    assert.equal(emby.url,'/System/Info?api_key=x');
    assert.equal(emby.headers['x-forwarded-host'],'b.example.com','the upstream builds links for the host the client used');
    assert.equal(emby.headers[EGRESS_HEADER],undefined);assert.equal(emby.headers[EGRESS_HOST_HEADER],undefined);
    assert.equal(emby.headers['user-agent'],'Profile/1.0','the client profile is applied once, at the egress');
    // A redirect inside the upstream is rewritten by A for B's host and passed through B untouched.
    const web=await get(portB,'/movie/key123/web');
    assert.equal(web.status,302);assert.equal(web.headers.location,'https://b.example.com/movie/key123/web/index.html');
    // A redirect elsewhere is sealed by A; B relays the sealed link without being able to read it.
    const away=await get(portB,'/movie/key123/away');
    assert.equal(away.status,302);
    const sealed=new URL(away.headers.location);
    assert.equal(sealed.host,'b.example.com');assert.match(sealed.pathname,/^\/movie\/key123\/\.aegis-relay\//);
    const followed=await get(portB,`${sealed.pathname}${sealed.search}`);
    assert.equal(followed.status,200);assert.equal(followed.body,'external-body');
    // Media streams the same way.
    assert.equal((await get(portB,'/movie/key123/Videos/1/stream.mp4?DeviceId=d1')).body,'media');
    // A client cannot claim to be a relaying machine: a forged proof is stripped and ignored.
    const before=seen.length;
    const forged=await get(portA,'/movie/key123/web',{host:`127.0.0.1:${portA}`,[EGRESS_HEADER]:'A'.repeat(22),[EGRESS_HOST_HEADER]:'evil.example.com'});
    assert.equal(forged.headers.location,`https://127.0.0.1:${portA}/movie/key123/web/index.html`);
    assert.equal(seen.slice(before).find(item=>item.at==='emby').headers[EGRESS_HOST_HEADER],undefined);
    assert.ok(up>0);
  } finally { await cleanup(); }
});

// What a client gets when every link leads back over the scheme and host it used.
const linksFor=(scheme,host)=>({web:`${scheme}://${host}/movie/key123/web/index.html`,away:`${scheme}://${host}`,followed:'external-body',info:{url:`${scheme}://${host}/movie/key123/.aegis-vod/https/vod.example.com/v/1.mp4`,live:`${scheme==='https'?'wss':'ws'}://${host}/movie/key123/.aegis-vod/https/vod.example.com/live`},told:[scheme,host],leaked:[]});

test('the egress machine answers for the scheme the client used: plain HTTP for a relaying machine in IP reverse-proxy mode, HTTPS otherwise',async()=>{
  const {seen,portA,portB,cleanup}=await setup();
  try {
    // IP reverse-proxy mode: Nginx serves plain HTTP on the machine's IP, passing that Host and X-Forwarded-Proto: http on.
    const ipMode=port=>({host:`127.0.0.1:${port}`,'x-forwarded-proto':'http'});
    assert.deepEqual(await linksVia(portA,ipMode(portA),seen),linksFor('http',`127.0.0.1:${portA}`),'the same request to a machine that reaches the upstream itself');
    assert.deepEqual(await linksVia(portB,ipMode(portB),seen),linksFor('http',`127.0.0.1:${portB}`),'through the egress machine');
    assert.deepEqual(await linksVia(portB,{},seen),linksFor('https','b.example.com'),'a relaying machine on an HTTPS domain keeps HTTPS links');
  } finally { await cleanup(); }
});

test('a relayed request that does not say which scheme the client used is answered for HTTPS, as before the scheme travelled with it',async()=>{
  const {seen,portA,route,cleanup}=await setup();
  try {
    const relayed=extra=>get(portA,'/movie/key123/web',{host:'a.example.com',[EGRESS_HEADER]:egressToken(route,Date.now()),[EGRESS_HOST_HEADER]:'203.0.113.9',...extra}).then(res=>res.headers.location);
    const https='https://203.0.113.9/movie/key123/web/index.html';
    assert.equal(await relayed(),https,'an older relaying machine sends no scheme');
    for(const forwarded of ['proto=ftp','proto=HTTP','for=198.51.100.7;proto=http','proto=http, proto=https'])assert.equal(await relayed({forwarded}),https,forwarded);
    // The X-Forwarded-Proto reaching the egress machine is its own Nginx's (the hop is HTTPS), so it says nothing about the client.
    assert.equal(await relayed({'x-forwarded-proto':'http'}),https);
    assert.equal(await relayed({forwarded:'proto=http'}),'http://203.0.113.9/movie/key123/web/index.html');
    // Without a valid proof the scheme is ignored like the host, and the header never goes upstream.
    const forged=await get(portA,'/movie/key123/web',{host:`127.0.0.1:${portA}`,[EGRESS_HEADER]:'A'.repeat(22),[EGRESS_HOST_HEADER]:'evil.example.com',forwarded:'proto=http'});
    assert.equal(forged.headers.location,`https://127.0.0.1:${portA}/movie/key123/web/index.html`);
    assert.deepEqual(seen.filter(item=>item.at==='emby').map(item=>item.headers.forwarded).filter(Boolean),[]);
  } finally { await cleanup(); }
});

test('a WebSocket through the egress machine tells the upstream the scheme the client used',{timeout:10_000},async()=>{
  const {seen,portB,cleanup}=await setup();
  try {
    assert.equal(await upgrade(portB,{host:`127.0.0.1:${portB}`,'x-forwarded-proto':'http'}),101);
    assert.equal(await upgrade(portB,{host:'b.example.com','x-forwarded-proto':'https'}),101);
    const sockets=seen.filter(item=>item.at==='emby-ws');
    assert.deepEqual(sockets.map(item=>[item.url,item.headers['x-forwarded-proto'],item.headers['x-forwarded-host']]),[['/socket','http',`127.0.0.1:${portB}`],['/socket','https','b.example.com']]);
    assert.deepEqual(sockets.flatMap(item=>Object.keys(item.headers).filter(name=>name==='forwarded'||name.startsWith('x-aegis-'))),[],'the hop headers stop at the egress machine');
  } finally { await cleanup(); }
});
