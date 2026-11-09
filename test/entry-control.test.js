import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { followEntry, readDomainStatus, readEntryStatus } from '../src/domain-control.js';
import { cleanEntryRequest } from '../src/steering-topology.js';

const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));

test('a machine files one entry request at a time and never next to a domain switch',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-entry-')),entry={domain:'entry.example.com',email:'a@b',peers:['s2.example.com']};
  try {
    assert.equal(followEntry({dir,entry:null}),false);
    assert.equal(followEntry({dir,entry}),true);
    const request=read(path.join(dir,'host-entry-request.json'));
    assert.deepEqual([request.entryDomain,request.certificateEmail,request.peers,request.attempt],['entry.example.com','a@b',['s2.example.com'],1]);
    assert.equal(readEntryStatus(dir).state,'pending');
    assert.equal(followEntry({dir,entry}),false,'already waiting for the host');
    // the host unit ran and failed
    fs.rmSync(path.join(dir,'host-entry-request.json'));
    fs.writeFileSync(path.join(dir,'host-entry-status.json'),JSON.stringify({requestId:request.requestId,state:'failed',entryDomain:'entry.example.com',peers:['s2.example.com'],attempt:1,message:'dns',updatedAt:new Date().toISOString()}));
    assert.equal(followEntry({dir,entry}),false,'too soon to retry');
    fs.writeFileSync(path.join(dir,'host-domain-request.json'),'{}');
    assert.equal(followEntry({dir,entry,nowMs:Date.now()+4*60_000}),false,'a domain switch is pending');
    fs.rmSync(path.join(dir,'host-domain-request.json'));
    assert.equal(followEntry({dir,entry,nowMs:Date.now()+4*60_000}),true);
    assert.equal(read(path.join(dir,'host-entry-request.json')).attempt,2);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

// An agent follows the entry its check-in answer names: cleaned first, then through the same files as
// the panel machine, in its own data directory.
test('an agent files the entry the panel named, and nothing for an entry that does not hold up',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-agent-entry-')),follow=value=>followEntry({dir,entry:cleanEntryRequest(value)});
  try {
    for(const bad of [null,'x',{domain:'entry.example.com',email:'a@b',peers:['entry.example.com']},{domain:'bad_domain',email:'a@b',peers:[]},{domain:'entry.example.com',email:'nobody',peers:[]},{domain:'entry.example.com',email:'a@b',peers:'s2.example.com'}])
      assert.equal(follow(bad),false,JSON.stringify(bad));
    assert.equal(fs.existsSync(path.join(dir,'host-entry-request.json')),false);
    assert.equal(follow({domain:'Entry.Example.com',email:'A@B',peers:['S3.example.com','s2.example.com','s2.example.com']}),true);
    assert.deepEqual(read(path.join(dir,'host-entry-request.json')).peers,['s2.example.com','s3.example.com'],'peers cleaned, de-duplicated and sorted');
    assert.equal(readEntryStatus(dir).entryDomain,'entry.example.com');
    // An agent's own domain status file reads the same way as the panel machine's.
    fs.writeFileSync(path.join(dir,'host-domain-status.json'),JSON.stringify({requestId:'r',state:'active',mode:'ip',currentDomain:'203.0.113.9',updatedAt:'2026-11-09T00:00:00Z'}));
    assert.deepEqual(readDomainStatus(dir),{requestId:'r',state:'active',mode:'ip',desiredDomain:'',currentDomain:'203.0.113.9',message:'',updatedAt:'2026-11-09T00:00:00Z'});
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
