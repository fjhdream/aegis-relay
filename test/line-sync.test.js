import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { cleanLines, LINE_SYNC_CAPABILITY, lineSyncAuthPath, lineSyncReply, nodeLines, upstreamLines } from '../src/line-sync.js';
import { agentSnapshotNodes } from '../src/steering-topology.js';
import { compileSnapshot, generatePanelSigningIdentity } from '../src/snapshot.js';
import { runtimeRoutes } from '../src/local-agent.js';
import { makeProxyHandler } from '../src/proxy.js';
import { AgentApi, issueEnrollment } from '../src/agent-api.js';
import { SteeringEngine } from '../src/steering.js';
import { deriveKey } from '../src/security.js';
import { newRouteAuthKey, ROUTE_AUTH_VERSION, routeTokenDigest } from '../src/route-auth.js';

const routeAuthKey=newRouteAuthKey();
const keyRoute=(extra={})=>({id:'n1',alias:'movie',name:'Movie',enabled:true,accessMode:'key',authVersion:ROUTE_AUTH_VERSION,routeAuthKey,keyDigest:routeTokenDigest('key123',routeAuthKey),upstreams:['https://emby.example.net'],...extra});
function fleet(extra={}) {
  return {
    routes:[keyRoute()],
    agents:[
      {id:'local',name:'主机',domain:'panel.example.com',state:'active',sortOrder:5},
      {id:'jp',name:'日本',domain:'jp.example.com',proxyMode:'domain',state:'active',sortOrder:2,capabilities:[LINE_SYNC_CAPABILITY]},
      {id:'hk',name:'香港',domain:'hk.example.com',proxyMode:'domain',state:'active',sortOrder:2,capabilities:['config-v1']},
      {id:'ip',name:'IP 机',domain:'203.0.113.9:8080',proxyMode:'ip',state:'active',sortOrder:9},
      {id:'gone',name:'已撤销',domain:'gone.example.com',state:'revoked'},
      {id:'off',name:'未部署',domain:'off.example.com',state:'active'}
    ],
    deployments:['local','jp','hk','ip','gone'].map(agentId=>({agentId,routeId:'n1',enabled:true})).concat([{agentId:'off',routeId:'n1',enabled:false}]),
    settings:{},...extra
  };
}

test('only the line request is answered, on either Emby path spelling, and checked as /Items',()=>{
  assert.equal(lineSyncAuthPath('/emby/System/Ext/ServerDomains'),'/emby/Items');
  assert.equal(lineSyncAuthPath('/emby/system/ext/serverdomains/'),'/emby/Items');
  assert.equal(lineSyncAuthPath('/System/Ext/ServerDomains'),'/Items');
  for(const other of ['/emby/System/Info','/emby/System/Ext/ServerDomains/x','/x/emby/System/Ext/ServerDomains','/emby/System/Ext/ServerDomainsX',''])assert.equal(lineSyncAuthPath(other),null,other);
});

test('a node lists the entry domain first, then every machine serving it in the panel order',()=>{
  const data=fleet();
  assert.deepEqual(nodeLines(data,data.routes[0],{entryBase:'https://entry.example.com',localBase:'https://panel.example.com/'}),[
    {name:'智能入口',base:'https://entry.example.com'},
    {name:'日本',base:'https://jp.example.com'},
    {name:'香港',base:'https://hk.example.com'},
    {name:'主机',base:'https://panel.example.com'},
    {name:'IP 机',base:'http://203.0.113.9:8080'}
  ],'same sort order keeps registration order; revoked and disabled deployments are left out');
  assert.deepEqual(nodeLines(data,data.routes[0]).map(line=>line.name),['日本','香港','IP 机'],'no entry domain and no panel address: those lines are simply absent');
  assert.deepEqual(nodeLines(data,{...data.routes[0],lineSync:false},{localBase:'https://panel.example.com'}),[]);
  data.agents[1].domain='panel.example.com';
  assert.deepEqual(nodeLines(data,data.routes[0],{localBase:'https://panel.example.com'}).map(line=>line.name),['日本','香港','IP 机'],'one address is listed once');
});

test('snapshot lines are strict, and travel to the runtime route unchanged',()=>{
  assert.deepEqual(cleanLines([{name:' 香港 ',base:'https://hk.example.com'}]),[{name:'香港',base:'https://hk.example.com'}]);
  for(const bad of [[{name:'x',base:'https://hk.example.com/path'}],[{name:'x',base:'ftp://hk.example.com'}],[{name:'',base:'https://hk.example.com'}],[{name:'x',base:'https://u:p@hk.example.com'}],Array.from({length:33},(_,i)=>({name:`l${i}`,base:`https://l${i}.example.com`})),'x'])
    assert.throws(()=>cleanLines(bad),/invalid line/);
  const identity=generatePanelSigningIdentity(),lines=[{name:'香港',base:'https://hk.example.com'}];
  const snapshot=compileSnapshot({revision:1,nodes:[keyRoute({lines})],signingIdentity:identity});
  assert.deepEqual(runtimeRoutes(snapshot.nodes)[0].lines,lines);
  assert.equal(runtimeRoutes(compileSnapshot({revision:1,nodes:[keyRoute()],signingIdentity:identity}).nodes)[0].lines,undefined,'no lines block, no lines');
  assert.throws(()=>compileSnapshot({revision:1,nodes:[keyRoute({lines:[{name:'x',base:'javascript:alert(1)'}]})],signingIdentity:identity}),/invalid line/);
  assert.equal(runtimeRoutes(compileSnapshot({revision:1,nodes:[keyRoute({lines,lineSyncUpstream:true})],signingIdentity:identity}).nodes)[0].lineSyncUpstream,true);
  const bare=compileSnapshot({revision:1,nodes:[keyRoute({lineSyncUpstream:true})],signingIdentity:identity});
  assert.equal('lineSyncUpstream' in bare.nodes[0],false,'without a line list the flag means nothing and is not compiled');
});

test('only machines that know line-sync-v1 (and the panel machine) get the line list',()=>{
  const data=fleet(),byId=id=>agentSnapshotNodes(data,id,{localBase:'https://panel.example.com'})[0];
  assert.deepEqual(byId('jp').lines.map(line=>line.base),['https://jp.example.com','https://hk.example.com','https://panel.example.com','http://203.0.113.9:8080']);
  assert.equal(byId('local').lines.length,4);
  assert.equal(byId('hk').lines,undefined,'an older agent keeps its previous snapshot');
  assert.equal('lines' in byId('hk'),false);
  assert.equal(byId('jp').lineSyncUpstream,false,'upstream lines are opt-in');
  data.routes[0].lineSyncUpstream=true;
  assert.equal(byId('jp').lineSyncUpstream,true);
  const identity=generatePanelSigningIdentity();
  assert.equal('lineSyncUpstream' in compileSnapshot({revision:1,nodes:[byId('hk')],signingIdentity:identity}).nodes[0],false,'an older agent still gets its previous snapshot');
  data.routes[0].lineSync=false;
  assert.deepEqual(byId('jp').lines,[],'a node that does not share its lines still tells the machine so: it must answer 404');
  assert.equal(byId('jp').lineSyncUpstream,false,'not even the upstream lines');
});

test('an upgrade to line-sync-v1 recompiles every snapshot, and a renamed machine renames its line',async()=>{
  const data={routes:[keyRoute()],agents:[{id:'local',name:'主机',domain:'panel.example.com',state:'active'}],deployments:[{agentId:'local',routeId:'n1',enabled:true}],enrollmentTokens:[],controlPlane:{},settings:{}},store={data,save(){},audit(){}};
  let topologyChanges=0;
  const api=new AgentApi({store,version:'0.13.0',localBase:'https://panel.example.com',onTopologyChange:()=>topologyChanges++});
  const issued=issueEnrollment(data,{name:'HK',domain:'hk.example.com',routeIds:['n1']}),sign=crypto.generateKeyPairSync('ed25519'),box=crypto.generateKeyPairSync('x25519');
  const der=key=>key.export({format:'der',type:'spki'}).toString('base64url'),reply=()=>({status:0,raw:Buffer.alloc(0),writeHead(status){this.status=status},end(raw){this.raw=Buffer.from(raw||'')}});
  const req=(url,body,headers={})=>{const r=Readable.from([Buffer.from(body)]);r.url=url;r.method='POST';r.headers=headers;r.socket={remoteAddress:'127.0.0.1'};return r};
  const enrolled=reply();
  await api.handle(req('/api/agent/v1/enroll',JSON.stringify({protocolVersion:1,requestNonce:'line-enroll-nonce-0001',token:issued.token,agent:{signPublicKey:der(sign.publicKey),boxPublicKey:der(box.publicKey),agentVersion:'0.12.5',capabilities:['config-v1']},machine:{}})),enrolled);
  assert.equal(enrolled.status,201);assert.equal(topologyChanges,1,'a new machine joins the line lists of its nodes');topologyChanges=0;
  const agentId=JSON.parse(enrolled.raw).agentId,agent=data.agents.find(item=>item.id===agentId);
  assert.equal(api.desired(agent).nodes[0].lines,undefined);
  const body=Buffer.from(JSON.stringify({agentVersion:'0.13.0',currentRevision:0,applyState:'waiting',proxyHealthy:true,domain:'hk.example.com',proxyMode:'domain',capabilities:['config-v1',LINE_SYNC_CAPABILITY]}));
  const timestamp=Math.floor(Date.now()/1000),contentHash=crypto.createHash('sha256').update(body).digest('base64url'),nonce='line-checkin-nonce-00001';
  const { agentRequestInput }=await import('../src/agent-api.js');
  const signature=crypto.sign(null,Buffer.from(agentRequestInput({method:'POST',path:'/api/agent/v1/check-in',agentId,timestamp,nonce,contentHash})),sign.privateKey).toString('base64url');
  const checked=reply();
  await api.handle(req('/api/agent/v1/check-in',body,{'x-aegis-agent-id':agentId,'x-aegis-timestamp':String(timestamp),'x-aegis-nonce':nonce,'x-aegis-content-sha256':contentHash,'x-aegis-signature':signature}),checked);
  assert.equal(checked.status,200);assert.equal(topologyChanges,1,'the panel machine lists the upgraded machine too');
  assert.deepEqual(api.desired(agent).nodes[0].lines,[{name:'主机',base:'https://panel.example.com'},{name:'HK',base:'https://hk.example.com'}]);
  agent.name='香港';agent.sortOrder=-1;api.invalidate();
  assert.deepEqual(api.desired(agent).nodes[0].lines.map(line=>line.name),['香港','主机'],'renamed and moved up in the machine order');
});

test('the line reply follows the reference service: data on success, ok:false otherwise',()=>{
  const lines=[{name:'香港',base:'https://hk.example.com'}];
  const ok=lineSyncReply(200,lines,'/movie/key123');
  assert.equal(ok.status,200);assert.equal(ok.headers['cache-control'],'no-store');
  assert.deepEqual(JSON.parse(ok.body),{data:[{name:'香港',url:'https://hk.example.com/movie/key123'}],ok:true});
  assert.deepEqual([lineSyncReply(401,lines,'').status,JSON.parse(lineSyncReply(403,lines,'').body)],[401,{error:'Invalid token',ok:false}]);
  assert.deepEqual([lineSyncReply(500,lines,'').status,JSON.parse(lineSyncReply(404,lines,'').body).ok],[502,false]);
  const merged=lineSyncReply(200,lines,'/movie/key123',[{name:'上游·直连',url:'https://origin.example.net'},{name:'上游·重复',url:'https://hk.example.com/movie/key123'}]);
  assert.deepEqual(JSON.parse(merged.body).data,[{name:'香港',url:'https://hk.example.com/movie/key123'},{name:'上游·直连',url:'https://origin.example.net'}],'upstream lines follow, minus repeats');
  assert.equal(JSON.parse(lineSyncReply(401,lines,'',[{name:'上游·x',url:'https://x.example.net'}]).body).data,undefined);
});

test('the upstream line list is read leniently, but only http(s) addresses without credentials survive',()=>{
  const body=JSON.stringify({ok:true,data:[
    {name:'直连',url:'https://origin.example.net/'},{name:'',url:'https://cdn.example.net/emby/?x=1#frag'},{name:'坏',url:'javascript:alert(1)'},
    {name:'凭据',url:'https://u:p@origin.example.net'},{name:'文件',url:'ftp://origin.example.net'},{name:'长',url:`https://x.example.net/${'a'.repeat(2100)}`},{name:'\u0000控\n制',url:'http://203.0.113.7:8096'},null,'x'
  ]});
  assert.deepEqual(upstreamLines(Buffer.from(body)),[
    {name:'上游·直连',url:'https://origin.example.net'},{name:'上游·cdn.example.net',url:'https://cdn.example.net/emby/?x=1'},{name:'上游·控制',url:'http://203.0.113.7:8096'}]);
  for(const other of ['','<html>','{"ok":false,"data":[{"name":"x","url":"https://x.example.net"}]}','{"Id":"x"}','[]','null'])assert.deepEqual(upstreamLines(other),[],other);
  assert.deepEqual(upstreamLines('{"data":[{"name":"x","url":"https://x.example.net"}]}'),[{name:'上游·x',url:'https://x.example.net'}],'ok may be left out');
  assert.equal(upstreamLines(JSON.stringify({data:Array.from({length:40},(_,i)=>({name:`l${i}`,url:`https://l${i}.example.net`}))})).length,32);
});

const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const close=server=>new Promise(resolve=>{server.closeAllConnections?.();server.close(resolve)});
const get=(port,path,headers={})=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path,headers:{host:'hk.example.com','x-forwarded-proto':'https',...headers}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}))});req.on('error',reject);req.end()});
const LINES=[{name:'智能入口',base:'https://entry.example.com'},{name:'香港',base:'https://hk.example.com'},{name:'IP 机',base:'http://203.0.113.9:8080'}];

const ORIGIN_LINES='{"data":[{"name":"origin","url":"https://direct-origin.example.net"},{"name":"重复","url":"https://hk.example.com/movie/key123"}],"ok":true}';
// Model an upstream that serves public metadata at /System/Info but authenticates /Items.
async function emby({domains=null}={}) {
  const seen=[];
  const server=http.createServer((req,res)=>{
    const token=req.headers['x-emby-token']||new URL(req.url,'http://x').searchParams.get('api_key');
    seen.push({url:req.url,token,encoding:req.headers['accept-encoding']});
    if(/\/Items(?:\?|$)/i.test(req.url)&&token!=='good'){res.writeHead(401);return res.end('unauthorized')}
    if(/ServerDomains/.test(req.url)&&domains)return domains(req,res);
    res.writeHead(200,{'content-type':'application/json'});res.end(/ServerDomains/.test(req.url)?ORIGIN_LINES:'{"Id":"x"}');
  });
  return {seen,server,port:await listen(server)};
}

test('a relay answers the line request with the node lines, under the client key, once the upstream accepts its token',async()=>{
  const upstream=await emby(),routes=[keyRoute({upstreams:[`http://127.0.0.1:${upstream.port}`],allowPrivate:true,lines:LINES}),{id:'n2',alias:'open',name:'Open',enabled:true,accessMode:'alias_only',upstreams:[`http://127.0.0.1:${upstream.port}`],allowPrivate:true,lines:LINES.slice(1)}];
  const relay=http.createServer(makeProxyHandler({getRoutes:()=>routes},deriveKey('k'.repeat(32)))),port=await listen(relay);
  try {
    const bad=await get(port,'/movie/key123/emby/System/Ext/ServerDomains',{'x-emby-token':'stolen'});
    assert.deepEqual([bad.status,JSON.parse(bad.body)],[401,{error:'Invalid token',ok:false}]);
    const none=await get(port,'/movie/key123/emby/System/Ext/ServerDomains');
    assert.equal(none.status,401,'no token, no lines');
    const ok=await get(port,'/movie/key123/emby/System/Ext/ServerDomains',{'x-emby-token':'good'});
    assert.equal(ok.status,200);assert.match(ok.headers['content-type'],/application\/json/);
    assert.deepEqual(JSON.parse(ok.body),{data:[
      {name:'智能入口',url:'https://entry.example.com/movie/key123'},{name:'香港',url:'https://hk.example.com/movie/key123'},{name:'IP 机',url:'http://203.0.113.9:8080/movie/key123'}],ok:true});
    assert.deepEqual([upstream.seen.at(-1).url,upstream.seen.at(-1).token],['/emby/Items?Limit=1','good'],'the token was checked upstream, and the upstream list was never asked for');
    const query=await get(port,'/movie/key123/system/ext/serverdomains?api_key=good&limit=999&Recursive=true');
    assert.equal(query.status,200);assert.equal(upstream.seen.at(-1).url,'/Items?api_key=good&Limit=1');
    const open=await get(port,'/open/emby/System/Ext/ServerDomains',{'x-emby-token':'good'});
    assert.deepEqual(JSON.parse(open.body).data.map(line=>line.url),['https://hk.example.com/open','http://203.0.113.9:8080/open'],'a node without a key has no key in its lines');
    assert.equal((await get(port,'/movie/wrongkey/emby/System/Ext/ServerDomains',{'x-emby-token':'good'})).status,404,'the connection key still guards the node');
    assert.ok(upstream.seen.every(item=>!/ServerDomains/.test(item.url)));
  } finally { await Promise.all([close(relay),close(upstream.server)]); }
});

test('a node that does not share its lines answers 404, and an older snapshot passes the request on as before',async()=>{
  const upstream=await emby();
  const routes=[keyRoute({upstreams:[`http://127.0.0.1:${upstream.port}`],allowPrivate:true,lines:[]}),keyRoute({id:'n3',alias:'old',upstreams:[`http://127.0.0.1:${upstream.port}`],allowPrivate:true})];
  const relay=http.createServer(makeProxyHandler({getRoutes:()=>routes},deriveKey('k'.repeat(32)))),port=await listen(relay);
  try {
    assert.equal((await get(port,'/movie/key123/emby/System/Ext/ServerDomains',{'x-emby-token':'good'})).status,404);
    assert.equal(upstream.seen.length,0,'nothing went upstream');
    const old=await get(port,'/old/key123/emby/System/Ext/ServerDomains',{'x-emby-token':'good'});
    assert.equal(old.status,200);assert.match(old.body,/direct-origin/);assert.equal(upstream.seen.at(-1).url,'/emby/System/Ext/ServerDomains');
  } finally { await Promise.all([close(relay),close(upstream.server)]); }
});

test('a node that appends the upstream lines asks for them only once the token is accepted, and lists them last',async()=>{
  const upstream=await emby(),at=`http://127.0.0.1:${upstream.port}`;
  const routes=[keyRoute({upstreams:[at],allowPrivate:true,lines:LINES,lineSyncUpstream:true}),keyRoute({id:'n2',alias:'only',upstreams:[at],allowPrivate:true,lines:[],lineSyncUpstream:true})];
  const relay=http.createServer(makeProxyHandler({getRoutes:()=>routes},deriveKey('k'.repeat(32)))),port=await listen(relay);
  try {
    const ok=await get(port,'/movie/key123/emby/System/Ext/ServerDomains',{'x-emby-token':'good','accept-encoding':'gzip'});
    assert.equal(ok.status,200);
    assert.deepEqual(JSON.parse(ok.body).data,[
      {name:'智能入口',url:'https://entry.example.com/movie/key123'},{name:'香港',url:'https://hk.example.com/movie/key123'},{name:'IP 机',url:'http://203.0.113.9:8080/movie/key123'},
      {name:'上游·origin',url:'https://direct-origin.example.net'}],'the node lines first; an upstream line repeating one of them is dropped');
    assert.deepEqual(upstream.seen.map(item=>[item.url,item.token]),[['/emby/Items?Limit=1','good'],['/emby/System/Ext/ServerDomains','good']]);
    assert.equal(upstream.seen[1].encoding,'identity','the list is read here, so it is asked for uncompressed');
    upstream.seen.length=0;
    assert.equal((await get(port,'/movie/key123/emby/System/Ext/ServerDomains',{'x-emby-token':'stolen'})).status,401);
    assert.deepEqual(upstream.seen.map(item=>item.url),['/emby/Items?Limit=1'],'a rejected token never reaches the upstream list');
    upstream.seen.length=0;
    assert.equal((await get(port,'/movie/key123/emby/System/Ext/ServerDomains?api_key=good')).status,200);
    assert.equal(upstream.seen[1].url,'/emby/System/Ext/ServerDomains?api_key=good','the client query rides along');
    const only=await get(port,'/only/key123/emby/System/Ext/ServerDomains',{'x-emby-token':'good'});
    assert.deepEqual([only.status,JSON.parse(only.body).data.map(line=>line.name)],[200,['上游·origin','上游·重复']],'no machine address yet: the upstream lines alone');
  } finally { await Promise.all([close(relay),close(upstream.server)]); }
});

test('a missing, malformed, compressed, oversized or slow upstream list leaves the node lines alone',async()=>{
  let mode='';
  const upstream=await emby({domains:(req,res)=>{
    if(mode==='missing'){res.writeHead(404);return res.end('not found')}
    if(mode==='html'){res.writeHead(200,{'content-type':'text/html'});return res.end('<html>emby</html>')}
    if(mode==='gzip'){res.writeHead(200,{'content-type':'application/json','content-encoding':'gzip'});return res.end(zlib.gzipSync(ORIGIN_LINES))}
    if(mode==='huge'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({ok:true,data:[{name:'x',url:'https://x.example.net'}],pad:'x'.repeat(70*1024)}))}
    if(mode==='slow'){res.writeHead(200,{'content-type':'application/json'});return res.write('{"data":[')}
  }});
  const routes=[keyRoute({upstreams:[`http://127.0.0.1:${upstream.port}`],allowPrivate:true,lines:LINES,lineSyncUpstream:true})];
  const relay=http.createServer(makeProxyHandler({getRoutes:()=>routes},deriveKey('k'.repeat(32)))),port=await listen(relay);
  try {
    for(mode of ['missing','html','gzip','huge','slow']){
      const started=Date.now(),res=await get(port,'/movie/key123/emby/System/Ext/ServerDomains',{'x-emby-token':'good'});
      assert.deepEqual([res.status,JSON.parse(res.body).data.map(line=>line.name)],[200,LINES.map(line=>line.name)],mode);
      if(mode==='slow')assert.ok(Date.now()-started<6000,'a stalled upstream list is given up on');
    }
  } finally { await Promise.all([close(relay),close(upstream.server)]); }
});

test('an unreachable upstream is reported as such, not as an empty line list',async()=>{
  const dead=http.createServer(),deadPort=await listen(dead);await close(dead);
  const routes=[keyRoute({upstreams:[`http://127.0.0.1:${deadPort}`],allowPrivate:true,lines:LINES})];
  const relay=http.createServer(makeProxyHandler({getRoutes:()=>routes},deriveKey('k'.repeat(32)))),port=await listen(relay);
  try { assert.equal((await get(port,'/movie/key123/emby/System/Ext/ServerDomains',{'x-emby-token':'good'})).status,502); }
  finally { await close(relay); }
});

test('through a unified egress, the token is checked via the egress machine and the client machine answers',async()=>{
  const upstream=await emby(),base=keyRoute({upstreams:[`http://127.0.0.1:${upstream.port}`],allowPrivate:true});
  const a=new SteeringEngine({selfId:'a'}),b=new SteeringEngine({selfId:'b'}),counts={a:0,b:0};
  const handlerA=makeProxyHandler({getRoutes:()=>[{...base,lines:LINES}]},deriveKey('a'.repeat(32)),null,a);
  const relayA=http.createServer((req,res)=>{counts.a++;handlerA(req,res)}),portA=await listen(relayA);
  const handlerB=makeProxyHandler({getRoutes:()=>[{...base,lines:LINES.slice(1),egress:{id:'a',base:`http://127.0.0.1:${portA}`}}]},deriveKey('b'.repeat(32)),null,b);
  const relayB=http.createServer((req,res)=>{counts.b++;handlerB(req,res)}),portB=await listen(relayB);
  try {
    const res=await get(portB,'/movie/key123/emby/System/Ext/ServerDomains',{'x-emby-token':'good'});
    assert.equal(res.status,200);
    assert.deepEqual(JSON.parse(res.body).data.map(line=>line.name),['香港','IP 机'],'B answers with its own list');
    assert.deepEqual([counts.b,counts.a],[1,1]);
    assert.deepEqual([upstream.seen.at(-1).url,upstream.seen.at(-1).token],['/emby/Items?Limit=1','good']);
  } finally { a.stop();b.stop();await Promise.all([relayA,relayB,upstream.server].map(close)); }
});

test('through a unified egress, the upstream lines are fetched via the egress machine, which passes the request on',async()=>{
  const upstream=await emby(),base=keyRoute({upstreams:[`http://127.0.0.1:${upstream.port}`],allowPrivate:true});
  const a=new SteeringEngine({selfId:'a'}),b=new SteeringEngine({selfId:'b'}),counts={a:0,b:0};
  // The egress machine shares lines itself, but a request relayed by B is B's to answer.
  const handlerA=makeProxyHandler({getRoutes:()=>[{...base,lines:LINES}]},deriveKey('a'.repeat(32)),null,a);
  const relayA=http.createServer((req,res)=>{counts.a++;handlerA(req,res)}),portA=await listen(relayA);
  const handlerB=makeProxyHandler({getRoutes:()=>[{...base,lines:LINES.slice(1),lineSyncUpstream:true,egress:{id:'a',base:`http://127.0.0.1:${portA}`}}]},deriveKey('b'.repeat(32)),null,b);
  const relayB=http.createServer((req,res)=>{counts.b++;handlerB(req,res)}),portB=await listen(relayB);
  try {
    const res=await get(portB,'/movie/key123/emby/System/Ext/ServerDomains',{'x-emby-token':'good'});
    assert.equal(res.status,200);
    assert.deepEqual(JSON.parse(res.body).data.map(line=>line.name),['香港','IP 机','上游·origin']);
    assert.deepEqual([counts.b,counts.a],[1,2],'both upstream calls went through the egress machine');
    assert.deepEqual(upstream.seen.map(item=>item.url),['/emby/Items?Limit=1','/emby/System/Ext/ServerDomains']);
  } finally { a.stop();b.stop();await Promise.all([relayA,relayB,upstream.server].map(close)); }
});
