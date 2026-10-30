import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

function run(extra={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-entry-reuse-')),log=path.join(dir,'calls');
  // Shell functions also override BusyBox builtins, so the same safety barriers work on Alpine.
  const shell=`id(){ echo 0; }
nginx(){ return 0; }
getent(){ return 0; }
mkdir(){ echo mkdir >> "$TEST_CALLS"; return 88; }
ln(){ echo ln >> "$TEST_CALLS"; return 88; }
apt-get(){ echo apt-get >> "$TEST_CALLS"; return 88; }
certbot(){ echo certbot >> "$TEST_CALLS"; return 88; }
systemctl(){ echo systemctl >> "$TEST_CALLS"; return 88; }
curl(){
 printf 'curl %s\\n' "$*" >> "$TEST_CALLS"
 output=''; https=0
 while [ "$#" -gt 0 ]; do
  case "$1" in -o|--output) output=$2; shift;; https:*) https=1;; esac
  shift
 done
 [ -n "$output" ] || return 2
 if [ "$https" = 1 ] && [ "\${TEST_TLS_FAIL:-0}" = 1 ]; then return 60; fi
 if [ "$https" = 1 ] && [ "\${TEST_WRONG_BODY:-0}" = 1 ]; then echo 'another service' > "$output"; else echo '<html>AegisRelay</html>' > "$output"; fi
}
script=$1; shift
. "$script"
`;
  try{
    const result=spawnSync('/bin/sh',['-c',shell,'entry-test',new URL('../scripts/configure-entry-domain.sh',import.meta.url).pathname,'entry.example.com','ops@example.com','peer.example.com'],{encoding:'utf8',env:{...process.env,...extra,TEST_CALLS:log}});
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
  assert.match(result.calls,/^curl /m);assert.match(result.calls,/^mkdir$/m);
});

test('a different HTTPS service cannot be mistaken for the relay entry',()=>{
  const result=run({TEST_WRONG_BODY:'1'});
  assert.notEqual(result.status,0);assert.doesNotMatch(result.stdout,/沿用现有 HTTPS/);
  assert.match(result.calls,/^curl /m);assert.match(result.calls,/^mkdir$/m);
});
