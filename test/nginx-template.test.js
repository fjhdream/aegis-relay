import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const dataPlaneScripts=[
  'scripts/agent-configure-domain.sh',
  'scripts/agent-configure-ip.sh',
  'scripts/configure-domain.sh',
  'scripts/configure-local-domain.sh',
  'scripts/configure-entry-domain.sh'
];

test('every generated Nginx data plane has reusable upstreams and a valid large unbuffered read window',()=>{
  for(const file of dataPlaneScripts){
    const source=fs.readFileSync(new URL(`../${file}`,import.meta.url),'utf8');
    assert.match(source,/upstream aegis_(?:agent|relay|entry)_backend \{/);
    assert.match(source,/keepalive 64;/);
    assert.ok(source.includes('map \\$http_upgrade '));
    assert.ok(source.includes("{ default upgrade; '' ''; }"));
    for(const directive of ['proxy_buffering off;','proxy_set_header Range \\$http_range;','proxy_set_header If-Range \\$http_if_range;','proxy_max_temp_file_size 0;','proxy_buffer_size 256k;','proxy_buffers 4 256k;','proxy_busy_buffers_size 512k;','proxy_ignore_headers X-Accel-Buffering X-Accel-Limit-Rate;','proxy_socket_keepalive on;','proxy_limit_rate 0;','limit_rate 0;','send_timeout 3600s;'])assert.ok(source.includes(directive),`${file} is missing ${directive}`);
  }
});

test('the shared entry domain answers ACME challenges for the other machines, once and never in a loop',()=>{
  const source=fs.readFileSync(new URL('../scripts/configure-entry-domain.sh',import.meta.url),'utf8');
  assert.ok(source.includes('try_files \\$uri @aegis_acme_peers;'));
  assert.ok(source.includes('if (\\$http_x_aegis_acme_hop) { return 404; }'));
  assert.ok(source.includes('proxy_set_header X-Aegis-Acme-Hop 1;'));
  assert.ok(source.includes('proxy_next_upstream error timeout http_404;'));
  assert.match(source,/certbot certonly --webroot/);
  assert.match(source,/if \(\\\$host != \$ENTRY\) \{ return 421; \}/);
  // the entry domain must never be a machine's own direct domain, which is what steering targets
  assert.match(source,/目前就是这台机器的直连域名/);
  for(const cli of ['scripts/aegis-relay','scripts/aegis-relay-agent'])assert.match(fs.readFileSync(new URL(`../${cli}`,import.meta.url),'utf8'),/configure-entry-domain\.sh/);
  for(const installer of ['scripts/agent-install.sh','scripts/agent-upgrade.sh'])assert.match(fs.readFileSync(new URL(`../${installer}`,import.meta.url),'utf8'),/install -m 0755 "\$TMP_DIR\/source\/scripts\/configure-entry-domain\.sh"/);
});
