import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRelayServer } from '../src/proxy.js';
import { deriveKey } from '../src/security.js';
import { RELAY_HIGH_WATER_MARK } from '../src/upstream-exchange.js';

const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const close=server=>new Promise(resolve=>{server.closeAllConnections?.();server.close(resolve)});
const get=(port,path,headers={})=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path,headers},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}))});req.on('error',reject);req.end()});
// Resolves with the status of the 101 answer, or 'dropped' when the server closes the socket instead.
const upgrade=(port,path,headers={})=>new Promise(resolve=>{const req=http.request({hostname:'127.0.0.1',port,path,headers:{connection:'Upgrade',upgrade:'websocket',...headers}});req.on('upgrade',(res,socket)=>{socket.destroy();resolve(res.statusCode)});req.on('response',res=>{res.resume();resolve(`answered ${res.statusCode}`)});req.on('error',()=>resolve('dropped'));req.end()});

// An Emby stand-in and one node pointing at it.
async function machine(t,options={}) {
  const seen=[],upstream=http.createServer((req,res)=>{seen.push(req.url);res.end(`emby:${req.url}`)});
  upstream.on('upgrade',(req,socket)=>{seen.push(`ws:${req.url}`);socket.end('HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: websocket\r\n\r\n')});
  const up=await listen(upstream),routes=[{id:'movies',alias:'movies',enabled:true,accessMode:'alias_only',upstreams:[`http://127.0.0.1:${up}`],allowPrivate:true}];
  const server=createRelayServer({routeSource:{getRoutes:()=>routes},key:deriveKey('r'.repeat(32)),...options}),port=await listen(server);
  t.after(async()=>{await close(server);await close(upstream)});
  return {server,port,seen};
}

// Collects what the server logs instead of printing it.
function quietErrors(t) {
  const original=console.error,logged=[];
  console.error=(...args)=>logged.push(args.map(String).join(' '));
  t.after(()=>{console.error=original});
  return logged;
}

test('a machine with nothing else on the port relays every request and every WebSocket to the node',async t=>{
  const {port,seen}=await machine(t);
  const answer=await get(port,'/movies/System/Info');
  assert.deepEqual([answer.status,answer.body],[200,'emby:/System/Info']);
  assert.equal(await upgrade(port,'/movies/socket'),101);
  assert.equal(await upgrade(port,'/unknown/socket'),'dropped','a WebSocket for no node is closed');
  assert.deepEqual(seen,['/System/Info','ws:/socket']);
});

test('the panel machine sees each request first: it answers its own and hands the rest to the relay',async t=>{
  const {port,seen}=await machine(t,{
    route(req,res,relay){if(req.headers.host==='panel.test'){res.writeHead(200,{'content-type':'text/plain'});return res.end('panel')}return relay(req,res)},
    acceptUpgrade:req=>req.headers.host!=='panel.test'
  });
  assert.equal((await get(port,'/movies/System/Info',{host:'panel.test'})).body,'panel');
  assert.equal((await get(port,'/movies/System/Info',{host:'relay.test'})).body,'emby:/System/Info');
  assert.equal(await upgrade(port,'/movies/socket',{host:'panel.test'}),'dropped','a refused upgrade never reaches the node');
  assert.equal(await upgrade(port,'/movies/socket',{host:'relay.test'}),101);
  assert.deepEqual(seen,['/System/Info','ws:/socket']);
});

test('a request that blows up is answered 502 and the server keeps relaying',async t=>{
  const logged=quietErrors(t);
  const {port}=await machine(t,{label:'aegis-agent',
    route(req,res,relay){
      if(req.url==='/throws')throw new Error('thrown while routing');
      if(req.url==='/rejects')return Promise.reject(new Error('rejected while relaying'));
      if(req.url==='/upgrade-throws')throw new Error('unreachable: upgrades do not come through route');
      return relay(req,res);
    },
    acceptUpgrade(req){if(req.url==='/movies/bad-upgrade')throw new Error('thrown while upgrading');return true}
  });
  for(const path of ['/throws','/rejects']){
    const answer=await get(port,path);
    assert.deepEqual([answer.status,answer.body,answer.headers['cache-control']],[502,'bad gateway','no-store'],path);
  }
  assert.equal(await upgrade(port,'/movies/bad-upgrade'),'dropped');
  assert.equal((await get(port,'/movies/System/Info')).body,'emby:/System/Info','still serving afterwards');
  assert.equal(await upgrade(port,'/movies/socket'),101);
  assert.equal(logged.length,3);
  assert.match(logged[0],/^\[aegis-agent\] relay error Error: thrown while routing/);
  assert.match(logged[1],/^\[aegis-agent\] relay error Error: rejected while relaying/);
  assert.match(logged[2],/^\[aegis-agent\] upgrade error Error: thrown while upgrading/);
});

test('the server is set up for long playbacks behind Nginx',async t=>{
  const {server,port}=await machine(t);
  // A playback is one request that can last hours; only the headers have a deadline.
  assert.equal(server.requestTimeout,0);
  assert.equal(server.headersTimeout,80_000);
  // Idle connections outlive the 60-75s keep-alive of the Nginx in front, so Nginx never reuses one
  // this side has just closed.
  assert.ok(server.keepAliveTimeout>=75_000);
  let socket;server.once('connection',accepted=>{socket=accepted});
  await get(port,'/movies/System/Info');
  assert.equal(socket.writableHighWaterMark,RELAY_HIGH_WATER_MARK,'media-sized socket buffers');
});
