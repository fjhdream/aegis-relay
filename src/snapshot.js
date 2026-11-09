import crypto from 'node:crypto';
import { canonicalJson } from './canonical-json.js';
import { b64u, timingEqual } from './security.js';
import { agentSnapshotNodes } from './steering-topology.js';
import { encodeNodes } from './node-wire.js';

export const SNAPSHOT_SCHEMA_VERSION=1;

const sha256=value=>b64u(crypto.createHash('sha256').update(value).digest());
const deepFreeze=value=>{
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){
    for(const child of Object.values(value))deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

function safeRevision(value, allowZero=false) {
  const revision=Number(value);
  if(!Number.isSafeInteger(revision)||revision<(allowZero?0:1))throw new Error('revision must be a monotonic positive safe integer');
  return revision;
}

function importPrivate(identity) {
  return crypto.createPrivateKey({key:Buffer.from(identity.privateKey,'base64url'),format:'der',type:'pkcs8'});
}

function importPublic(identity) {
  return crypto.createPublicKey({key:Buffer.from(identity.publicKey,'base64url'),format:'der',type:'spki'});
}

function validateIdentity(identity) {
  if(identity?.algorithm!=='Ed25519')throw new Error('invalid panel signing identity');
  const publicKey=importPublic(identity),privateKey=importPrivate(identity),publicDer=publicKey.export({format:'der',type:'spki'});
  const keyId=b64u(crypto.createHash('sha256').update(publicDer).digest().subarray(0,16));
  if(!timingEqual(keyId,identity.keyId))throw new Error('panel signing key id mismatch');
  const challenge=Buffer.from('AegisRelay-panel-key-check-v1');
  if(!crypto.verify(null,challenge,publicKey,crypto.sign(null,challenge,privateKey)))throw new Error('panel signing key pair mismatch');
  return identity;
}

export function generatePanelSigningIdentity() {
  const {privateKey,publicKey}=crypto.generateKeyPairSync('ed25519');
  const publicDer=publicKey.export({format:'der',type:'spki'}),privateDer=privateKey.export({format:'der',type:'pkcs8'});
  return {algorithm:'Ed25519',keyId:b64u(crypto.createHash('sha256').update(publicDer).digest().subarray(0,16)),publicKey:b64u(publicDer),privateKey:b64u(privateDer)};
}

export function ensurePanelSigningIdentity(store) {
  const current=store.data.controlPlane?.panelSigningIdentity;
  if(current){
    return validateIdentity(current);
  }
  const identity=generatePanelSigningIdentity();
  store.data.controlPlane={...(store.data.controlPlane||{}),panelSigningIdentity:identity};
  store.save();
  return validateIdentity(identity);
}

function compileNormalizedSnapshot({revision,nodes,signingIdentity}) {
  validateIdentity(signingIdentity);
  const body={schemaVersion:SNAPSHOT_SCHEMA_VERSION,revision:safeRevision(revision),nodes};
  const canonicalBody=canonicalJson(body),hash=sha256(canonicalBody);
  const signature=b64u(crypto.sign(null,Buffer.from(canonicalBody,'utf8'),importPrivate(signingIdentity)));
  return deepFreeze({...body,hash,keyId:signingIdentity.keyId,signature});
}

export function compileSnapshot({revision,nodes,signingIdentity}) {
  return compileNormalizedSnapshot({revision,nodes:encodeNodes(nodes),signingIdentity});
}

// previousSnapshot is the signed snapshot previousState describes, when the caller still holds it: an
// unchanged machine then gets it back as it is, without another signature.
export function compileDesiredSnapshot({nodes,previousState=null,previousSnapshot=null,signingIdentity}) {
  const normalized=encodeNodes(nodes);
  const contentHash=sha256(canonicalJson({schemaVersion:SNAPSHOT_SCHEMA_VERSION,nodes:normalized}));
  const previousRevision=previousState?safeRevision(previousState.revision,true):0;
  const unchanged=previousState?.contentHash===contentHash&&previousState?.keyId===signingIdentity.keyId;
  if(unchanged&&previousSnapshot&&previousSnapshot.revision===previousRevision&&previousSnapshot.hash===previousState.snapshotHash)return {snapshot:previousSnapshot,state:previousState};
  const revision=unchanged?previousRevision:previousRevision+1;
  if(revision<1)throw new Error('the first snapshot must use revision 1');
  const snapshot=compileNormalizedSnapshot({revision,nodes:normalized,signingIdentity});
  return {snapshot,state:Object.freeze({revision,contentHash,snapshotHash:snapshot.hash,keyId:signingIdentity.keyId})};
}

export function compileAgentDesiredSnapshot({data,agentId,previousState=null,previousSnapshot=null,signingIdentity,localBase=''}) {
  if(!data||typeof data!=='object')throw new Error('agent snapshot requires store data');
  if(!String(agentId||'').trim())throw new Error('agent snapshot requires agentId');
  return compileDesiredSnapshot({nodes:agentSnapshotNodes(data,agentId,{localBase}),previousState,previousSnapshot,signingIdentity});
}

export function verifySnapshot(snapshot, signingIdentity, {currentRevision=0,currentHash=null}={}) {
  const revision=safeRevision(snapshot?.revision),activeRevision=safeRevision(currentRevision,true);
  const body={schemaVersion:snapshot.schemaVersion,revision,nodes:snapshot.nodes};
  if(body.schemaVersion!==SNAPSHOT_SCHEMA_VERSION)throw new Error('unsupported snapshot schemaVersion');
  const canonicalBody=canonicalJson(body),expectedHash=sha256(canonicalBody);
  if(!timingEqual(expectedHash,snapshot.hash))throw new Error('snapshot hash mismatch');
  if(snapshot.keyId!==signingIdentity.keyId)throw new Error('snapshot signing key mismatch');
  if(!crypto.verify(null,Buffer.from(canonicalBody,'utf8'),importPublic(signingIdentity),Buffer.from(snapshot.signature,'base64url')))throw new Error('snapshot signature invalid');
  if(revision<activeRevision)throw new Error('snapshot revision rollback rejected');
  if(revision===activeRevision){
    if(currentHash!==snapshot.hash)throw new Error('snapshot revision conflict');
    return {status:'noop',revision,hash:snapshot.hash};
  }
  return {status:'apply',revision,hash:snapshot.hash};
}
