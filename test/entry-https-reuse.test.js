import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

function run(extra={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-entry-reuse-')),log=path.join(dir,'calls');
  const command=(name,body)=>fs.writeFileSync(path.join(dir,name),'#!/bin/sh\n'+body,{mode:0o755});
  command('id','echo 0\n');command('nginx','exit 0\n');command('getent','exit 0\n');
  // Abort before the legacy workflow can touch absolute host paths, even in a root test container.
  for(const name of ['mkdir','ln','apt-get','certbot','systemctl'])command(name,`echo ${name} >> "$TEST_CALLS"\nexit 88\n`);
  command('curl',`printf 'curl %s\\n' "$*" >> "$TEST_CALLS"
output=''; https=0
while [ "$#" -gt 0 ]; do
 case "$1" in -o|--output) output=$2; shift;; https:*) https=1;; esac
 shift
done
[ -n "$output" ] || exit 2
if [ "$https" = 1 ] && [ "\${TEST_TLS_FAIL:-0}" = 1 ]; then exit 60; fi
if [ "$https" = 1 ] && [ "\${TEST_WRONG_BODY:-0}" = 1 ]; then echo 'another service' > "$output"; else echo '<html>AegisRelay</html>' > "$output"; fi
`);
  try{
    const result=spawnSync('/bin/sh',[new URL('../scripts/configure-entry-domain.sh',import.meta.url).pathname,'entry.example.com','ops@example.com','peer.example.com'],{encoding:'utf8',env:{...process.env,...extra,PATH:dir+path.delimiter+process.env.PATH,TEST_CALLS:log}});
    return {...result,calls:fs.existsSync(log)?fs.readFileSync(log,'utf8'):''};
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}

test('a working existing HTTPS entry is reused when ACME peers change',()=>{
  const result=run();
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/沿用现有 HTTPS/);
  assert.doesNotMatch(result.calls,/^(mkdir|ln|apt-get|certbot|systemctl)$/m);
  assert.match(result.calls,/--resolve entry\.example\.com:443:127\.0\.0\.1/);
  assert.doesNotMatch(result.calls,/--insecure| -k\b/);
});

test('a certificate validation failure cannot be reported as an adopted HTTPS entry',()=>{
  const result=run({TEST_TLS_FAIL:'1'});
  assert.notEqual(result.status,0);assert.doesNotMatch(result.stdout,/沿用现有 HTTPS/);
});

test('a different HTTPS service cannot be mistaken for the relay entry',()=>{
  const result=run({TEST_WRONG_BODY:'1'});
  assert.notEqual(result.status,0);assert.doesNotMatch(result.stdout,/沿用现有 HTTPS/);
});
