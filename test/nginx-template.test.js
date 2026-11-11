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

// A script's data-plane location: the `location / {` block that proxies to the relay upstream, in the
// server that takes unlimited request bodies. configure-local-domain.sh also sends its panel domain's
// `location /` to the relay with a 1m limit (control plane); admin and ACME locations are not
// `location /`. Comments are dropped, the per-script names (upstream, connection-upgrade map variable)
// normalised and the directives sorted, since their order inside a location does not matter to Nginx.
const dataPlaneDirectives=file=>{
  const source=fs.readFileSync(new URL(`../${file}`,import.meta.url),'utf8');
  const blocks=source.split(/^server \{$/m).slice(1).filter(server=>server.includes('client_max_body_size 0;'))
    .flatMap(server=>[...server.matchAll(/^([ \t]*)location \/ \{\n([\s\S]*?)^\1\}$/gm)].map(match=>match[2]))
    .filter(body=>/proxy_pass http:\/\/aegis_(?:agent|relay|entry)_backend;/.test(body));
  assert.equal(blocks.length,1,`${file} should have exactly one data-plane location`);
  return blocks[0].split('\n').map(line=>line.trim()).filter(line=>line&&!line.startsWith('#'))
    .map(line=>line.replace(/aegis_(?:agent|relay|entry)_backend/g,'aegis_*_backend').replace(/aegis_(?:agent_|entry_)?connection_upgrade/g,'aegis_*_connection_upgrade')).sort();
};

test('every generated Nginx data plane has the same directives as the others',()=>{
  const directives=new Map(dataPlaneScripts.map(file=>[file,dataPlaneDirectives(file)]));
  const drift=[...new Set([...directives.values()].flat())].sort().flatMap(line=>{
    const missing=dataPlaneScripts.filter(file=>!directives.get(file).includes(line));
    return missing.length?[`${line} missing from ${missing.join(', ')}`]:[];
  });
  assert.deepEqual(drift,[]);
});

test('every generated Nginx data plane overwrites the forwarded headers the relay trusts',()=>{
  // The relay reads the viewer address (viewer list, steering history) from X-Real-IP and the scheme
  // from X-Forwarded-Proto; Nginx passes a client's own copies through unless it sets them itself.
  for(const file of dataPlaneScripts){
    const directives=dataPlaneDirectives(file);
    for(const header of ['proxy_set_header Host \\$host;','proxy_set_header X-Forwarded-Proto \\$scheme;','proxy_set_header X-Real-IP \\$remote_addr;'])assert.ok(directives.includes(header),`${file} is missing ${header}`);
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
