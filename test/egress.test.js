import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeProxyHandler } from '../src/proxy.js';
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
  assert.deepEqual(relayedEgress(route,headers(),now),{host:'entry.example.com'});
  assert.deepEqual(relayedEgress(route,headers(),now+120_000),{host:'entry.example.com'},'a little clock drift is fine');
  assert.equal(relayedEgress(route,headers(),now+4*60_000),null);
  assert.equal(relayedEgress({routeAuthKey:newRouteAuthKey()},headers(),now),null,'another node key');
  assert.equal(relayedEgress(route,headers({[EGRESS_HOST_HEADER]:'evil.example.com/x'}),now),null);
  assert.equal(relayedEgress(route,headers({[EGRESS_HEADER]:''}),now),null);
  assert.equal(relayedEgress({},headers(),now),null,'no node key, no relaying');
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
    res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true}');
  });
  const up=await listen(upstream),routeAuthKey=newRouteAuthKey();
  const base={id:'n1',alias:'movie',enabled:true,accessMode:'key',authVersion:ROUTE_AUTH_VERSION,routeAuthKey,keyDigest:routeTokenDigest('key123',routeAuthKey),upstreams:[`http://127.0.0.1:${up}`],allowPrivate:true,clientProfile:{enabled:true,userAgent:'Profile/1.0'}};
  // A is the egress machine; B relays through it. Different master keys: B never has to read A's links.
  const counts={a:0,b:0},a=new SteeringEngine({selfId:'a'}),b=new SteeringEngine({selfId:'b'});
  const handlerA=makeProxyHandler({getRoutes:()=>[base]},deriveKey('a'.repeat(32)),null,a);
  const relayA=http.createServer((req,res)=>{counts.a++;handlerA(req,res)}),portA=await listen(relayA);
  const routeB={...base,egress:{id:'a',base:`http://127.0.0.1:${portA}`}};
  const handlerB=makeProxyHandler({getRoutes:()=>[routeB]},deriveKey('b'.repeat(32)),null,b);
  const relayB=http.createServer((req,res)=>{counts.b++;handlerB(req,res)}),portB=await listen(relayB);
  return {seen,counts,portA,portB,up,cleanup:async()=>{a.stop();b.stop();await Promise.all([relayA,relayB,upstream,external].map(close))}};
}

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
