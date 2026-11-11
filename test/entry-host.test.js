import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { deriveKey } from '../src/security.js';
import { Store } from '../src/store.js';
import { readEntryDomain, readSteeringSettings, steeringSettings } from '../src/steering-topology.js';
import { Panel } from '../src/panel.js';
import { DesiredSnapshots } from '../src/desired-snapshots.js';
import { LocalAgent } from '../src/local-agent.js';

// The panel machine answers its steering entry domain as data plane on every proxied request, so that
// check must only read the stored steering settings (src/server.js isEntryHost).
const ROOT=new URL('..',import.meta.url).pathname,MASTER_KEY='entry-host-test-master-key-0123456789';
const freePort=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(()=>resolve(port))})});

test('the entry domain is read as readSteeringSettings has it, for every stored shape, without touching the data',()=>{
  const steering=value=>({settings:{steering:value}}),entry=value=>steering({mode:'on',excludedClients:['Infuse'],autoExcluded:{VidHub:'2026-01-01T00:00:00.000Z'},boundMB:'32',entryDomain:value});
  const cases=[
    ['no data',undefined,''],['no settings',{},''],['no steering',{settings:{}},''],['null steering',steering(null),''],['string steering',steering('entry.example.com'),''],['array steering',steering(['entry.example.com']),''],
    ['no entry domain',steering({mode:'on'}),''],['empty',entry(''),''],['valid',entry('entry.example.com'),'entry.example.com'],
    // Stored strings are taken as they are (only the panel's edit normalises them): uppercase and padded
    // ones never equal a request hostname, which is lowercased; a trailing dot matches only that spelling.
    ['uppercase',entry('Entry.Example.com'),'Entry.Example.com'],['padded',entry(' entry.example.com '),' entry.example.com '],['trailing dot',entry('entry.example.com.'),'entry.example.com.'],
    ['number',entry(42),''],['null',entry(null),''],['object',entry({}),''],['array',entry(['entry.example.com']),''],['true',entry(true),'']
  ];
  for(const [name,data,expected] of cases){
    const stored=data?.settings?.steering,before=structuredClone(data);
    assert.equal(readEntryDomain(data),expected,name);
    assert.equal(readEntryDomain(data),readSteeringSettings(data).entryDomain,`${name}: same as the full read`);
    assert.equal(data?.settings?.steering,stored,`${name}: the stored object is not replaced`);
    assert.deepEqual(data,before,`${name}: nothing written`);
    if(data)assert.equal(readEntryDomain(data),steeringSettings(structuredClone(data)).entryDomain,`${name}: the answer the old per-request check got`);
  }
});

test('the 自动切流 page reads the steering settings without rewriting them',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-entry-host-panel-'));
  const data={routes:[],agents:[],deployments:[],settings:{certificateEmail:'ops@example.com',steering:{entryDomain:'entry.example.com'}},enrollmentTokens:[],audit:[],controlPlane:{}};
  const store={file:path.join(dir,'aegis.enc.json'),data,save(){},audit(){}},snapshots=new DesiredSnapshots({store});
  const localAgent=new LocalAgent({store,snapshots});localAgent.start();
  try {
    const panel=new Panel({store,snapshots,localAgent,dataFile:store.file,publicBaseUrl:'https://panel.example.com'});
    const stored=data.settings.steering,before=structuredClone(data);
    assert.deepEqual([panel.steering().settings.mode,panel.steering().settings.entryDomain],['off','entry.example.com']);
    assert.equal(data.settings.steering,stored,'the stored object is not replaced');
    assert.deepEqual(data,before,'nothing written');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('the panel machine serves its entry domain as data plane, and a proxied request leaves the stored steering settings alone',async()=>{
  const work=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-entry-host-')),file=path.join(work,'data','aegis.enc.json');
  // Stored the way an older version or a hand edit leaves it: the entry domain and nothing else, so any
  // rewrite of the stored object shows up in the file.
  const seed=new Store(file,deriveKey(MASTER_KEY));seed.data.settings.steering={entryDomain:'entry.example.com'};seed.saveSync();
  const [adminPort,proxyPort]=[await freePort(),await freePort()],admin=`http://127.0.0.1:${adminPort}/_aegis/api`;
  const server=spawn(process.execPath,['src/server.js'],{cwd:ROOT,stdio:'ignore',env:{...process.env,APP_MASTER_KEY:MASTER_KEY,SETUP_TOKEN:'setup-token',ADMIN_HOST:'127.0.0.1',ADMIN_PORT:String(adminPort),PROXY_HOST:'127.0.0.1',PROXY_PORT:String(proxyPort),DATA_FILE:file,SECURE_COOKIES:'false',PUBLIC_BASE_URL:'https://panel.example.com',LOCAL_PROXY_BASE_URL:'https://proxy.example.com',CERTIFICATE_EMAIL:''}});
  const get=host=>new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port:proxyPort,path:'/agent-install.sh',headers:{host}},res=>{let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,text}))}).on('error',reject));
  // The store is written asynchronously after an audited request; wait until the file holds that event.
  const persisted=async action=>{for(let i=0;i<200;i++){const data=new Store(file,deriveKey(MASTER_KEY)).data;if(data.audit.some(item=>item.action===action))return data;await new Promise(resolve=>setTimeout(resolve,25))}throw new Error(`${action} never reached the store`)};
  try {
    for(let i=0;i<200;i++){try{if((await fetch(`${admin}/status`)).ok)break}catch{}await new Promise(resolve=>setTimeout(resolve,50))}
    const proxied=await get('proxy.example.com');
    assert.deepEqual(proxied,{status:404,text:'not found'},'the proxy domain is data plane: no installer there');
    assert.deepEqual(await get('entry.example.com'),proxied,'the entry domain is answered exactly as the proxy domain');
    assert.equal((await get('panel.example.com')).status,200,'the panel domain still hands out the installer');
    assert.equal((await get('other.example.com')).status,421);
    // No admin yet: the login is refused and audited, which saves the store.
    assert.equal((await fetch(`${admin}/login`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,429);
    assert.deepEqual((await persisted('login.denied')).settings.steering,{entryDomain:'entry.example.com'},'the stored settings are exactly as seeded');
    // An entry domain changed through the panel is in force on the next request, with no restart.
    assert.equal((await fetch(`${admin}/setup`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({setupToken:'setup-token',password:'entry-host-password'})})).status,201);
    const login=await fetch(`${admin}/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'entry-host-password'})});
    const headers={'content-type':'application/json',cookie:login.headers.get('set-cookie').split(';')[0],'x-csrf-token':(await login.json()).csrf};
    assert.equal((await fetch(`${admin}/steering`,{method:'PUT',headers,body:JSON.stringify({entryDomain:'go.example.com'})})).status,200);
    assert.deepEqual(await get('go.example.com'),proxied);
    assert.equal((await get('entry.example.com')).status,421,'the old entry domain is no longer this machine\'s');
  } finally {
    server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve));
    fs.rmSync(work,{recursive:true,force:true});
  }
});
