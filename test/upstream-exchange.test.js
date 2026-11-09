import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { getRuntimeStatus, UpstreamExchange } from '../src/upstream-exchange.js';
import { handleUpgrade } from '../src/proxy.js';
import { EGRESS_HEADER, EGRESS_HOST_HEADER, relayedEgress } from '../src/steering.js';
import { deriveKey } from '../src/security.js';
import { newRouteAuthKey, ROUTE_AUTH_VERSION, routeTokenDigest } from '../src/route-auth.js';

let routeSeq=0;
// Circuit state is per route id, so every test gets its own.
const route=(upstreams,extra={})=>({id:`x${++routeSeq}`,alias:'movie',name:'Movie',enabled:true,accessMode:'alias_only',upstreams,allowPrivate:true,...extra});
const keyRoute=(upstreams,extra={})=>{const routeAuthKey=newRouteAuthKey();return route(upstreams,{accessMode:'key',authVersion:ROUTE_AUTH_VERSION,routeAuthKey,keyDigest:routeTokenDigest('key123',routeAuthKey),...extra})};
const listen=(server,host='127.0.0.1')=>new Promise(resolve=>server.listen(0,host,()=>resolve(server.address().port)));
const close=server=>new Promise(resolve=>{server.closeAllConnections?.();server.close(resolve)});
// An upstream that records what it receives and answers with handler(req,res), or 200 "ok".
async function upstream(handler=null) {
  const seen=[];
  const server=http.createServer((req,res)=>{
    const chunks=[];req.on('data',chunk=>chunks.push(chunk));
    req.on('end',()=>{seen.push({method:req.method,url:req.url,headers:req.headers,body:Buffer.concat(chunks).toString(),port:req.socket.remotePort});if(handler)return handler(req,res);res.writeHead(200);res.end('ok');});
  });
  const port=await listen(server);
  return {seen,server,port,base:`http://127.0.0.1:${port}`};
}
const deadBase=async()=>{const server=http.createServer(),port=await listen(server);await close(server);return `http://127.0.0.1:${port}`};
const exchangeFor=(r,extra={})=>new UpstreamExchange({route:r,publicContext:{host:'hk.example.com',proto:'https'},clientHeaders:{},...extra});
const read=async stream=>{const chunks=[];for await(const chunk of stream)chunks.push(chunk);return Buffer.concat(chunks).toString()};
const failures=r=>getRuntimeStatus([r])[0].upstreams.map(line=>line.failures);

test('GET fails over in line order on a 502 or a dead line, and four failures in a row open the circuit',async()=>{
  const bad=await upstream((q,s)=>{s.writeHead(502);s.end('down')}),good=await upstream(),dead=await deadBase();
  try {
    const r=route([bad.base,good.base]);
    const first=await exchangeFor(r).open({rest:'/emby/System/Info',search:'?x=1'});
    assert.deepEqual([first.status,first.line,await read(first.body)],[200,good.base,'ok']);
    assert.deepEqual([bad.seen[0].url,good.seen[0].url],['/emby/System/Info?x=1','/emby/System/Info?x=1']);
    for(let i=0;i<3;i++)await read((await exchangeFor(r).open({rest:'/a'})).body);
    assert.deepEqual(failures(r),[4,0]);
    const before=bad.seen.length;
    await read((await exchangeFor(r).open({rest:'/a'})).body);
    assert.equal(bad.seen.length,before,'the open circuit skips the bad line');
    const viaDead=await exchangeFor(route([dead,good.base])).open({rest:'/b'});
    assert.equal(viaDead.line,good.base,'a refused connection fails over too');
    await read(viaDead.body);
  } finally { await Promise.all([close(bad.server),close(good.server)]); }
});

test('other methods send their body once and are never retried; with no line left the reason is safe to show',async()=>{
  const bad=await upstream((q,s)=>{s.writeHead(502);s.end('down')}),good=await upstream();
  try {
    const body=new PassThrough();body.end('{"ItemId":"1"}');
    const response=await exchangeFor(route([bad.base,good.base]),{method:'POST'}).open({rest:'/emby/Sessions/Playing',body});
    assert.equal(response.status,502,'the 502 is handed back as it is');await read(response.body);
    assert.deepEqual([bad.seen.length,good.seen.length,bad.seen[0].body],[1,0,'{"ItemId":"1"}']);
    const dead=await deadBase();
    await assert.rejects(exchangeFor(route([dead])).open({rest:'/'}),error=>error.reason==='上游拒绝连接，请检查地址、端口和防火墙');
  } finally { await Promise.all([close(bad.server),close(good.server)]); }
});

test('the client IP, admin session and spoofed egress headers never go upstream; credentials only reach the node origins',async()=>{
  const node=await upstream(),other=await upstream();
  try {
    const clientHeaders={'x-forwarded-for':'198.51.100.7','x-real-ip':'198.51.100.7',forwarded:'for=198.51.100.7','x-forwarded-host':'evil.example','x-csrf-token':'csrf',cookie:'aegis_session=admin; emby=1',authorization:'MediaBrowser Token="t"','x-emby-token':'t',[EGRESS_HEADER]:'spoofed',[EGRESS_HOST_HEADER]:'spoofed.example',connection:'keep-alive, x-secret','user-agent':'Client/1'};
    const r=route([node.base],{clientProfile:{enabled:true,userAgent:'Compat/2',client:'Emby Web'}});
    const exchange=exchangeFor(r,{clientHeaders});
    await read((await exchange.open({rest:'/'})).body);
    const sent=node.seen[0].headers;
    for(const name of ['x-forwarded-for','x-real-ip','forwarded','x-csrf-token',EGRESS_HEADER,EGRESS_HOST_HEADER,'x-secret'])assert.equal(sent[name],undefined,name);
    assert.deepEqual([sent.cookie,sent['x-forwarded-host'],sent['x-forwarded-proto'],sent.host],['emby=1','hk.example.com','https',`127.0.0.1:${node.port}`]);
    assert.deepEqual([sent['user-agent'],sent['x-emby-client'],sent.authorization,sent['x-emby-token']],['Compat/2','Emby Web','MediaBrowser Token="t"','t'],'the node origin keeps the credentials');
    await read((await exchange.open({target:new URL(`${other.base}/cdn/file`)})).body);
    const elsewhere=other.seen[0].headers;
    assert.deepEqual([elsewhere.authorization,elsewhere.cookie,elsewhere['x-emby-token'],other.seen[0].url],[undefined,undefined,undefined,'/cdn/file'],'a sealed redirect target on another origin gets none of them');
  } finally { await Promise.all([close(node.server),close(other.server)]); }
});

test('through the unified egress, the client path goes to the egress machine with a valid proof and no compat hint',async()=>{
  const machine=await upstream();
  try {
    const r=keyRoute(['https://emby.example.net'],{clientProfile:{enabled:true,userAgent:'Compat/2'}});
    const exchange=exchangeFor(r,{prefix:'/movie/key123',egress:{id:'jp',base:machine.base},clientHeaders:{'user-agent':'Client/1',authorization:'MediaBrowser Token="t"'}});
    await read((await exchange.open({rest:'/emby/Items',search:'?Limit=1'})).body);
    const sent=machine.seen[0];
    assert.equal(sent.url,'/movie/key123/emby/Items?Limit=1');
    assert.deepEqual(relayedEgress(r,sent.headers,Date.now()),{host:'hk.example.com'});
    assert.deepEqual([sent.headers['user-agent'],sent.headers.authorization],['Client/1','MediaBrowser Token="t"'],'the egress machine applies the hint, and it is a node origin');
  } finally { await close(machine.server); }
});

test('abort and a cancelled signal stop the request without counting against the line',async()=>{
  const silent=await upstream(()=>{});
  try {
    const r=route([silent.base]),exchange=exchangeFor(r);
    const pending=exchange.open({rest:'/'});
    await new Promise(resolve=>setTimeout(resolve,50));
    exchange.abort();
    await assert.rejects(pending,error=>error.aborted===true);
    await assert.rejects(exchange.open({rest:'/'}),error=>error.aborted===true,'nothing more is sent once the client has gone');
    const controller=new AbortController(),cancelled=exchangeFor(r).open({rest:'/',signal:controller.signal});
    setTimeout(()=>controller.abort(),50);
    await assert.rejects(cancelled);
    assert.deepEqual(failures(r),[0]);
  } finally { await close(silent.server); }
});

test('reopen asks the same line for the remaining bytes on a fresh socket, and only an accepted answer counts',async()=>{
  const media=await upstream((q,s)=>{
    if(q.headers.range){s.writeHead(206,{'content-range':'bytes 10-19/20','content-length':'10',etag:'"v1"'});return s.end('0123456789');}
    s.writeHead(200,{'content-length':'20',etag:'"v1"'});s.end('abcdefghij0123456789');
  });
  try {
    const exchange=exchangeFor(route([media.base]),{playback:true,clientHeaders:{'if-none-match':'"old"'}});
    const first=await exchange.open({rest:'/Videos/1/stream'});await read(first.body);
    const rest=await first.reopen({from:10,to:19,validator:'"v1"',accept:status=>status===206});
    assert.equal(await read(rest),'0123456789');
    const sent=media.seen[1].headers;
    assert.deepEqual([sent.range,sent['if-range'],sent['if-none-match'],sent.connection],['bytes=10-19','"v1"',undefined,'close']);
    assert.notEqual(media.seen[1].port,media.seen[0].port,'a fresh socket, never the pooled one');
    await assert.rejects(first.reopen({from:10,to:19,accept:()=>false}),error=>error.code==='ERESUMEREJECTED');
  } finally { await close(media.server); }
});

test('a WebSocket tunnel to a declared stream host on an undeclared port no longer carries the client credentials',async()=>{
  const seen=[];
  const ws=http.createServer();
  ws.on('upgrade',(req,socket)=>{seen.push(req.headers);socket.end('HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: websocket\r\n\r\n')});
  const wsPort=await listen(ws);
  const routes=[route(['http://127.0.0.1:9'],{streamRewrite:{enabled:true,domains:['127.0.0.1']}}),route(['http://127.0.0.1:9'],{alias:'exact',streamRewrite:{enabled:true,domains:[`127.0.0.1:${wsPort}`]}})];
  const key=deriveKey('k'.repeat(32)),relay=http.createServer();
  relay.on('upgrade',(req,socket,head)=>handleUpgrade(req,socket,head,{getRoutes:()=>routes},key));
  const port=await listen(relay);
  const open=alias=>new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,path:`/${alias}/.aegis-vod/http/127.0.0.1:${wsPort}/socket`,headers:{connection:'Upgrade',upgrade:'websocket',host:'hk.example.com',authorization:'MediaBrowser Token="t"','x-emby-token':'t',cookie:'emby=1'}});
    req.on('upgrade',(res,socket)=>{socket.destroy();resolve(res.statusCode)});req.on('error',reject);req.end();
  });
  try {
    assert.equal(await open('movie'),101);
    assert.deepEqual([seen[0].authorization,seen[0]['x-emby-token'],seen[0].cookie],[undefined,undefined,undefined],'127.0.0.1:<port> is not the declared origin');
    assert.equal(await open('exact'),101);
    assert.deepEqual([seen[1].authorization,seen[1]['x-emby-token'],seen[1].cookie],['MediaBrowser Token="t"','t','emby=1'],'a host declared with its port is trusted, as for HTTP');
  } finally { await Promise.all([close(relay),close(ws)]); }
});
