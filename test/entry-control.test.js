import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { followEntry, readEntryStatus } from '../src/domain-control.js';

const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));

test('the panel files one entry request at a time and never next to a domain switch',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-entry-')),dataFile=path.join(dir,'aegis.enc.json'),entry={domain:'entry.example.com',email:'a@b',peers:['s2.example.com']};
  try {
    assert.equal(followEntry({dataFile,entry:null}),false);
    assert.equal(followEntry({dataFile,entry}),true);
    const request=read(path.join(dir,'host-entry-request.json'));
    assert.deepEqual([request.entryDomain,request.certificateEmail,request.peers,request.attempt],['entry.example.com','a@b',['s2.example.com'],1]);
    assert.equal(readEntryStatus(dataFile).state,'pending');
    assert.equal(followEntry({dataFile,entry}),false,'already waiting for the host');
    // the host unit ran and failed
    fs.rmSync(path.join(dir,'host-entry-request.json'));
    fs.writeFileSync(path.join(dir,'host-entry-status.json'),JSON.stringify({requestId:request.requestId,state:'failed',entryDomain:'entry.example.com',peers:['s2.example.com'],attempt:1,message:'dns',updatedAt:new Date().toISOString()}));
    assert.equal(followEntry({dataFile,entry}),false,'too soon to retry');
    fs.writeFileSync(path.join(dir,'host-domain-request.json'),'{}');
    assert.equal(followEntry({dataFile,entry,nowMs:Date.now()+4*60_000}),false,'a domain switch is pending');
    fs.rmSync(path.join(dir,'host-domain-request.json'));
    assert.equal(followEntry({dataFile,entry,nowMs:Date.now()+4*60_000}),true);
    assert.equal(read(path.join(dir,'host-entry-request.json')).attempt,2);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
