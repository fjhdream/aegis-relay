import { ensurePanelSigningIdentity } from './snapshot.js';
import { randomToken, timingEqual } from './security.js';
import { ensureAgentRegistry, LOCAL_AGENT_ID, routeIdsForAgent, routesForAgent } from './agent-registry.js';
import { DesiredSnapshots } from './desired-snapshots.js';
import { AtomicRouteSource, SnapshotFollower } from './snapshot-follower.js';

function storageKey(encoded) {
  const key=Buffer.from(String(encoded||''),'base64url');
  if(key.length!==32||key.toString('base64url')!==encoded)throw new Error('invalid local agent storage key');
  return key;
}

// The panel machine's own agent. It follows its desired snapshot like a remote machine does, only over
// a direct call: whenever the panel machine is among the machines a refresh changed, it pulls the
// snapshot, verifies it against the pinned panel key and applies it.
export class LocalAgent {
  constructor({store,cacheFile=`${store.file}.local-agent.snapshot`,snapshots=null,localBase=''}) {
    const registered=Array.isArray(store.data.agents)&&store.data.agents.some(agent=>agent.id===LOCAL_AGENT_ID);
    this.store=store;this.cacheFile=cacheFile;this.snapshots=snapshots||new DesiredSnapshots({store,localBase});this.routeSource=new AtomicRouteSource(registered?routesForAgent(store.data,LOCAL_AGENT_ID):store.data.routes);
    this.panelIdentity=null;this.record=null;this.follower=null;this.lastError='';this.applyState='starting';this.lastSeen=null;
  }

  register() {
    this.panelIdentity=ensurePanelSigningIdentity(this.store);
    this.store.data.controlPlane=this.store.data.controlPlane||{};
    const hadRegistry=Array.isArray(this.store.data.agents)&&this.store.data.agents.some(agent=>agent.id===LOCAL_AGENT_ID);
    const registry=ensureAgentRegistry(this.store.data,new Date().toISOString(),{deployAllLocal:!hadRegistry});
    let record=this.store.data.controlPlane.localAgent,changed=false;
    if(!record){
      record={id:'local',name:'本地 Agent',transport:'loopback',enrolledAt:new Date().toISOString(),agentStorageKey:randomToken(32),pinnedPanelKeyId:this.panelIdentity.keyId,pinnedPanelPublicKey:this.panelIdentity.publicKey,desiredState:null,appliedRevision:0,appliedHash:null,lastAck:null};
      this.store.data.controlPlane.localAgent=record;changed=true;
    }
    if(!record.agentStorageKey){record.agentStorageKey=randomToken(32);changed=true;}
    if(registry.changed)changed=true;
    if(!timingEqual(record.pinnedPanelKeyId||'',this.panelIdentity.keyId)||!timingEqual(record.pinnedPanelPublicKey||'',this.panelIdentity.publicKey))throw new Error('local agent panel signing key mismatch');
    this.record=record;
    this.follower=new SnapshotFollower({cacheFile:this.cacheFile,storageKey:storageKey(record.agentStorageKey),panelIdentity:{algorithm:'Ed25519',keyId:record.pinnedPanelKeyId,publicKey:record.pinnedPanelPublicKey},routeSource:this.routeSource});
    if(changed)this.store.save();
    return record;
  }

  // The store keeps what this machine has applied next to what the panel wants of it.
  recordApplied() { this.record.appliedRevision=this.follower.revision;this.record.appliedHash=this.follower.hash; }

  ack(snapshot,status,error='') {
    this.record.lastAck={revision:snapshot?.revision||0,hash:snapshot?.hash||null,status,at:new Date().toISOString(),error:String(error||'').slice(0,240)};
    this.lastSeen=this.record.lastAck.at;
    const agent=this.store.data.agents.find(item=>item.id===LOCAL_AGENT_ID);
    if(agent){agent.lastSeen=this.lastSeen;agent.applyState=status==='applied'?'active':'error';agent.desiredRevision=snapshot?.revision||0;agent.appliedRevision=status==='applied'?(snapshot?.revision||0):(this.record.appliedRevision||0);agent.proxyHealthy=status==='applied';agent.updatedAt=this.lastSeen;}
  }

  // Apply the desired snapshot as it stands; a no-op when it is already applied.
  reconcile() {
    let snapshot,result;
    // A snapshot that cannot even be compiled (a node still waiting for an access-key rotation, say)
    // is reported the same way as one this machine refuses.
    try { snapshot=this.snapshots.desired(LOCAL_AGENT_ID);result=this.follower.accept(snapshot); }
    catch(error) { result={ok:false,error:String(error.message||error).slice(0,240)}; }
    this.recordApplied();
    this.ack(snapshot,result.ok?'applied':'rejected',result.error);
    this.applyState=result.ok?'active':'error';this.lastError=result.error;
    this.store.save();
    return result.ok?{ok:true,decision:result.decision,revision:snapshot.revision,hash:snapshot.hash}:{ok:false,error:this.lastError,revision:this.record.appliedRevision||0};
  }

  start() {
    this.register();
    // A cache that is missing or no longer trusted leaves revision 0, so the desired snapshot applies.
    this.follower.load();this.recordApplied();
    this.unsubscribe?.();
    this.unsubscribe=this.snapshots.subscribe(changed=>{if(changed.includes(LOCAL_AGENT_ID))this.reconcile();});
    return this.reconcile();
  }

  status() {
    const desired=this.record?.desiredState?.revision||0,applied=this.record?.appliedRevision||0;
    const agent=this.store.data.agents.find(item=>item.id===LOCAL_AGENT_ID)||{};
    return {id:LOCAL_AGENT_ID,name:agent.name||'本地 Agent',transport:'loopback',domain:agent.domain||'',routeIds:routeIdsForAgent(this.store.data,LOCAL_AGENT_ID),status:'online',applyState:this.applyState,proxyHealthy:true,desiredRevision:desired,appliedRevision:applied,inSync:desired===applied&&this.applyState==='active',lastSeen:this.lastSeen||this.record?.lastAck?.at||this.record?.enrolledAt||null,lastAck:this.record?.lastAck||null,error:this.lastError||null,canDelete:false};
  }
}
