import test from 'node:test';
import assert from 'node:assert/strict';
import { DesiredSnapshots } from '../src/desired-snapshots.js';
import { LINE_SYNC_CAPABILITY } from '../src/line-sync.js';
import { PLAYBACK_OBSERVATION_CAPABILITY } from '../src/playback-observation.js';
import { EGRESS_CAPABILITY, STEERING_CAPABILITY } from '../src/steering.js';
import { newRouteAuthKey, ROUTE_AUTH_VERSION, routeTokenDigest } from '../src/route-auth.js';

const keyRoute=(id,extra={})=>{const routeAuthKey=newRouteAuthKey();return {id,alias:id,name:id,enabled:true,accessMode:'key',authVersion:ROUTE_AUTH_VERSION,routeAuthKey,keyDigest:routeTokenDigest('key123',routeAuthKey),upstreams:['https://emby.example.net'],...extra}};

// The panel machine, an older machine (hk) and an up-to-date one (jp). r1 is served by all three, r2 by
// hk alone. Line sync is on (the default), so the machines that know it list r1's machines.
function panel({steering=false,egress=false}={}) {
  const jpCapabilities=['config-v1',LINE_SYNC_CAPABILITY,...(steering?[STEERING_CAPABILITY]:[]),...(egress?[EGRESS_CAPABILITY]:[])];
  const data={
    routes:[keyRoute('r1',{...(steering?{autoSteer:{enabled:true}}:{}),...(egress?{egressAgentId:'jp'}:{})}),keyRoute('r2')],
    agents:[
      {id:'local',name:'主机',domain:'panel.example.com',state:'active'},
      {id:'hk',name:'香港',domain:'hk.example.com',proxyMode:'domain',state:'active',capabilities:['config-v1']},
      {id:'jp',name:'日本',domain:'jp.example.com',proxyMode:'domain',state:'active',capabilities:jpCapabilities},
      {id:'gone',name:'已撤销',domain:'gone.example.com',state:'revoked'}
    ],
    deployments:[['local','r1'],['hk','r1'],['jp','r1'],['hk','r2'],['gone','r1']].map(([agentId,routeId])=>({agentId,routeId,enabled:true})),
    controlPlane:{localAgent:{id:'local',desiredState:null}},
    settings:steering?{steering:{mode:'on'}}:{}
  };
  const store={data,save(){},audit(){}};
  return {data,store,snapshots:new DesiredSnapshots({store,localBase:'https://panel.example.com'})};
}
const agent=(data,id)=>data.agents.find(item=>item.id===id);
const route=(data,id)=>data.routes.find(item=>item.id===id);
// Which machines a change reaches: everything is compiled first, then the change is made.
function changedBy(change,options) {
  const {data,snapshots}=panel(options);snapshots.refresh();change(data);
  return snapshots.refresh().sort();
}

test('the first refresh compiles every machine but revoked ones; a second one changes nothing and signs nothing',()=>{
  const {data,snapshots}=panel(),heard=[];
  snapshots.subscribe(changed=>heard.push(changed));
  assert.deepEqual(snapshots.refresh().sort(),['hk','jp','local']);
  assert.deepEqual(['local','hk','jp'].map(id=>agent(data,id).desiredRevision),[1,1,1]);
  assert.equal(agent(data,'gone').desiredRevision,undefined);
  assert.equal(data.controlPlane.localAgent.desiredState.revision,1,'the panel machine keeps its state on the local agent record');
  const before=snapshots.desired('hk');
  assert.deepEqual(snapshots.refresh(),[]);
  assert.equal(snapshots.desired('hk'),before,'the very same signed snapshot: no new signature');
  assert.equal(heard.length,1,'nobody is told about a refresh that changed nothing');
});

test('each change reaches exactly the machines whose snapshot it reshapes',()=>{
  const cases=[
    ['a node only one machine serves',data=>{route(data,'r2').name='renamed'},['hk']],
    ['a deployment',data=>{data.deployments=data.deployments.filter(item=>!(item.agentId==='hk'&&item.routeId==='r2'))},['hk']],
    ['a renamed machine: the line lists that name it',data=>{agent(data,'hk').name='香港 2'},['jp','local']],
    ['a reordered machine',data=>{agent(data,'hk').sortOrder=-5},['jp','local']],
    ['a new machine domain',data=>{agent(data,'jp').domain='jp2.example.com'},['jp','local']],
    ['line sync switched off',data=>{route(data,'r1').lineSync=false},['jp','local']],
    ['heartbeat fields only',data=>{Object.assign(agent(data,'hk'),{lastSeen:new Date().toISOString(),appliedRevision:7,applyState:'active',telemetry:{x:1}})},[]],
    ['a revoked machine',data=>{agent(data,'gone').name='still gone'},[]]
  ];
  for(const [name,change,expected] of cases)assert.deepEqual(changedBy(change),expected,name);
});

test('a new capability reaches the machines that read it, and nobody when nothing reads it yet',()=>{
  const gain=capability=>data=>{agent(data,'hk').capabilities.push(capability)};
  assert.deepEqual(changedBy(gain(LINE_SYNC_CAPABILITY)),['hk'],'hk now gets the line lists itself');
  assert.deepEqual(changedBy(gain(PLAYBACK_OBSERVATION_CAPABILITY)),[],'no steering, so nothing observes playback');
  assert.deepEqual(changedBy(gain(STEERING_CAPABILITY)),[],'steering is off');
  assert.deepEqual(changedBy(gain(STEERING_CAPABILITY),{steering:true}),['hk','jp','local'],'hk joins the steering peers of r1');
  assert.deepEqual(changedBy(gain(PLAYBACK_OBSERVATION_CAPABILITY),{steering:true}),['hk'],'hk starts observing r1');
  assert.deepEqual(changedBy(data=>{data.settings.steering={mode:'off'}},{steering:true}),['jp','local'],'steering switched off');
  assert.deepEqual(changedBy(gain(EGRESS_CAPABILITY),{egress:true}),['hk','local'],'the last machine able to relay: the egress (jp) itself carries no egress block');
});

test('a machine that cannot be compiled is told once and never holds the others back',()=>{
  const {data,snapshots}=panel(),heard=[];
  snapshots.refresh();snapshots.subscribe(changed=>heard.push(changed));
  route(data,'r2').authMigrationRequired=true;
  assert.deepEqual(snapshots.refresh(),['hk'],'hk has started failing');
  assert.throws(()=>snapshots.desired('hk'),/access-key rotation/,'its poll and check-in report the reason');
  agent(data,'jp').name='日本 2';
  assert.deepEqual(snapshots.refresh().sort(),['jp','local'],'still failing: hk is not told again, the others still are');
  delete route(data,'r2').authMigrationRequired;
  assert.deepEqual(snapshots.refresh(),['hk']);
  assert.equal(snapshots.desired('hk').revision,1,'back to what it had: same content, same revision');
  assert.deepEqual(heard,[['hk'],['jp','local'],['hk']]);
});

test('revisions continue across a restart, and a deleted machine is forgotten',()=>{
  const {data,store,snapshots}=panel();
  snapshots.refresh();route(data,'r2').name='renamed';snapshots.refresh();
  assert.equal(snapshots.desired('hk').revision,2);
  const restarted=new DesiredSnapshots({store,localBase:'https://panel.example.com'});
  assert.deepEqual(restarted.refresh().sort(),['hk','jp','local'],'a fresh module hands every machine out once');
  assert.deepEqual(['local','hk','jp'].map(id=>restarted.desired(id).revision),[1,2,1],'nothing changed, so no revision moved');
  data.agents=data.agents.filter(item=>item.id!=='jp');
  assert.deepEqual(restarted.refresh().sort(),['local'],'r1 lost a line on the panel machine');
  assert.throws(()=>restarted.desired('jp'),/unknown machine/);
});
