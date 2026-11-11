import crypto from 'node:crypto';
import fs from 'node:fs';
import { b64u } from './security.js';
import { decodeNodes } from './node-wire.js';
import { verifySnapshot } from './snapshot.js';
import { writeAtomic } from './store.js';

function freeze(value) {
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){
    for(const child of Object.values(value))freeze(child);
    Object.freeze(value);
  }
  return value;
}

function cloneRoutes(routes) {
  return freeze(structuredClone(Array.isArray(routes)?routes:[]));
}

export class AtomicRouteSource {
  constructor(routes=[]) { this.routes=cloneRoutes(routes); }
  getRoutes() { return this.routes; }
  apply(routes) { this.routes=cloneRoutes(routes); return this.routes; }
}

// A file only this machine reads back, sealed with the machine's 32-byte storage key.
export function sealLocal(value, key) {
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  const data=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);
  return JSON.stringify({v:1,iv:b64u(iv),tag:b64u(cipher.getAuthTag()),data:b64u(data)});
}

export function openLocal(payload, key) {
  const env=JSON.parse(payload),decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(env.iv,'base64url'));
  decipher.setAuthTag(Buffer.from(env.tag,'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(env.data,'base64url')),decipher.final()]).toString('utf8'));
}

// One machine following its desired snapshot (期望快照, see GLOSSARY.md): the snapshot it has applied,
// the sealed copy it restarts from, and the nodes it serves. The panel machine and every agent hold
// theirs the same way, so this is the one place that verifies a snapshot against the pinned panel key,
// refuses a rollback, and swaps the served nodes only after the snapshot is safely on disk.
//
// The seam is who hands a snapshot over and where the answer goes: the panel machine is called
// synchronously by the snapshots it subscribes to and records the result in the store; an agent long
// polls the panel and sends a signed acknowledgement. Neither is this module's business.
export class SnapshotFollower {
  // `routeSource` is what the data plane reads; it serves what it holds until a snapshot is loaded or
  // accepted.
  constructor({cacheFile,previousFile=`${cacheFile}.previous`,storageKey,panelIdentity,routeSource=new AtomicRouteSource()}) {
    if(!Buffer.isBuffer(storageKey)||storageKey.length!==32)throw new Error('invalid storage key');
    this.cacheFile=cacheFile;this.previousFile=previousFile;this.storageKey=storageKey;this.panelIdentity=panelIdentity;
    this.routeSource=routeSource;
    this.revision=0;this.hash=null;this.applyState='waiting';this.error='';
  }

  // Start from the snapshot applied before the restart. False when there is none, or when it cannot be
  // trusted any more (the reason is left in `error`); the machine then waits for a fresh one.
  load() {
    if(!fs.existsSync(this.cacheFile))return false;
    try {
      const snapshot=openLocal(fs.readFileSync(this.cacheFile,'utf8'),this.storageKey);
      verifySnapshot(snapshot,this.panelIdentity);
      this.routeSource.apply(decodeNodes(snapshot.nodes));
      this.revision=snapshot.revision;this.hash=snapshot.hash;this.applyState='active';this.error='';
      return true;
    } catch(error) {
      this.applyState='error';this.error=`cached snapshot rejected: ${error.message}`.slice(0,240);
      return false;
    }
  }

  // Verify, persist, then serve. Never throws: a snapshot that is refused leaves the machine serving
  // what it served before, in the `error` state, until one is accepted. `decision` is 'apply', 'noop'
  // (the snapshot already applied) or 'reject'; `revision` and `hash` are what is applied afterwards.
  accept(snapshot) {
    try {
      const decision=verifySnapshot(snapshot,this.panelIdentity,{currentRevision:this.revision,currentHash:this.hash});
      if(decision.status==='apply'){
        const routes=decodeNodes(snapshot.nodes);
        // Nodes that cannot be served must fail here, before the disk is touched.
        cloneRoutes(routes);
        if(fs.existsSync(this.cacheFile))writeAtomic(this.previousFile,fs.readFileSync(this.cacheFile));
        writeAtomic(this.cacheFile,sealLocal(snapshot,this.storageKey));
        this.routeSource.apply(routes);
        this.revision=snapshot.revision;this.hash=snapshot.hash;
      }
      this.applyState='active';this.error='';
      return {ok:true,decision:decision.status,revision:this.revision,hash:this.hash,error:''};
    } catch(error) {
      this.applyState='error';this.error=String(error?.message||error).slice(0,240);
      return {ok:false,decision:'reject',revision:this.revision,hash:this.hash,error:this.error};
    }
  }
}
