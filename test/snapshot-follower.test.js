import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson } from '../src/canonical-json.js';
import { compileSnapshot, generatePanelSigningIdentity } from '../src/snapshot.js';
import { SnapshotFollower } from '../src/snapshot-follower.js';

const node=(alias,upstream='https://emby.example.com')=>({id:`node-${alias}`,alias,name:alias,enabled:true,upstreams:[upstream],accessMode:'alias_only'});
const pinned=identity=>({algorithm:'Ed25519',keyId:identity.keyId,publicKey:identity.publicKey});
const aliases=follower=>follower.routeSource.getRoutes().map(route=>route.alias);

// A machine's data directory, its storage key, and the panel key it pinned when it joined.
function machine(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-follower-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const panel=generatePanelSigningIdentity(),storageKey=crypto.randomBytes(32),cacheFile=path.join(dir,'current.snapshot');
  const follower=(overrides={})=>new SnapshotFollower({cacheFile,storageKey,panelIdentity:pinned(panel),...overrides});
  const snapshot=(revision,nodes,signingIdentity=panel)=>compileSnapshot({revision,nodes,signingIdentity});
  return {dir,panel,storageKey,cacheFile,follower,snapshot};
}

test('a machine serves the snapshot it accepts, keeps it sealed on disk, and restarts from it',t=>{
  const m=machine(t),follower=m.follower();
  assert.equal(follower.load(),false,'nothing cached on a fresh machine');
  assert.deepEqual([follower.applyState,follower.revision,aliases(follower)],['waiting',0,[]]);

  const first=m.snapshot(1,[node('movies')]);
  assert.deepEqual(follower.accept(first),{ok:true,decision:'apply',revision:1,hash:first.hash,error:''});
  assert.deepEqual([follower.applyState,follower.revision,follower.hash,aliases(follower)],['active',1,first.hash,['movies']]);
  const sealed=fs.readFileSync(m.cacheFile,'utf8');
  assert.equal(sealed.includes('emby.example.com'),false,'the cache never holds an upstream in the clear');
  assert.equal(fs.statSync(m.cacheFile).mode&0o777,0o600);

  // The same snapshot again changes nothing, not even the object the data plane holds.
  const served=follower.routeSource.getRoutes();
  assert.equal(follower.accept(first).decision,'noop');
  assert.equal(follower.routeSource.getRoutes(),served);
  assert.equal(fs.readFileSync(m.cacheFile,'utf8'),sealed);

  const second=m.snapshot(2,[node('movies'),node('shows')]);
  assert.equal(follower.accept(second).decision,'apply');
  assert.deepEqual(aliases(follower),['movies','shows']);
  assert.deepEqual(aliases({routeSource:{getRoutes:()=>served}}),['movies'],'requests in flight keep the nodes they started with');
  assert.equal(fs.readFileSync(`${m.cacheFile}.previous`,'utf8'),sealed,'the snapshot it replaced is kept beside it');

  const restarted=m.follower();
  assert.equal(restarted.load(),true);
  assert.deepEqual([restarted.applyState,restarted.revision,restarted.hash,aliases(restarted)],['active',2,second.hash,['movies','shows']]);
  assert.equal(restarted.accept(second).decision,'noop','after a restart the panel sends nothing new');
});

test('a snapshot the machine cannot trust is refused and what it serves is left exactly as it was',t=>{
  const m=machine(t),follower=m.follower(),stranger=generatePanelSigningIdentity();
  const applied=m.snapshot(2,[node('movies')]);follower.accept(applied);
  const served=follower.routeSource.getRoutes(),sealed=fs.readFileSync(m.cacheFile,'utf8');
  const tampered=structuredClone(m.snapshot(3,[node('movies')]));tampered.nodes[0].upstreams=['https://attacker.example.com'];
  const body={schemaVersion:1,revision:3,nodes:[{id:'node-x',alias:'x'}]},canonical=canonicalJson(body);
  const unservable={...body,hash:crypto.createHash('sha256').update(canonical).digest('base64url'),keyId:m.panel.keyId,signature:crypto.sign(null,Buffer.from(canonical),crypto.createPrivateKey({key:Buffer.from(m.panel.privateKey,'base64url'),format:'der',type:'pkcs8'})).toString('base64url')};
  const refused=[
    ['altered after signing',tampered,/hash mismatch/],
    ['signed by another panel',m.snapshot(3,[node('movies')],stranger),/signing key mismatch/],
    ['older than the one applied',m.snapshot(1,[node('old')]),/rollback rejected/],
    ['a different snapshot under the applied revision',m.snapshot(2,[node('other')]),/revision conflict/],
    ['properly signed nodes that cannot be served',unservable,/no access block/],
    ['not a snapshot at all',null,/revision/]
  ];
  for(const [what,snapshot,reason] of refused){
    const result=follower.accept(snapshot);
    assert.deepEqual([result.ok,result.decision,result.revision,result.hash],[false,'reject',2,applied.hash],what);
    assert.match(result.error,reason,what);
    assert.deepEqual([follower.applyState,follower.error],['error',result.error],what);
    assert.equal(follower.routeSource.getRoutes(),served,what);
    assert.equal(fs.readFileSync(m.cacheFile,'utf8'),sealed,what);
    assert.equal(fs.existsSync(`${m.cacheFile}.previous`),false,what);
  }
  // The next good snapshot ends the error state.
  assert.equal(follower.accept(m.snapshot(3,[node('movies'),node('shows')])).ok,true);
  assert.deepEqual([follower.applyState,follower.error,follower.revision,aliases(follower)],['active','',3,['movies','shows']]);
});

test('a cache the machine can no longer trust is not served',t=>{
  const m=machine(t);m.follower().accept(m.snapshot(4,[node('movies')]));
  // Sealed with another storage key: what a re-enrolled machine finds from its previous life.
  const rekeyed=m.follower({storageKey:crypto.randomBytes(32)});
  assert.equal(rekeyed.load(),false);
  assert.deepEqual([rekeyed.applyState,rekeyed.revision,aliases(rekeyed)],['error',0,[]]);
  assert.match(rekeyed.error,/^cached snapshot rejected: /);
  // Signed by a panel key this machine has not pinned.
  const repinned=m.follower({panelIdentity:pinned(generatePanelSigningIdentity())});
  assert.equal(repinned.load(),false);
  assert.match(repinned.error,/^cached snapshot rejected: snapshot signing key mismatch/);
  // Either way the machine recovers with the next snapshot from the panel, whatever its revision.
  assert.equal(rekeyed.accept(m.snapshot(4,[node('movies')])).decision,'apply');
  assert.deepEqual([rekeyed.applyState,aliases(rekeyed)],['active',['movies']]);
});

test('the data plane keeps the route source it was handed, and serves from it until a snapshot arrives',t=>{
  const m=machine(t),routeSource={routes:['legacy'],getRoutes(){return this.routes},apply(routes){this.routes=routes.map(route=>route.alias);return this.routes}};
  const follower=m.follower({routeSource});
  assert.equal(follower.routeSource,routeSource);
  assert.deepEqual(routeSource.getRoutes(),['legacy']);
  follower.accept(m.snapshot(1,[node('movies')]));
  assert.deepEqual(routeSource.getRoutes(),['movies']);
  assert.throws(()=>m.follower({storageKey:Buffer.alloc(16)}),/invalid storage key/);
});
