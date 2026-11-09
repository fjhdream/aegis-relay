import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Panel } from '../src/panel.js';
import { DesiredSnapshots } from '../src/desired-snapshots.js';
import { LocalAgent } from '../src/local-agent.js';
import { DOMAIN_REQUEST_FILE } from '../src/domain-control.js';

const UPSTREAM='http://127.0.0.1:9';
// A panel over an in-memory store, with the real snapshots, local agent and host request files (in a
// temporary data directory). Besides the panel machine: hk (a ready machine) and fresh (no domain yet).
function setup({publicBaseUrl='https://panel.example.com',configuredLocalDomain='proxy.example.com'}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-panel-')),dataFile=path.join(dir,'aegis.enc.json'),audit=[];
  const data={routes:[],agents:[],deployments:[],settings:{certificateEmail:'ops@example.com'},enrollmentTokens:[],audit:[],controlPlane:{}};
  const store={file:dataFile,data,save(){},audit(event){audit.push(event)}};
  const snapshots=new DesiredSnapshots({store,localBase:'https://proxy.example.com'});
  const localAgent=new LocalAgent({store,snapshots,cacheFile:path.join(dir,'local.snapshot')});localAgent.start();
  data.agents.find(agent=>agent.id==='local').domain=configuredLocalDomain;
  data.agents.push({id:'hk',name:'香港',domain:'hk.example.com',proxyMode:'domain',state:'active',capabilities:['config-v1','steering-v1','line-sync-v1']},{id:'fresh',name:'新机器',domain:'',state:'active',capabilities:[]});
  const panel=new Panel({store,snapshots,localAgent,dataFile,publicBaseUrl,localProxyBaseUrl:'https://proxy.example.com',configuredLocalDomain});
  snapshots.refresh();
  const file=name=>{try{return JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'))}catch{return null}};
  return {panel,data,dir,audit,snapshots,localAgent,file,cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
const deployedOn=(data,routeId)=>data.deployments.filter(item=>item.routeId===routeId).map(item=>item.agentId).sort();
const rejects=(call,status,message)=>assert.throws(call,error=>error.status===status&&(!message||error.message===message),`${status} ${message||''}`);

test('a new node goes to the machine picked for it, or to the panel machine when that one cannot serve it',async()=>{
  const {panel,data,cleanup}=setup();
  try {
    const onHk=await panel.createRoute({alias:'hk-node',upstreams:UPSTREAM,allowPrivate:true,agentId:'hk'},'test');
    assert.deepEqual(deployedOn(data,onHk.route.id),['hk'],'the panel machine does not pick it up as well');
    assert.equal(onHk.publicBaseUrl,'https://hk.example.com','and the address handed out is the machine\'s own');
    const onFresh=await panel.createRoute({alias:'fresh-node',upstreams:UPSTREAM,allowPrivate:true,agentId:'fresh'},'test');
    assert.deepEqual(deployedOn(data,onFresh.route.id),['fresh','local'],'a machine without a domain yet cannot serve the address, so the panel machine does');
    const plain=await panel.createRoute({alias:'plain',upstreams:UPSTREAM,allowPrivate:true},'test');
    assert.deepEqual(deployedOn(data,plain.route.id),['local']);
    await assert.rejects(panel.createRoute({alias:'plain',upstreams:UPSTREAM,allowPrivate:true},'test'),error=>error.status===409);
  } finally { cleanup(); }
});

test('the panel machine cannot be deleted; deleting a machine takes its deployments and reshapes every snapshot',async()=>{
  const {panel,data,snapshots,localAgent,audit,cleanup}=setup();
  try {
    const {route}=await panel.createRoute({alias:'movie',upstreams:UPSTREAM,allowPrivate:true},'test');
    panel.updateAgent('hk',{routeIds:[route.id]},'test');
    const lines=()=>snapshots.desired('local').nodes[0].lines.map(line=>line.name);
    assert.ok(lines().includes('香港'),'both machines serve it, so both are lines');
    rejects(()=>panel.deleteAgent('local','test'),409,'the local agent cannot be deleted');
    rejects(()=>panel.deleteAgent('missing','test'),404,'agent not found');
    panel.deleteAgent('hk','test');
    assert.deepEqual(deployedOn(data,route.id),['local']);
    assert.equal(lines().includes('香港'),false,'the panel machine\'s line list lost hk');
    assert.equal(localAgent.routeSource.getRoutes()[0].lines.some(line=>line.name==='香港'),false,'and the panel machine serves that at once');
    assert.equal(audit.at(-1),'agent.deleted');
  } finally { cleanup(); }
});

test('machine domains: a remote one waits for its machine, an empty one switches it to IP, the panel machine files a host request',()=>{
  const {panel,data,file,cleanup}=setup();
  try {
    const hk=panel.updateAgent('hk',{domain:'hk2.example.com'},'test').agent;
    assert.deepEqual([agent(data,'hk').desiredMode,agent(data,'hk').desiredDomain,hk.domainChange.state],['domain','hk2.example.com','pending']);
    panel.updateAgent('hk',{domain:''},'test');
    assert.deepEqual([agent(data,'hk').desiredMode,agent(data,'hk').desiredDomain,agent(data,'hk').domainStatus.mode],['ip',undefined,'ip']);
    rejects(()=>panel.updateAgent('local',{domain:''},'test'),400,'本机代理域名不能为空，请填写与面板不同的子域名');
    rejects(()=>panel.updateAgent('local',{domain:'panel.example.com'},'test'),409,'代理域名不能与面板域名相同');
    const local=panel.updateAgent('local',{domain:'edge.example.com'},'test').agent;
    assert.equal(file(DOMAIN_REQUEST_FILE).desiredDomain,'edge.example.com');
    assert.equal(local.domainChange.state,'pending');
    rejects(()=>panel.updateAgent('local',{domain:'other.example.com'},'test'),409,'正在切换到 edge.example.com，完成后再提交新域名');
  } finally { cleanup(); }
  const insecure=setup({publicBaseUrl:'http://panel.example.com'});
  try { rejects(()=>insecure.panel.updateAgent('local',{domain:'edge.example.com'},'test'),409,'请先在部署向导完成面板 HTTPS 配置'); }
  finally { insecure.cleanup(); }
});
const agent=(data,id)=>data.agents.find(item=>item.id===id);

test('a finished domain switch stops showing; a pending, failed or not yet live one stays',()=>{
  const {panel,data,cleanup}=setup();
  try {
    const hk=agent(data,'hk'),change=state=>({requestId:'r',state,mode:'domain',desiredDomain:'hk.example.com',currentDomain:'hk.example.com',message:'',updatedAt:''});
    hk.domainStatus=change('active');assert.equal(panel.agentView(hk).domainChange,null);
    for(const state of ['pending','applying','failed']){hk.domainStatus=change(state);assert.equal(panel.agentView(hk).domainChange.state,state);}
    hk.domainStatus={...change('active'),currentDomain:'hk3.example.com'};assert.equal(panel.agentView(hk).domainChange.state,'active','active elsewhere than the live domain');
  } finally { cleanup(); }
});

test('a rejected change writes nothing',async()=>{
  const {panel,data,audit,file,cleanup}=setup();
  try {
    const before=structuredClone(data),events=audit.length;
    rejects(()=>panel.updateAgent('hk',{name:'新名字',domain:'x.example.com',routeIds:['missing']},'test'),400,'unknown route id');
    rejects(()=>panel.updateAgent('local',{name:'新名字',domain:''},'test'),400);
    rejects(()=>panel.updateAgent('hk',{name:' '},'test'),400,'invalid agent name');
    rejects(()=>panel.updateSteering({mode:'on',entryDomain:'panel.example.com'},'test'),409,'入口域名不能与面板域名相同');
    assert.deepEqual(data,before,'the machines and settings are untouched');
    assert.equal(file(DOMAIN_REQUEST_FILE),null,'and no host request was filed');
    assert.equal(audit.length,events,'nor anything audited');
    const {route}=await panel.createRoute({alias:'movie',upstreams:UPSTREAM,allowPrivate:true},'test');
    const snapshot=structuredClone(data);
    await assert.rejects(panel.updateRoute(route.id,{name:'renamed',egressAgentId:'ghost'},'test'),error=>error.status===400);
    assert.deepEqual(data,snapshot,'the node is untouched');
  } finally { cleanup(); }
});

test('machines are listed by their order, and an order change reaches the line lists',async()=>{
  const {panel,snapshots,cleanup}=setup();
  try {
    const {route}=await panel.createRoute({alias:'movie',upstreams:UPSTREAM,allowPrivate:true},'test');
    panel.updateAgent('hk',{routeIds:[route.id]},'test');
    const firstLine=()=>snapshots.desired('local').nodes[0].lines[0].name;
    const before=firstLine();
    panel.updateAgent('hk',{sortOrder:-5},'test');
    assert.equal(panel.agents()[0].id,'hk');
    assert.equal(firstLine(),'香港');assert.notEqual(before,'香港');
  } finally { cleanup(); }
});

test('every change brings the entry domain in line at once, deleting a machine included',()=>{
  const {panel,dir,file,cleanup}=setup();
  try {
    panel.updateSteering({mode:'on',entryDomain:'go.example.com'},'test');
    assert.deepEqual(file('host-entry-request.json').peers,['hk.example.com'],'the panel machine asks its host for the entry domain');
    // The host applies it.
    const applied=file('host-entry-status.json');
    fs.rmSync(path.join(dir,'host-entry-request.json'));
    fs.writeFileSync(path.join(dir,'host-entry-status.json'),JSON.stringify({...applied,state:'active'}));
    panel.updateAgent('fresh',{name:'仍然新'},'test');
    assert.equal(file('host-entry-request.json'),null,'nothing changed for the entry: no new request');
    panel.deleteAgent('hk','test');
    assert.deepEqual(file('host-entry-request.json').peers,[],'without hk, at once rather than on the next 30-second check');
  } finally { cleanup(); }
});
