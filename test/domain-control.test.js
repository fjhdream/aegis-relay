import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activeLocalDomain, domainRequestRole, DOMAIN_REQUEST_FILE, followDomain, forgetDomainSwitch, readDomainStatus, requestDomainSwitch, servingAddress } from '../src/domain-control.js';
import { isCertificateEmail } from '../src/agent-registry.js';
import { normalizeCertificateEmail } from '../src/agent-api.js';
import { cleanEntryRequest } from '../src/steering-topology.js';

test('active local domain prefers the separated data plane and validates bare HTTPS origins',()=>{
  assert.equal(activeLocalDomain({localProxyBaseUrl:'https://embyus.example.com',publicBaseUrl:'https://panel.example.com'}),'embyus.example.com');
  assert.equal(activeLocalDomain({publicBaseUrl:'https://panel.example.com'}),'panel.example.com');
  assert.equal(activeLocalDomain({localProxyBaseUrl:'http://bad.example.com',publicBaseUrl:'https://panel.example.com/path'}),'');
});

test('split-domain routing rejects old proxy names and unrelated subdomains',()=>{
  const input={panelHostname:'emby.example.com',proxyHostname:'embyus.example.com'};
  assert.equal(domainRequestRole({...input,requestHostname:'emby.example.com'}),'control');
  assert.equal(domainRequestRole({...input,requestHostname:'embyus.example.com'}),'proxy');
  assert.equal(domainRequestRole({...input,requestHostname:'old.example.com'}),'reject');
  assert.equal(domainRequestRole({...input,requestHostname:'xx.example.com'}),'reject');
  assert.equal(domainRequestRole({panelHostname:'emby.example.com',proxyHostname:'emby.example.com',requestHostname:'xx.example.com'}),'legacy');
});

test('domain switch writes a constrained atomic host request and readable pending status',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-domain-'));
  try{
    const status=requestDomainSwitch({dir,domain:'EmbyUS.Example.com',email:'Admin@Example.com',currentDomain:'old.example.com'});
    assert.equal(status.state,'pending');
    const request=JSON.parse(fs.readFileSync(path.join(dir,DOMAIN_REQUEST_FILE),'utf8'));
    assert.equal(request.desiredDomain,'embyus.example.com');
    assert.equal(request.certificateEmail,'admin@example.com');
    assert.deepEqual(readDomainStatus(dir),status);
    assert.equal(fs.statSync(path.join(dir,DOMAIN_REQUEST_FILE)).mode&0o777,0o600,'only the owner and the root host unit read it');
    assert.deepEqual(fs.readdirSync(dir).filter(name=>name.endsWith('.tmp')),[],'no half-written file is left behind');
    assert.throws(()=>requestDomainSwitch({dir,domain:'panel.example.com/x',email:'admin@example.com'}));
    assert.throws(()=>requestDomainSwitch({dir,domain:'panel.example.com:8443',email:'admin@example.com'}));
    assert.throws(()=>requestDomainSwitch({dir,domain:'bad_domain.example.com',email:'admin@example.com'}));
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

// An agent's data directory, with the host unit played by hand: it takes the request file away and
// writes back how the switch went.
function agentHost(t,installed){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-agent-domain-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const requestFile=path.join(dir,DOMAIN_REQUEST_FILE),statusFile=path.join(dir,'host-domain-status.json');
  const request=()=>{try{return JSON.parse(fs.readFileSync(requestFile,'utf8'))}catch{return null}};
  const hostAnswers=(state,fields={})=>{const asked=request();fs.rmSync(requestFile,{force:true});fs.writeFileSync(statusFile,JSON.stringify({...readDomainStatus(dir),requestId:asked?.requestId||'',state,...fields}))};
  const follow=(desired,nowMs)=>followDomain({dir,desired,installed,...(nowMs===undefined?{}:{nowMs})});
  return {dir,request,hostAnswers,follow,serving:()=>servingAddress({dir,installed})};
}
const T0=Date.parse('2026-11-11T08:00:00Z'),MINUTE=60_000;

test('an agent serves where it was installed until the host has switched it',t=>{
  const cases=[
    [{mode:'',domain:'hk.example.com',ip:''},{mode:'domain',domain:'hk.example.com'}],
    [{mode:'ip',domain:'',ip:'203.0.113.9'},{mode:'ip',domain:'203.0.113.9'}],
    [{mode:'ip',domain:'hk.example.com',ip:'203.0.113.9'},{mode:'ip',domain:'203.0.113.9'}],
    [{mode:'',domain:'',ip:'203.0.113.9'},{mode:'ip',domain:'203.0.113.9'}],
    [{mode:'',domain:'',ip:''},{mode:'domain',domain:''}],
    [undefined,{mode:'domain',domain:''}]
  ];
  for(const [installed,expected] of cases)assert.deepEqual(agentHost(t,installed).serving(),expected,JSON.stringify(installed));
  const host=agentHost(t,{mode:'',domain:'hk.example.com',ip:''});
  // A switch that is under way, or failed, changes nothing; one the host finished does.
  host.follow({domain:'jp.example.com',email:'ops@example.com'},T0);
  assert.deepEqual(host.serving(),{mode:'domain',domain:'hk.example.com'});
  host.hostAnswers('failed');
  assert.deepEqual(host.serving(),{mode:'domain',domain:'hk.example.com'});
  host.hostAnswers('active',{currentDomain:'jp.example.com'});
  assert.deepEqual(host.serving(),{mode:'domain',domain:'jp.example.com'});
  host.hostAnswers('active',{mode:'ip',currentDomain:'203.0.113.9'});
  assert.deepEqual(host.serving(),{mode:'ip',domain:'203.0.113.9'});
  // The container keeps the environment it was started with, and the host does not restart it after a
  // switch. So a status that is not `active` still decides: it names the address served when it was
  // written, which a later failed or pending switch must not replace with what the container started with.
  const moved=agentHost(t,{mode:'',domain:'hk.example.com',ip:''}),statusFile=path.join(moved.dir,'host-domain-status.json');
  for(const [status,expected] of [
    [{state:'failed',mode:'domain',desiredDomain:'jp.example.com',currentDomain:'203.0.113.9'},{mode:'ip',domain:'203.0.113.9'}],
    [{state:'applying',mode:'ip',desiredDomain:'',currentDomain:'sg.example.com'},{mode:'domain',domain:'sg.example.com'}],
    [{state:'pending',mode:'domain',desiredDomain:'jp.example.com',currentDomain:'2001:db8::7'},{mode:'ip',domain:'2001:db8::7'}],
    [{state:'failed',mode:'ip',desiredDomain:'',currentDomain:''},{mode:'domain',domain:'hk.example.com'}]
  ]){fs.writeFileSync(statusFile,JSON.stringify(status));assert.deepEqual(moved.serving(),expected,JSON.stringify(status))}
  // The host switched to IP mode without naming the address: the install-time one stands in.
  const bare=agentHost(t,{mode:'',domain:'hk.example.com',ip:'198.51.100.7'});
  bare.follow({mode:'ip'},T0);bare.hostAnswers('active',{currentDomain:''});
  assert.deepEqual(bare.serving(),{mode:'ip',domain:'198.51.100.7'});
});

test('an agent asks its host for the domain the panel wants, once, and again only after a failure has aged',t=>{
  const host=agentHost(t,{mode:'',domain:'hk.example.com',ip:''}),desired={domain:'jp.example.com',email:'Ops@Example.com'};
  assert.equal(host.follow({},T0),false,'the panel wants nothing changed');
  assert.equal(host.follow({domain:'hk.example.com',email:'ops@example.com'},T0),false,'already serving on it');
  assert.equal(host.request(),null);

  assert.equal(host.follow(desired,T0),true);
  const asked=host.request();
  assert.deepEqual({...asked,requestId:'id'},{version:1,requestId:'id',mode:'domain',desiredDomain:'jp.example.com',certificateEmail:'ops@example.com',requestedAt:'2026-11-11T08:00:00.000Z'});
  assert.deepEqual(readDomainStatus(host.dir),{requestId:asked.requestId,state:'pending',mode:'domain',desiredDomain:'jp.example.com',currentDomain:'hk.example.com',message:'等待主机申请证书并切换 Nginx',updatedAt:'2026-11-11T08:00:00.000Z'});
  assert.equal(fs.statSync(path.join(host.dir,DOMAIN_REQUEST_FILE)).mode&0o777,0o600);

  // One host change at a time: nothing is filed over a request the host has not picked up yet.
  assert.equal(host.follow({domain:'sg.example.com',email:'ops@example.com'},T0+MINUTE),false);
  assert.equal(host.follow({mode:'ip'},T0+MINUTE),false);
  assert.equal(host.request().requestId,asked.requestId);

  // The host is working on it, then fails: no second request until the failure is ten minutes old.
  host.hostAnswers('applying');
  assert.equal(host.follow(desired,T0+2*MINUTE),false);
  host.hostAnswers('failed',{updatedAt:new Date(T0+3*MINUTE).toISOString()});
  assert.equal(host.follow(desired,T0+13*MINUTE),false,'exactly ten minutes is not yet past it');
  assert.equal(host.request(),null);
  assert.equal(host.follow(desired,T0+13*MINUTE+1),true);
  assert.notEqual(host.request().requestId,asked.requestId);

  // A failure for one domain does not hold back a request for another.
  host.hostAnswers('failed',{updatedAt:new Date(T0+14*MINUTE).toISOString()});
  assert.equal(host.follow({domain:'sg.example.com',email:'ops@example.com'},T0+14*MINUTE),true);
  assert.equal(host.request().desiredDomain,'sg.example.com');

  // Once the host has switched, the agent serves on the new domain and asks for nothing more.
  host.hostAnswers('active',{currentDomain:'sg.example.com'});
  assert.equal(host.follow({domain:'sg.example.com',email:'ops@example.com'},T0+15*MINUTE),false);
  assert.equal(host.request(),null);
  // A failed status with no readable time is never retried by itself.
  host.follow(desired,T0+16*MINUTE);host.hostAnswers('failed',{updatedAt:''});
  assert.equal(host.follow(desired,T0+10*60*MINUTE),false);
});

test('an agent asks its host to switch to its IP when the panel wants IP mode, and back to a domain later',t=>{
  const host=agentHost(t,{mode:'',domain:'hk.example.com',ip:'203.0.113.9'});
  assert.equal(host.follow({mode:'ip',domain:'ignored.example.com'},T0),true);
  const asked=host.request();
  assert.deepEqual({...asked,requestId:'id'},{version:1,requestId:'id',mode:'ip',requestedAt:'2026-11-11T08:00:00.000Z'},'no domain and no email travel with an IP switch');
  assert.deepEqual(readDomainStatus(host.dir),{requestId:asked.requestId,state:'pending',mode:'ip',desiredDomain:'',currentDomain:'hk.example.com',message:'等待主机切换为 IP 反代（HTTP）',updatedAt:'2026-11-11T08:00:00.000Z'});
  host.hostAnswers('failed',{updatedAt:new Date(T0).toISOString()});
  assert.equal(host.follow({mode:'ip'},T0+10*MINUTE),false);
  assert.equal(host.follow({mode:'ip'},T0+11*MINUTE),true);
  host.hostAnswers('active',{currentDomain:'203.0.113.9'});
  assert.equal(host.follow({mode:'ip'},T0+12*MINUTE),false,'already on its IP');
  // Back to a domain: the same domain it was installed with needs a request now.
  assert.equal(host.follow({domain:'hk.example.com',email:'ops@example.com'},T0+13*MINUTE),true);
  assert.deepEqual([host.request().mode,host.request().desiredDomain,readDomainStatus(host.dir).currentDomain],['domain','hk.example.com','203.0.113.9']);
  // An agent installed in IP mode has nothing to ask for.
  const ipHost=agentHost(t,{mode:'ip',domain:'',ip:'198.51.100.7'});
  assert.equal(ipHost.follow({mode:'ip'},T0),false);
  assert.equal(ipHost.request(),null);
});

test('a domain or certificate email the host could not act on files nothing',t=>{
  const host=agentHost(t,{mode:'ip',domain:'',ip:'203.0.113.9'});
  for(const desired of [{domain:'jp.example.com',email:''},{domain:'jp.example.com',email:'not-an-email'},{domain:'jp.example.com:8443',email:'ops@example.com'},{domain:'bad_domain.example.com',email:'ops@example.com'},{domain:'https://jp.example.com/path',email:'ops@example.com'}]){
    assert.equal(host.follow(desired,T0),false,JSON.stringify(desired));
    assert.deepEqual(fs.readdirSync(host.dir),[],JSON.stringify(desired));
  }
});

test('an agent that enrolls again forgets what the host did for its previous life',t=>{
  const host=agentHost(t,{mode:'',domain:'hk.example.com',ip:''});
  host.follow({domain:'jp.example.com',email:'ops@example.com'},T0);
  assert.deepEqual(fs.readdirSync(host.dir).sort(),[DOMAIN_REQUEST_FILE,'host-domain-status.json']);
  forgetDomainSwitch(host.dir);
  assert.deepEqual(fs.readdirSync(host.dir),[]);
  assert.deepEqual(host.serving(),{mode:'domain',domain:'hk.example.com'});
  forgetDomainSwitch(host.dir);
});

test('no request is filed with a certificate email a host would refuse', () => {
  // The hosts write the email into .env, where `${` starts a variable for Compose, and hand it to
  // certbot as root. One rule (isCertificateEmail) decides, wherever an email comes in.
  const odd = ['ops${x@example.com', 'ops@ex\u0001ample.com', 'ops@example.com x', '用户@example.com', "a'b@example.com", 'a b@example.com', 'a@b@c', `${'a'.repeat(243)}@example.com`, '', null, undefined, 7];
  const fine = ['ops@example.com', 'First.Last+relay_1%x-y@Sub.Example-Domain.com', `${'a'.repeat(242)}@example.com`];
  assert.deepEqual([odd.map(isCertificateEmail), fine.map(isCertificateEmail)], [odd.map(() => false), fine.map(() => true)]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-domain-email-'));
  try {
    for (const email of odd.filter(value => typeof value === 'string' && value)) {
      assert.throws(() => normalizeCertificateEmail(email), /统一证书邮箱/, JSON.stringify(email));
      assert.throws(() => requestDomainSwitch({ dir, domain: 'hk.example.com', email }), /证书邮箱格式无效/, JSON.stringify(email));
      assert.equal(followDomain({ dir, desired: { mode: '', domain: 'hk.example.com', email }, installed: { mode: 'ip', domain: '', ip: '203.0.113.9' } }), false, JSON.stringify(email));
      assert.equal(cleanEntryRequest({ domain: 'entry.example.com', email, peers: [] }), null, JSON.stringify(email));
      assert.deepEqual(fs.readdirSync(dir), [], 'nothing was written');
    }
    assert.equal(normalizeCertificateEmail('  Ops@Example.com '), 'Ops@Example.com');
    assert.equal(requestDomainSwitch({ dir, domain: 'hk.example.com', email: 'First.Last+relay_1%x-y@Sub.Example-Domain.com' }).state, 'pending');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, DOMAIN_REQUEST_FILE), 'utf8')).certificateEmail, 'first.last+relay_1%x-y@sub.example-domain.com');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
