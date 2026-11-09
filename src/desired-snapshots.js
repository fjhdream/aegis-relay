import { compileAgentDesiredSnapshot, ensurePanelSigningIdentity } from './snapshot.js';
import { LOCAL_AGENT_ID } from './agent-registry.js';

// Desired snapshots (期望快照, see GLOSSARY.md): the signed node configuration the panel wants each
// machine to serve. This module alone decides when one changes. Callers only say that the panel data
// may have changed (refresh); every machine's snapshot is then compiled again and compared by content,
// so a machine whose nodes came out the same keeps its revision and its signed snapshot, costs no new
// signature, and is not woken. Subscribers hear which machines changed: the agent API wakes their long
// polls, and the panel machine applies its own.
//
// refresh() runs synchronously on purpose: a card whose machine was just changed must read 「等待同步」
// in the very response to that change, not after the next poll.
export class DesiredSnapshots {
  constructor({store,localBase=''}) {
    this.store=store;this.localBase=localBase;this.signingIdentity=ensurePanelSigningIdentity(store);
    this.signed=new Map();this.listeners=new Set();
  }

  subscribe(listener) { this.listeners.add(listener); return ()=>this.listeners.delete(listener); }

  // The machines that get a snapshot: every registered one but revoked machines, and the panel machine
  // once its local agent has registered.
  machines() {
    const local=!!this.store.data.controlPlane?.localAgent;
    return (Array.isArray(this.store.data.agents)?this.store.data.agents:[]).filter(agent=>agent.state!=='revoked'&&(agent.id!==LOCAL_AGENT_ID||local));
  }

  // Where a machine keeps the state its revisions continue from: a remote machine on its own record,
  // the panel machine on the local agent record. Moving it would restart the revisions, and a machine
  // rejects a revision older than the one it has applied.
  stateHolder(agentId) {
    if(agentId===LOCAL_AGENT_ID)return this.store.data.controlPlane?.localAgent||null;
    return (Array.isArray(this.store.data.agents)?this.store.data.agents:[]).find(agent=>agent.id===agentId&&agent.state!=='revoked')||null;
  }

  compile(agentId) {
    const holder=this.stateHolder(agentId);
    if(!holder)throw new Error('unknown machine');
    const {snapshot,state}=compileAgentDesiredSnapshot({data:this.store.data,agentId,previousState:holder.desiredState||null,previousSnapshot:this.signed.get(agentId)||null,signingIdentity:this.signingIdentity,localBase:this.localBase});
    holder.desiredState=state;this.signed.set(agentId,snapshot);
    const record=this.store.data.agents?.find(agent=>agent.id===agentId);
    if(record){record.desiredRevision=snapshot.revision;record.desiredHash=snapshot.hash;}
    return snapshot;
  }

  // What the machine should serve now. Throws when its nodes cannot be compiled (a node that still
  // needs an access-key rotation, say); the caller reports that to the machine.
  desired(agentId) { return this.signed.get(agentId)||this.compile(agentId); }

  // Compile every machine again; returns (and tells subscribers) the machines whose desired snapshot
  // now differs from the one this module last handed out, including one that has started failing.
  refresh() {
    const changed=[],live=new Set();
    for(const agent of this.machines()){
      live.add(agent.id);
      const before=this.signed.get(agent.id)?.hash;
      // A single unusable machine record must never hold the change back from the others.
      try{if(this.compile(agent.id).hash!==before)changed.push(agent.id);}
      catch{if(this.signed.delete(agent.id))changed.push(agent.id);}
    }
    for(const id of [...this.signed.keys()])if(!live.has(id))this.signed.delete(id);
    if(changed.length)for(const listener of [...this.listeners])listener(changed);
    return changed;
  }
}
