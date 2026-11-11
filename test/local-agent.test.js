import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalAgent } from '../src/local-agent.js';
import { newRouteAuthKey, ROUTE_AUTH_VERSION, routeTokenDigest } from '../src/route-auth.js';
import { deriveKey, tokenDigest } from '../src/security.js';
import { Store } from '../src/store.js';

function route(name='Original') {
  const routeAuthKey=newRouteAuthKey(),accessKey='existing-client-key';
  return {id:'node-1',alias:'charity',name,enabled:true,upstreams:['https://emby.example.com'],playbackUpstreams:[],allowPrivate:false,tlsVerify:true,showOnHome:false,clientProfile:{enabled:false},speedLimitMbps:0,monthlyQuotaGB:0,accessMode:'key',accessKey,authVersion:ROUTE_AUTH_VERSION,routeAuthKey,keyDigest:routeTokenDigest(accessKey,routeAuthKey)};
}

test('local agent completes register, pull, verify, atomic apply and ACK', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-local-agent-')),file=path.join(dir,'aegis.enc.json'),cache=path.join(dir,'local.snapshot');
  try {
    const key=deriveKey('a'.repeat(32)),store=new Store(file,key);store.data.routes=[route()];store.save();
    const agent=new LocalAgent({store,cacheFile:cache}),started=agent.start(),firstRoutes=agent.routeSource.getRoutes();
    assert.deepEqual(started,{ok:true,decision:'apply',revision:1,hash:store.data.controlPlane.localAgent.appliedHash});
    assert.equal(agent.status().inSync,true);
    assert.equal(agent.status().status,'online');
    assert.equal(store.data.controlPlane.localAgent.transport,'loopback');
    assert.equal(store.data.controlPlane.localAgent.pinnedPanelKeyId,store.data.controlPlane.panelSigningIdentity.keyId);
    assert.equal(store.data.controlPlane.localAgent.lastAck.status,'applied');
    assert.deepEqual(agent.status().routeIds,['node-1']);
    assert.equal(firstRoutes[0].accessKey,undefined);
    assert.equal(firstRoutes[0].name,'Original');
    const raw=fs.readFileSync(cache,'utf8');
    assert.equal(raw.includes('emby.example.com'),false);
    assert.equal(raw.includes('existing-client-key'),false);
    assert.equal(raw.includes(store.data.routes[0].routeAuthKey),false);
    assert.equal(raw.includes(store.data.routes[0].keyDigest),false);
    assert.equal(raw.includes(store.data.controlPlane.panelSigningIdentity.privateKey),false);
    assert.equal(fs.statSync(cache).mode&0o777,0o600);

    store.data.routes[0].name='Changed';store.save();
    // The panel machine is told through its subscription, like a remote machine's long poll.
    assert.deepEqual(agent.snapshots.refresh(),['local']);
    const secondRoutes=agent.routeSource.getRoutes();
    assert.equal(agent.status().appliedRevision,2);assert.equal(store.data.controlPlane.localAgent.lastAck.revision,2);
    assert.notEqual(secondRoutes,firstRoutes);
    assert.equal(firstRoutes[0].name,'Original');
    assert.equal(secondRoutes[0].name,'Changed');
    assert.equal(fs.existsSync(`${cache}.previous`),true);
    assert.equal(agent.reconcile().decision,'noop');
    assert.equal(agent.status().appliedRevision,2);

    store.data.deployments=[];store.save();
    assert.deepEqual(agent.snapshots.refresh(),['local']);
    assert.equal(agent.status().inSync,true);
    assert.equal(agent.routeSource.getRoutes().length,0);
    assert.deepEqual(agent.status().routeIds,[]);
    await store.flush();

    const restartedStore=new Store(file,key),restarted=new LocalAgent({store:restartedStore,cacheFile:cache});
    assert.equal(restarted.start().decision,'noop');
    assert.equal(restarted.routeSource.getRoutes().length,0);
    assert.equal(restarted.status().inSync,true);
  } finally { fs.rmSync(dir,{recursive:true}); }
});

test('a snapshot the panel machine cannot store is recorded as rejected; it keeps serving and recovers', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-local-refusal-')),file=path.join(dir,'aegis.enc.json'),cache=path.join(dir,'local.snapshot');
  try {
    const key=deriveKey('c'.repeat(32)),store=new Store(file,key);store.data.routes=[route()];store.save();
    const agent=new LocalAgent({store,cacheFile:cache});
    assert.equal(agent.start().ok,true);
    const local=store.data.controlPlane.localAgent,record=store.data.agents.find(item=>item.id==='local'),served=agent.routeSource.getRoutes();
    // The disk refuses the next snapshot: the copy of the current one cannot be put in place.
    fs.mkdirSync(`${cache}.previous`);
    store.data.routes[0].name='Changed';
    assert.deepEqual(agent.snapshots.refresh(),['local']);
    const status=agent.status();
    assert.deepEqual([status.applyState,status.inSync,status.desiredRevision,status.appliedRevision,status.lastAck.status,status.lastAck.revision],['error',false,2,1,'rejected',2]);
    assert.ok(status.error&&status.error===status.lastAck.error,'the reason is kept for the card');
    assert.deepEqual([local.appliedRevision,record.applyState,record.appliedRevision,record.desiredRevision,record.proxyHealthy],[1,'error',1,2,false]);
    assert.equal(agent.routeSource.getRoutes(),served,'the last good snapshot is still served');
    assert.equal(agent.reconcile().ok,false,'and it stays refused while the disk does');
    // The disk is fine again.
    fs.rmdirSync(`${cache}.previous`);
    assert.deepEqual(agent.reconcile(),{ok:true,decision:'apply',revision:2,hash:local.appliedHash});
    const after=agent.status();
    assert.deepEqual([after.applyState,after.inSync,after.appliedRevision,after.error,after.lastAck.status,record.applyState,record.appliedRevision],['active',true,2,null,'applied','active',2]);
    assert.equal(agent.routeSource.getRoutes()[0].name,'Changed');
  } finally { fs.rmSync(dir,{recursive:true}); }
});

test('legacy digest-only routes remain on the compatibility data source until rotated', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-local-legacy-')),file=path.join(dir,'aegis.enc.json');
  try {
    const key=deriveKey('b'.repeat(32)),store=new Store(file,key),accessKey='legacy-client-key';
    store.data.routes=[{id:'legacy',alias:'legacy',name:'Legacy',enabled:true,upstreams:['https://emby.example.com'],accessMode:'key',keyDigest:tokenDigest(accessKey,key),authVersion:'master-hmac-sha256-v1',authMigrationRequired:true}];store.save();
    const agent=new LocalAgent({store,cacheFile:path.join(dir,'local.snapshot')}),result=agent.start();
    assert.equal(result.ok,false);
    assert.match(result.error,/requires an access-key rotation/);
    assert.equal(agent.routeSource.getRoutes()[0].alias,'legacy');
    assert.equal(agent.status().applyState,'error');
  } finally { fs.rmSync(dir,{recursive:true}); }
});
