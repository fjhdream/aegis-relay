import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { totp } from '../src/security.js';

// Drives the real admin API of src/server.js end to end: which endpoints answer before a session, the
// session/CSRF gate, the 404s of the parameterised routes and the node-record validation.
const ROOT=new URL('..',import.meta.url).pathname;
const freePort=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(()=>resolve(port))})});
let server,emby,work,base,upstream,session={cookie:'',csrf:''};

async function call(method,p,body,{auth=true,raw,contentType='application/json',prefix='/api'}={}){
  const headers={};
  if(body!==undefined||raw!==undefined)headers['content-type']=contentType;
  if(auth&&session.cookie)headers.cookie=session.cookie;
  if(auth&&session.csrf)headers['x-csrf-token']=session.csrf;
  const res=await fetch(`${base}${prefix}${p}`,{method,headers,body:raw??(body===undefined?undefined:JSON.stringify(body)),redirect:'manual'});
  const text=await res.text();let json;try{json=JSON.parse(text)}catch{json=null}
  return {status:res.status,body:json,text,headers:res.headers};
}
async function signIn(password){
  const res=await call('POST','/login',{password},{auth:false});
  assert.equal(res.status,200);
  session={cookie:res.headers.get('set-cookie').split(';')[0],csrf:res.body.csrf};
}

before(async()=>{
  emby=http.createServer((_q,s)=>{s.setHeader('content-type','application/json');s.end('{"ServerName":"Fake","Version":"4.8.0.0","Id":"fake"}')});
  await new Promise(resolve=>emby.listen(0,'127.0.0.1',resolve));upstream=`http://127.0.0.1:${emby.address().port}`;
  work=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-admin-api-'));
  const [adminPort,proxyPort]=[await freePort(),await freePort()];
  server=spawn(process.execPath,['src/server.js'],{cwd:ROOT,stdio:'ignore',env:{...process.env,APP_MASTER_KEY:'admin-api-test-master-key-0123456789',SETUP_TOKEN:'setup-token',ADMIN_HOST:'127.0.0.1',ADMIN_PORT:String(adminPort),PROXY_HOST:'127.0.0.1',PROXY_PORT:String(proxyPort),DATA_FILE:path.join(work,'data','aegis.enc.json'),SECURE_COOKIES:'false',PUBLIC_BASE_URL:'https://panel.example.com',CERTIFICATE_EMAIL:'ops@example.com'}});
  base=`http://127.0.0.1:${adminPort}/_aegis`;
  for(let i=0;i<200;i++){try{if((await fetch(`${base}/api/status`)).ok)break}catch{}await new Promise(resolve=>setTimeout(resolve,50))}
});
after(async()=>{
  server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve));
  emby.close();fs.rmSync(work,{recursive:true,force:true});
});

test('public endpoints answer before setup; everything else is behind the session and its CSRF token',async()=>{
  assert.deepEqual((await call('GET','/status',undefined,{auth:false})).body,{initialized:false,adminPath:'/_aegis',version:JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8')).version});
  assert.equal((await call('GET','/session',undefined,{auth:false})).status,401);
  assert.equal((await call('GET','/routes',undefined,{auth:false})).status,401);
  assert.equal((await call('GET','/no-such-endpoint',undefined,{auth:false})).status,401,'an unknown path is not revealed without a session');
  assert.equal((await call('POST','/login',{password:'x'},{auth:false})).status,429,'no admin yet');
  assert.equal((await call('POST','/setup',undefined,{auth:false,raw:'x',contentType:'text/plain'})).status,415);
  assert.equal((await call('POST','/setup',undefined,{auth:false,raw:'{x'})).status,400);
  assert.equal((await call('POST','/setup',{setupToken:'wrong',password:'p'},{auth:false})).status,403);
  assert.equal((await call('POST','/setup',{setupToken:'setup-token',password:'first-password'},{auth:false})).status,201);
  assert.equal((await call('POST','/setup',{setupToken:'setup-token',password:'x'},{auth:false})).status,409);
  assert.equal((await call('POST','/login',{password:'wrong'},{auth:false})).status,401);
  await signIn('first-password');
  assert.equal((await call('GET','/session')).body.csrf,session.csrf);
  const csrf=session.csrf;session.csrf='';
  assert.equal((await call('GET','/routes')).status,403,'the cookie alone is not enough');
  session.csrf=csrf;
  assert.equal((await call('GET','/login')).status,404,'POST-only public endpoints are not reachable by GET');
  assert.equal((await call('GET','/no-such-endpoint')).status,404);
});

test('two-factor enrolment, recovery-code login and disable',async()=>{
  assert.equal((await call('POST','/account/totp/enable',{code:'000000'})).status,409);
  const begun=await call('POST','/account/totp/begin',{password:'first-password'});
  assert.equal(begun.status,200);assert.ok(begun.body.qr.rows.length>=21);
  assert.equal((await call('POST','/account/totp/enable',{code:'000000'})).status,401);
  const enabled=await call('POST','/account/totp/enable',{code:totp(begun.body.secret)});
  assert.equal(enabled.body.recovery.length,8);
  assert.deepEqual((await call('GET','/account')).body,{username:'admin',totpEnabled:true,recoveryRemaining:8});
  assert.equal((await call('POST','/logout',{})).status,200);
  assert.equal((await call('GET','/session')).status,401);
  session={cookie:'',csrf:''};
  assert.equal((await call('POST','/login',{password:'first-password'},{auth:false})).status,401,'a password alone no longer signs in');
  const recovered=await call('POST','/login',{password:'first-password',recovery:enabled.body.recovery[0]},{auth:false});
  assert.equal(recovered.status,200);session={cookie:recovered.headers.get('set-cookie').split(';')[0],csrf:recovered.body.csrf};
  assert.equal((await call('GET','/account')).body.recoveryRemaining,7);
  // A wrong password must not spend a valid recovery code. (These are the file's 5th and 6th logins —
  // the limiter allows six per window.)
  const kept=enabled.body.recovery[1];
  assert.equal((await call('POST','/login',{password:'wrong',recovery:kept},{auth:false})).status,401);
  const again=await call('POST','/login',{password:'first-password',recovery:kept},{auth:false});
  assert.equal(again.status,200,'the code survived the failed attempt');session={cookie:again.headers.get('set-cookie').split(';')[0],csrf:again.body.csrf};
  assert.equal((await call('GET','/account')).body.recoveryRemaining,6);
  assert.equal((await call('POST','/account/totp/disable',{password:'first-password',code:'000000'})).status,401);
  assert.equal((await call('POST','/account/totp/disable',{password:'first-password',code:totp(begun.body.secret)})).status,200);
  assert.equal((await call('GET','/account')).body.totpEnabled,false);
});

test('create and import share one node record with the same bounds',async()=>{
  assert.equal((await call('POST','/routes',{alias:'api',upstreams:upstream,allowPrivate:true})).status,400,'reserved alias');
  assert.equal((await call('POST','/routes',{alias:'private',upstreams:upstream})).status,400,'private upstream without opting in');
  const created=await call('POST','/routes',{alias:'edge',name:'N'.repeat(120),upstreams:upstream,allowPrivate:true,tlsVerify:0,favorite:1,enabled:false,tags:Array.from({length:12},(_,i)=>`tag-${i}-${'x'.repeat(30)}`),notes:'y'.repeat(700),sortOrder:99999,speedLimitMbps:-5,monthlyQuotaGB:'abc',reminderDays:400,accessAlertThreshold:1e9});
  assert.equal(created.status,201);
  const route=created.body.route;
  assert.equal(route.name.length,80);assert.equal(route.notes.length,500);
  assert.equal(route.tags.length,8);assert.ok(route.tags.every(tag=>tag.length===24));
  assert.deepEqual([route.enabled,route.tlsVerify,route.favorite,route.accessMode],[true,true,false,'key'],'create always enables the node and only true is true');
  assert.deepEqual([route.sortOrder,route.speedLimitMbps,route.monthlyQuotaGB,route.reminderDays,route.accessAlertThreshold],[10000,0,0,365,100000]);
  assert.match(created.body.clientPath,/^\/edge\/[A-Za-z0-9_-]{32}\/$/);
  assert.equal((await call('POST','/routes',{alias:'edge',upstreams:upstream,allowPrivate:true})).status,409);
  const imported=await call('POST','/import',{routes:[{alias:'quiet',upstream,allowPrivate:true,enabled:false,accessMode:'alias_only',notes:'q'.repeat(600)},{alias:'edge',upstreams:upstream,allowPrivate:true},{alias:'r',upstreams:upstream}]});
  assert.equal(imported.body.imported,1);
  assert.deepEqual(imported.body.errors.map(e=>e.alias),['edge','r']);
  const quiet=(await call('GET','/routes')).body.routes.find(r=>r.alias==='quiet');
  assert.deepEqual([quiet.enabled,quiet.accessMode,quiet.notes.length],[false,'alias_only',500],'import keeps enabled:false where create does not');
});

test('node PATCH applies its fields in place and reports conflicts',async()=>{
  const {routes}=(await call('GET','/routes')).body,edge=routes.find(r=>r.alias==='edge'),quiet=routes.find(r=>r.alias==='quiet');
  const patched=await call('PATCH',`/routes/${edge.id}`,{name:'M'.repeat(100),notes:'z'.repeat(650),tags:'a,b,,c,a',enabled:'true',showOnHome:true,speedLimitMbps:'7',reminderDays:-3});
  assert.equal(patched.status,200);
  const r=patched.body.route;
  assert.deepEqual([r.name.length,r.notes.length,r.tags,r.enabled,r.showOnHome,r.speedLimitMbps,r.reminderDays],[80,500,['a','b','c'],false,true,7,0]);
  assert.equal((await call('PATCH',`/routes/${edge.id}`,{alias:'quiet'})).status,409);
  const toAlias=await call('PATCH',`/routes/${edge.id}`,{accessMode:'alias_only'});
  assert.equal(toAlias.body.clientPath,'/edge/');
  const toKey=await call('PATCH',`/routes/${edge.id}`,{accessMode:'key'});
  assert.match(toKey.body.clientPath,/^\/edge\/[A-Za-z0-9_-]{32}\/$/);
  assert.equal((await call('POST',`/routes/${quiet.id}/rotate-key`,{})).status,409);
  assert.equal((await call('POST',`/routes/${edge.id}/rotate-key`,{})).status,200);
  assert.equal((await call('GET',`/routes/${edge.id}`)).status,404,'a node is read through /routes, not by id');
  assert.equal((await call('PATCH','/routes/missing',{})).status,404);
  assert.equal((await call('GET',`/routes/${edge.id}/rotate-key`)).status,404);
});

test('distribution channels and their parameterised 404s',async()=>{
  const {routes}=(await call('GET','/routes')).body,edge=routes.find(r=>r.alias==='edge'),quiet=routes.find(r=>r.alias==='quiet');
  assert.equal((await call('POST',`/routes/${quiet.id}/channels`,{label:'x'})).status,409,'alias-only nodes have no keys to hand out');
  const added=await call('POST',`/routes/${edge.id}/channels`,{label:'小明'});
  assert.equal(added.status,201);const cid=added.body.channel.id;
  assert.equal((await call('PATCH',`/routes/${edge.id}/channels/${cid}`,{label:'小红'})).body.label,'小红');
  assert.equal((await call('DELETE',`/routes/${edge.id}/channels/default`)).status,409);
  assert.equal((await call('GET',`/routes/${edge.id}/channels/default`)).status,409,'the default channel is refused for every method');
  assert.equal((await call('GET',`/routes/${edge.id}/channels/missing`)).body.error,'通道不存在');
  assert.equal((await call('GET',`/routes/${edge.id}/channels/${cid}`)).status,404);
  assert.equal((await call('PUT',`/routes/${edge.id}/channels`,{})).status,404);
  assert.deepEqual((await call('GET',`/routes/${edge.id}/channels`)).body.channels.map(c=>c.label),['默认','小红']);
  assert.equal((await call('DELETE',`/routes/${edge.id}/channels/${cid}`)).status,200);
  assert.equal((await call('GET',`/routes/${edge.id}/credentials`)).status,200);
  assert.equal((await call('POST',`/routes/${edge.id}/credentials`,{})).status,404);
  assert.equal((await call('POST',`/routes/${edge.id}/reminder-complete`,{})).status,200);
  assert.equal((await call('GET',`/routes/${edge.id}/reminder-complete`)).status,404);
  assert.equal((await call('GET',`/diagnostics/${quiet.id}`)).status,200);
  assert.equal((await call('GET','/diagnostics/missing')).status,404);
});

test('machines: enrollment, edits and the 404s of a missing machine',async()=>{
  assert.equal((await call('POST','/agents/enrollment',{name:''})).status,400);
  const enrolled=await call('POST','/agents/enrollment',{name:'HK'});
  assert.equal(enrolled.status,201);assert.match(enrolled.body.command,/--mode ip$/);
  assert.equal((await call('PUT','/agents/enrollment',{})).body.error,'agent not found','a method the enrollment endpoint lacks reaches the machine lookup');
  assert.equal((await call('PATCH','/agents/local',{name:'  '})).status,400);
  assert.equal((await call('PATCH','/agents/local',{routeIds:'x'})).status,400);
  assert.equal((await call('PATCH','/agents/local',{routeIds:['missing']})).status,400);
  assert.equal((await call('PATCH','/agents/local',{domain:''})).status,400);
  assert.equal((await call('PATCH','/agents/local',{domain:'panel.example.com'})).status,409);
  const renamed=await call('PATCH','/agents/local',{name:'主机',sortOrder:99999});
  assert.deepEqual([renamed.body.agent.name,renamed.body.agent.sortOrder],['主机',10000]);
  assert.equal((await call('DELETE','/agents/local')).status,409);
  assert.equal((await call('GET','/agents/local')).body.error,'not found');
  assert.equal((await call('PATCH','/agents/missing',{})).body.error,'agent not found');
});

test('dashboard feed, settings and the static shell',async()=>{
  const ctrl=new AbortController(),events=await fetch(`${base}/api/events`,{headers:{cookie:session.cookie,'x-csrf-token':session.csrf},signal:ctrl.signal});
  assert.match(events.headers.get('content-type'),/text\/event-stream/);
  const first=await events.body.getReader().read();ctrl.abort();
  assert.match(Buffer.from(first.value).toString(),/^event: dashboard\ndata: \{/);
  assert.equal((await call('POST','/notifications/test',{})).status,400,'nothing configured to send to');
  assert.equal((await call('PUT','/deployment',{certificateEmail:'nope'})).status,400);
  assert.equal((await call('PUT','/deployment',{certificateEmail:'admin@example.com'})).body.certificateEmail,'admin@example.com');
  assert.equal((await call('GET','',undefined,{auth:false,prefix:''})).headers.get('location'),'/_aegis/');
  assert.match((await call('GET','/',undefined,{auth:false,prefix:''})).text,/<html/i);
  assert.equal((await call('POST','/',{},{auth:false,prefix:''})).status,405);
  assert.equal((await call('GET','/missing.js',undefined,{auth:false,prefix:''})).status,404);
});

test('a rejected update leaves the node and the machine exactly as they were',async()=>{
  const node=async alias=>(await call('GET','/routes')).body.routes.find(r=>r.alias===alias);
  const edge=await node('edge'),path=(await call('GET',`/routes/${edge.id}/credentials`)).body.clientPath;
  // Rejected after the access mode and name were read: neither may stick, and the key must not rotate.
  assert.equal((await call('PATCH',`/routes/${edge.id}`,{accessMode:'alias_only',name:'renamed',alias:'quiet'})).status,409);
  assert.deepEqual([(await node('edge')).accessMode,(await node('edge')).name],[edge.accessMode,edge.name]);
  assert.equal((await call('GET',`/routes/${edge.id}/credentials`)).body.clientPath,path,'the client address still works');
  // Rejected by the upstream check, which runs last.
  assert.equal((await call('PATCH',`/routes/${edge.id}`,{name:'renamed',allowPrivate:false})).status,400);
  assert.deepEqual([(await node('edge')).allowPrivate,(await node('edge')).name],[true,edge.name]);
  const nullProfile=await call('PATCH',`/routes/${edge.id}`,{name:'renamed',clientProfile:null});
  assert.equal(nullProfile.status,400);assert.equal(nullProfile.body.error,'invalid client profile');
  assert.equal((await node('edge')).name,edge.name);
  // Machines: a bad route list arrives after the name and the domain; nothing may be applied or filed.
  const local=async()=>(await call('GET','/agents')).body.agents.find(a=>a.id==='local');
  const before=await local();
  assert.equal((await call('PATCH','/agents/local',{name:'renamed',domain:'proxy.example.com',routeIds:['missing']})).status,400);
  assert.equal((await local()).name,before.name);
  assert.equal((await call('GET','/deployment')).body.domainChange,null,'no domain switch was requested');
  assert.equal((await call('PATCH','/agents/local',{name:'renamed',domain:''})).status,400);
  assert.equal((await local()).name,before.name);
  // A valid request still applies all of it.
  const applied=await call('PATCH',`/routes/${edge.id}`,{name:'renamed',allowPrivate:true,alias:'edge-2'});
  assert.deepEqual([applied.status,applied.body.route.name,applied.body.route.alias],[200,'renamed','edge-2']);
});

test('automatic steering settings are validated before anything is written',async()=>{
  const initial=(await call('GET','/steering')).body;
  assert.equal(initial.settings.mode,'off');
  assert.equal((await call('PUT','/steering',{mode:'fast'})).status,400);
  assert.equal((await call('PUT','/steering',{mode:'shadow',entryDomain:'panel.example.com'})).status,409);
  assert.equal((await call('PUT','/steering',{mode:'shadow',entryDomain:'entry.example.com:8443'})).status,400);
  assert.equal((await call('GET','/steering')).body.settings.mode,'off','a rejected request leaves the mode alone');
  const saved=await call('PUT','/steering',{mode:'shadow',entryDomain:'https://Entry.Example.com/',boundMB:4});
  assert.equal(saved.status,200);
  assert.deepEqual([saved.body.settings.mode,saved.body.settings.entryDomain,saved.body.settings.boundMB],['shadow','entry.example.com',8]);
  assert.deepEqual(saved.body.entryCommands.map(item=>item.command),[`sudo aegis-relay entry entry.example.com ${saved.body.certificateEmail}`]);
  // A node opted in is handed out on the entry domain; the machine toggle shows up as an issue.
  const quiet=(await call('GET','/routes')).body.routes.find(r=>r.alias==='quiet');
  const patched=await call('PATCH',`/routes/${quiet.id}`,{autoSteer:{enabled:true,minRateMbps:-1}});
  assert.deepEqual(patched.body.route.autoSteer,{enabled:true,minRateMbps:0});
  assert.equal((await call('GET',`/routes/${quiet.id}/channels`)).body.publicBaseUrl,'https://entry.example.com');
  assert.equal((await call('PATCH','/agents/local',{steerTarget:false})).status,200);
  assert.match((await call('GET','/steering')).body.machines.find(m=>m.id==='local').issues.join(),/已关闭/);
});
