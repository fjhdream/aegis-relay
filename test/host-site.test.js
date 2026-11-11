import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// The host scripts, run for real against a stand-in host: a temporary directory holds Nginx's site
// directories, the install directories and Let's Encrypt's, and a bin/ ahead of PATH holds stand-ins
// for the commands that would touch the machine (nginx, certbot, systemctl, apt-get, …). The scripts,
// the shell and the text tools they use are the real ones.

const SCRIPTS=new URL('../scripts/',import.meta.url).pathname;
const STUBS={
  id:'echo 0',
  // A dead third-party source fails `update`; a package that cannot be had fails `install`.
  'apt-get':'[ "$1" = update ] && [ "${TEST_APT_SOURCE_DEAD:-0}" = 1 ] && exit 100; [ "$1" = install ] && [ "${TEST_APT_PACKAGE_MISSING:-0}" = 1 ] && exit 100; exit 0',
  hostname:'echo 198.51.100.7',
  systemctl:'exit 0',
  docker:'exit 0',
  'docker-compose':'exit 0',
  // `nginx -t` passes unless the test says this host's Nginx rejects the configuration.
  nginx:'[ "${TEST_NGINX_REJECTS:-0}" = 1 ] && { echo "nginx: configuration file test failed" >&2; exit 1; }; exit 0',
  // The public-address lookup answers; any request that saves a body (the entry domain probing
  // itself) fails, so nothing looks already set up.
  curl:'for a in "$@"; do [ "$a" = -o ] && exit 22; done; echo 203.0.113.9',
  getent:'[ "$1" = ahostsv4 ] && echo "203.0.113.9 STREAM $2"; exit 0',
  // certbot --nginx rewrites the site it finds the domain in; certonly leaves a certificate behind.
  certbot:`[ "\${TEST_CERTBOT_FAILS:-0}" = 1 ] && { echo "certbot: challenge failed" >&2; exit 1; }
domain=; only=0; prev=
for a in "$@"; do [ "$prev" = -d ] && domain=$a; [ "$a" = certonly ] && only=1; prev=$a; done
if [ "$only" = 1 ]; then mkdir -p "$AEGIS_LETSENCRYPT_DIR/live/$domain"; : > "$AEGIS_LETSENCRYPT_DIR/live/$domain/fullchain.pem"; : > "$AEGIS_LETSENCRYPT_DIR/live/$domain/privkey.pem"; exit 0; fi
for site in "$AEGIS_NGINX_DIR"/sites-available/*.conf; do grep -q "server_name $domain;" "$site" && printf '    # managed by Certbot: %s\\n' "$domain" >> "$site"; done
exit 0`
};

// One set of stand-ins for the whole file (each records its calls in the host it was run for), and
// every temporary host is removed when the file is done.
const BIN=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-host-bin-')),ROOTS=[BIN];
for(const [name,body] of Object.entries(STUBS))fs.writeFileSync(path.join(BIN,name),`#!/bin/sh\nprintf '%s %s\\n' ${name} "$*" >> "$TEST_CALLS"\n${body}\n`,{mode:0o755});
after(()=>{for(const root of ROOTS)fs.rmSync(root,{recursive:true,force:true})});

function host() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-host-')),dir=name=>path.join(root,name),calls=dir('calls');
  ROOTS.push(root);
  for(const name of ['nginx/sites-available','nginx/sites-enabled','letsencrypt','acme-root','agent/data','panel/scripts'])fs.mkdirSync(dir(name),{recursive:true});
  // An agent keeps the scripts in its install directory, the panel machine in scripts/ under it.
  for(const name of fs.readdirSync(SCRIPTS))for(const to of ['agent','panel/scripts'])fs.copyFileSync(path.join(SCRIPTS,name),path.join(dir(to),name));
  fs.writeFileSync(path.join(dir('agent'),'.env'),'PANEL_URL=https://panel.example.com\nAGENT_DOMAIN=\nAGENT_EMAIL=\n');
  fs.writeFileSync(path.join(dir('panel'),'.env'),'ADMIN_PATH=secret-admin\n');
  const env={PATH:`${BIN}:${process.env.PATH}`,TEST_CALLS:calls,AEGIS_NGINX_DIR:dir('nginx'),AEGIS_LETSENCRYPT_DIR:dir('letsencrypt'),AEGIS_AGENT_DIR:dir('agent'),AEGIS_PANEL_DIR:dir('panel'),AEGIS_ACME_ROOT:path.join(dir('acme-root'),'acme')};
  const read=file=>{try{return fs.readFileSync(file,'utf8')}catch{return null}};
  return {
    root,dir,
    // Run a script as the machine would: an agent's from its install directory, the panel's from scripts/.
    run(script,args=[],extra={}){const result=spawnSync('/bin/sh',[path.join(dir(script.startsWith('agent-')?'agent':'panel/scripts'),script),...args],{encoding:'utf8',env:{...env,...extra}});return {...result,output:`${result.stdout}${result.stderr}`}},
    site:name=>read(path.join(dir('nginx'),'sites-available',`${name}.conf`)),
    enabled:name=>fs.existsSync(path.join(dir('nginx'),'sites-enabled',`${name}.conf`)),
    calls:()=>(read(calls)||'').trim().split('\n').filter(Boolean),
    // An install's .env as an object ("panel" or "agent").
    env:install=>Object.fromEntries((read(path.join(dir(install),'.env'))||'').split('\n').filter(Boolean).map(line=>[line.slice(0,line.indexOf('=')),line.slice(line.indexOf('=')+1)]))
  };
}

// The server blocks of a site, and the `location / { … }` of each that proxies to a relay upstream.
const servers=site=>site.split(/^server \{$/m).slice(1);
const relayLocation=server=>{const found=[...server.matchAll(/^    location \/ \{\n([\s\S]*?)^    \}$/gm)].map(match=>match[1]).filter(body=>/proxy_pass http:\/\/aegis_\w+_backend;/.test(body));assert.ok(found.length<=1);return found[0]||null};
const directives=body=>body.split('\n').map(line=>line.trim()).filter(line=>line&&!line.startsWith('#'));
// Names that differ per site file, since upstreams and map variables are global to Nginx.
const neutral=lines=>lines.map(line=>line.replace(/aegis_\w+_backend/,'aegis_*_backend').replace(/\$aegis_\w*connection_upgrade/,'$aegis_*_connection_upgrade')).sort();
const dataPlane=server=>neutral(directives(relayLocation(server)));

// Every kind of site the scripts produce, each on a fresh host; rendered once for the file.
let renderedSites=null;
function rendered() {
  if(renderedSites)return renderedSites;
  const sites={};
  const render=(name,file,steps)=>{const h=host();for(const [script,args,extra] of steps){const result=h.run(script,args,extra);assert.equal(result.status,extra?.expect??0,`${name}: ${script} ${result.output}`)}sites[name]=h.site(file);assert.ok(sites[name],name);assert.ok(h.enabled(file),`${name} is enabled`)};
  render('agent on a domain','aegis-relay-agent',[['agent-configure-domain.sh',['HK.Example.com','ops@example.com']]]);
  render('agent on its IP','aegis-relay-agent',[['agent-configure-ip.sh']]);
  render('panel on one domain','aegis-relay',[['configure-domain.sh',['panel.example.com','ops@example.com']]]);
  render('panel with a separate proxy domain','aegis-relay',[['configure-domain.sh',['panel.example.com','ops@example.com']],['configure-local-domain.sh',['emby.example.com','ops@example.com']]]);
  render('entry domain','aegis-relay-entry',[['configure-entry-domain.sh',['entry.example.com','ops@example.com','peer-a.example.com','peer-b.example.com']]]);
  render('entry domain, no other machine','aegis-relay-entry',[['configure-entry-domain.sh',['entry.example.com','ops@example.com']]]);
  render('entry domain before its certificate','aegis-relay-entry',[['configure-entry-domain.sh',['entry.example.com','ops@example.com','peer-a.example.com'],{TEST_CERTBOT_FAILS:'1',expect:1}]]);
  return renderedSites=sites;
}

test('every site that carries Emby traffic gets the one data-plane location',()=>{
  const sites=rendered();
  // What the library prints, asked for directly.
  const printed=spawnSync('/bin/sh',['-c','. "$1"; data_plane_location aegis_x_backend aegis_x_connection_upgrade','sh',path.join(SCRIPTS,'host-site.sh')],{encoding:'utf8'});
  assert.equal(printed.status,0,printed.stderr);
  const expected=neutral(directives(printed.stdout.split('\n').slice(1,-2).join('\n')));
  // Unlimited request bodies mark the server that takes Emby traffic; one per site, except the entry
  // domain while it has no certificate (it only answers ACME challenges then).
  const carriers=Object.entries(sites).map(([name,site])=>[name,servers(site).filter(server=>server.includes('client_max_body_size 0;'))]);
  assert.deepEqual(carriers.map(([name,found])=>[name,found.length]),[['agent on a domain',1],['agent on its IP',1],['panel on one domain',1],['panel with a separate proxy domain',1],['entry domain',1],['entry domain, no other machine',1],['entry domain before its certificate',0]]);
  for(const [name,[server]] of carriers)if(server)assert.deepEqual(dataPlane(server),expected,name);
  // The headers the relay trusts are set by Nginx, never passed through from the client; media is
  // streamed unbuffered with a large read window, for hours, and WebSockets are upgraded.
  for(const line of ['proxy_set_header Host $host;','proxy_set_header X-Forwarded-Proto $scheme;','proxy_set_header X-Real-IP $remote_addr;','proxy_set_header Upgrade $http_upgrade;','proxy_set_header Connection $aegis_*_connection_upgrade;','proxy_http_version 1.1;',
    'proxy_buffering off;','proxy_request_buffering off;','proxy_set_header Range $http_range;','proxy_set_header If-Range $http_if_range;','proxy_max_temp_file_size 0;','proxy_buffer_size 256k;','proxy_buffers 4 256k;','proxy_busy_buffers_size 512k;',
    'proxy_ignore_headers X-Accel-Buffering X-Accel-Limit-Rate;','proxy_socket_keepalive on;','proxy_limit_rate 0;','limit_rate 0;','proxy_read_timeout 3600s;','proxy_send_timeout 3600s;','send_timeout 3600s;'])assert.ok(expected.includes(line),line);
  assert.equal(expected.length,22,'and nothing else');
  // deploy/nginx.example.conf is the one-domain panel site written out for people who configure Nginx
  // by hand: its data plane is the same one.
  const example=servers(fs.readFileSync(new URL('../deploy/nginx.example.conf',import.meta.url),'utf8')).filter(server=>server.includes('client_max_body_size 0;'));
  assert.equal(example.length,1);
  assert.deepEqual(dataPlane(example[0]),expected,'deploy/nginx.example.conf');
});

test('each site defines its own relay upstream, so the sites of one machine load together',()=>{
  const sites=rendered(),names=site=>[...site.matchAll(/^upstream (\w+) \{$/gm)].map(match=>match[1]).concat([...site.matchAll(/^map \$http_upgrade \$(\w+) /gm)].map(match=>match[1])).sort();
  assert.deepEqual(names(sites['agent on a domain']),['aegis_agent_backend','aegis_agent_connection_upgrade']);
  assert.deepEqual(names(sites['agent on its IP']),['aegis_agent_backend','aegis_agent_connection_upgrade']);
  assert.deepEqual(names(sites['panel on one domain']),['aegis_admin_backend','aegis_connection_upgrade','aegis_relay_backend']);
  assert.deepEqual(names(sites['panel with a separate proxy domain']),['aegis_admin_backend','aegis_connection_upgrade','aegis_relay_backend']);
  assert.deepEqual(names(sites['entry domain']),['aegis_acme_peers','aegis_entry_backend','aegis_entry_connection_upgrade']);
  assert.deepEqual(names(sites['entry domain, no other machine']),['aegis_entry_backend','aegis_entry_connection_upgrade']);
  // An agent or the panel machine may serve the entry domain next to its own site.
  for(const own of ['agent on a domain','agent on its IP','panel with a separate proxy domain'])assert.deepEqual(names(sites[own]).filter(name=>names(sites['entry domain']).includes(name)),[],own);
  for(const site of Object.values(sites)){
    assert.match(site,/^upstream aegis_\w+_backend \{\n    server 127\.0\.0\.1:8080;\n    keepalive 64;\n\}$/m,'a keep-alive upstream to the local relay');
    assert.match(site,/^map \$http_upgrade \$aegis_\w*connection_upgrade \{ default upgrade; '' ''; \}$/m);
  }
});

test('a site answers only for the names it was set up for',()=>{
  const sites=rendered(),only=(server,domain)=>{assert.ok(server.includes(`    server_name ${domain};\n`),domain);assert.ok(server.includes(`    if ($host != ${domain}) { return 421; }\n`),`other hosts are turned away from ${domain}`)};
  // An agent on a domain (given in any case) or on its bare IP, where it is the default server.
  const [agent]=servers(sites['agent on a domain']);only(agent,'hk.example.com');
  assert.match(agent,/^    listen 80;\n    listen \[::\]:80;$/m);
  const [bare]=servers(sites['agent on its IP']);
  assert.match(bare,/^    listen 80 default_server;\n    listen \[::\]:80 default_server;\n    server_name _;$/m);
  assert.equal(bare.includes('return 421'),false);
  // The panel on one domain: the admin panel under its secret path, everything else to the relay.
  const [single]=servers(sites['panel on one domain']);only(single,'panel.example.com');
  assert.ok(single.includes('    location = /secret-admin { return 301 /secret-admin/; }\n    location ^~ /secret-admin/ {\n        proxy_pass http://aegis_admin_backend;'));
  // With a separate proxy domain the panel domain carries no Emby traffic: small bodies, no upgrades.
  const [control,data]=servers(sites['panel with a separate proxy domain']);only(control,'panel.example.com');only(data,'emby.example.com');
  assert.ok(control.includes('client_max_body_size 1m;')&&control.includes('location ^~ /secret-admin/ {'));
  assert.equal(directives(relayLocation(control)).some(line=>/Upgrade|proxy_request_buffering|proxy_read_timeout/.test(line)),false);
  assert.equal(data.includes('secret-admin'),false,'the proxy domain does not expose the admin panel');
});

test('the entry domain answers ACME challenges for the other machines, once and never in a loop',()=>{
  const sites=rendered(),[http,tls]=servers(sites['entry domain']);
  assert.ok(sites['entry domain'].includes('upstream aegis_acme_peers {\n    server peer-a.example.com:80;\n    server peer-b.example.com:80;\n}\n'));
  for(const line of ['server_name entry.example.com;','if ($host != entry.example.com) { return 421; }','try_files $uri @aegis_acme_peers;','if ($http_x_aegis_acme_hop) { return 404; }','proxy_set_header X-Aegis-Acme-Hop 1;','proxy_next_upstream error timeout http_404;','proxy_pass http://aegis_acme_peers;','location / { return 301 https://$host$request_uri; }'])assert.ok(http.includes(line),line);
  assert.equal(relayLocation(http),null,'plain HTTP never reaches the relay');
  assert.match(tls,/^    listen 443 ssl;\n    listen \[::\]:443 ssl;\n    server_name entry\.example\.com;$/m);
  assert.match(tls,/ssl_certificate \S+\/live\/entry\.example\.com\/fullchain\.pem;\n    ssl_certificate_key \S+\/live\/entry\.example\.com\/privkey\.pem;/);
  // Alone, it has nobody to ask.
  const [alone]=servers(sites['entry domain, no other machine']);
  assert.ok(alone.includes('location @aegis_acme_peers {\n        return 404;\n    }'));
  assert.equal(sites['entry domain, no other machine'].includes('aegis_acme_peers {'),true);
  assert.equal(sites['entry domain, no other machine'].includes('upstream aegis_acme_peers'),false);
  // Until its own certificate is issued it still answers and forwards challenges, and nothing else.
  const waiting=servers(sites['entry domain before its certificate']);
  assert.equal(waiting.length,1);
  assert.ok(waiting[0].includes('proxy_pass http://aegis_acme_peers;')&&!waiting[0].includes('listen 443'));
});

test('the panel\'s domain setup leaves its .env saying what Nginx now serves, and restarts the panel on it',()=>{
  // A panel that once had a separate proxy domain, set up again on a single one.
  const h=host();fs.writeFileSync(path.join(h.dir('panel'),'.env'),'ADMIN_PATH=secret-admin\nSECURE_COOKIES=false\nLOCAL_PROXY_BASE_URL=https://old-proxy.example.com\n');
  assert.equal(h.run('configure-domain.sh',['Panel.Example.com','ops@example.com']).status,0);
  // The stale proxy domain is cleared: Nginx no longer serves it, and the panel would otherwise keep
  // refusing node requests on its own domain.
  assert.deepEqual(h.env('panel'),{ADMIN_PATH:'secret-admin',SECURE_COOKIES:'true',LOCAL_PROXY_BASE_URL:'',ADMIN_PUBLISH_IP:'127.0.0.1',PROXY_PUBLISH_IP:'127.0.0.1',PUBLIC_BASE_URL:'https://panel.example.com',CERTIFICATE_EMAIL:'ops@example.com'});
  assert.deepEqual(h.calls().filter(call=>/^(certbot|docker) /.test(call)),['certbot --nginx -d panel.example.com --non-interactive --agree-tos --redirect -m ops@example.com','docker compose version','docker compose up -d --force-recreate']);
  assert.match(h.site('aegis-relay'),/# managed by Certbot: panel\.example\.com/,'the certificate went into the site');
  // Then given a proxy domain of its own.
  assert.equal(h.run('configure-local-domain.sh',['Emby.Example.com','Ops@Example.com']).status,0);
  assert.deepEqual([h.env('panel').PUBLIC_BASE_URL,h.env('panel').LOCAL_PROXY_BASE_URL,h.env('panel').CERTIFICATE_EMAIL],['https://panel.example.com','https://emby.example.com','ops@example.com']);
  assert.deepEqual(h.calls().filter(call=>call.startsWith('certbot ')).slice(1).map(call=>call.split(' ')[3]),['panel.example.com','emby.example.com'],'a certificate for each of the two domains');
  assert.equal(fs.statSync(path.join(h.dir('panel'),'.env')).mode&0o777,0o600);
  // The proxy domain must be another name than the panel's.
  const same=h.run('configure-local-domain.sh',['panel.example.com','ops@example.com']);
  assert.deepEqual([same.status,/面板域名与代理域名必须不同/.test(same.output)],[1,true]);
});

test('setting an agent\'s direct address records it in the agent\'s .env',()=>{
  const h=host();
  assert.equal(h.run('agent-configure-domain.sh',['HK.Example.com','ops@example.com']).status,0);
  assert.deepEqual(h.env('agent'),{PANEL_URL:'https://panel.example.com',AGENT_DOMAIN:'hk.example.com',AGENT_EMAIL:'ops@example.com'});
  assert.deepEqual(h.calls().filter(call=>call.startsWith('certbot ')),['certbot --nginx -d hk.example.com --non-interactive --agree-tos --redirect -m ops@example.com']);
  assert.match(h.site('aegis-relay-agent'),/# managed by Certbot: hk\.example\.com/,'the certificate went into the site');
  assert.ok(h.calls().includes('systemctl enable --now certbot.timer'),'and is renewed by itself');
  // Then moved to its public IP: plain HTTP, no certificate, and the distribution's default site out of the way.
  fs.symlinkSync('../sites-available/default',path.join(h.dir('nginx'),'sites-enabled','default'));
  assert.equal(h.run('agent-configure-ip.sh').status,0);
  assert.deepEqual(h.env('agent'),{PANEL_URL:'https://panel.example.com',AGENT_DOMAIN:'',AGENT_EMAIL:'ops@example.com',AGENT_PROXY_MODE:'ip',AGENT_PROXY_IP:'203.0.113.9'});
  assert.equal(h.calls().filter(call=>call.startsWith('certbot ')).length,1);
  assert.equal(fs.existsSync(path.join(h.dir('nginx'),'sites-enabled','default')),false);
  assert.equal(fs.statSync(path.join(h.dir('agent'),'.env')).mode&0o777,0o600);
  // Input that is not a domain and an email is turned away before anything is touched.
  const fresh=host();
  for(const args of [['bad_domain!','ops@example.com'],['hk.example.com','not-an-email'],['hk.example.com']]){
    assert.equal(fresh.run('agent-configure-domain.sh',args).status,1,args.join(' '));
    assert.deepEqual([fresh.site('aegis-relay-agent'),fresh.calls().filter(call=>!call.startsWith('id '))],[null,[]],args.join(' '));
  }
});

test('a dead third-party APT source does not stop a site from being set up; a missing package does',()=>{
  // These scripts stop at the first failing command, so a plain `apt-get update` would let any broken
  // source on the machine (a 402 from a third-party repository, say) abort the whole setup.
  const setups={
    'agent-configure-domain.sh':[['hk.example.com','ops@example.com'],'aegis-relay-agent',[]],
    'agent-configure-ip.sh':[[],'aegis-relay-agent',[]],
    'configure-domain.sh':[['panel.example.com','ops@example.com'],'aegis-relay',[]],
    'configure-local-domain.sh':[['emby.example.com','ops@example.com'],'aegis-relay',[['configure-domain.sh',['panel.example.com','ops@example.com']]]]
  };
  for(const [script,[args,site,before]] of Object.entries(setups)){
    const dead=host();for(const [earlier,earlierArgs] of before)dead.run(earlier,earlierArgs);
    const result=dead.run(script,args,{TEST_APT_SOURCE_DEAD:'1'});
    assert.equal(result.status,0,`${script}: ${result.output}`);
    assert.match(result.output,/警告：apt 源索引更新失败/,script);
    assert.ok(dead.site(site)&&dead.calls().some(call=>call.startsWith('apt-get install -y nginx')),script);
    // The install itself stays fatal: a package that really is missing must not be papered over.
    const missing=host();for(const [earlier,earlierArgs] of before)missing.run(earlier,earlierArgs);
    const calls=missing.calls().length,written=missing.site(site);
    assert.notEqual(missing.run(script,args,{TEST_APT_PACKAGE_MISSING:'1'}).status,0,script);
    assert.equal(missing.site(site),written,`${script} leaves the site alone`);
    assert.deepEqual(missing.calls().slice(calls).filter(call=>/^(nginx|certbot|systemctl|docker) /.test(call)),[],script);
  }
});

test('the entry domain is refused when it is this machine\'s own direct domain',()=>{
  // A steering redirect targets a machine's direct domain because that always reaches this one machine.
  const agent=host();fs.writeFileSync(path.join(agent.dir('agent'),'.env'),'AGENT_DOMAIN=Entry.Example.com\n');
  const panel=host();fs.writeFileSync(path.join(panel.dir('panel'),'.env'),'ADMIN_PATH=secret-admin\nPUBLIC_BASE_URL=https://panel.example.com\nLOCAL_PROXY_BASE_URL=https://entry.example.com\n');
  for(const h of [agent,panel]){
    const result=h.run('configure-entry-domain.sh',['entry.example.com','ops@example.com','peer-a.example.com']);
    assert.equal(result.status,1,result.output);
    assert.match(result.output,/入口域名 entry\.example\.com 目前就是这台机器的直连域名/);
    assert.equal(h.site('aegis-relay-entry'),null,'nothing is written');
    assert.deepEqual(h.calls().filter(call=>/^(nginx|certbot|systemctl|apt-get) /.test(call)),[]);
  }
  // Another machine's domain in those files is no obstacle.
  const other=host();fs.writeFileSync(path.join(other.dir('panel'),'.env'),'ADMIN_PATH=secret-admin\nPUBLIC_BASE_URL=https://panel.example.com\n');
  assert.equal(other.run('configure-entry-domain.sh',['entry.example.com','ops@example.com']).status,0);
});

test('an install ships the library with every script that sources it',()=>{
  const sourcing=fs.readdirSync(SCRIPTS).filter(name=>fs.readFileSync(path.join(SCRIPTS,name),'utf8').includes('host-site.sh}"')).sort();
  assert.deepEqual(sourcing,['agent-configure-domain.sh','agent-configure-ip.sh','configure-domain.sh','configure-entry-domain.sh','configure-local-domain.sh']);
  // An agent gets its scripts one by one, from the installer and again from every upgrade; the library
  // has to be among them, and in place before the first script that needs it.
  for(const installer of ['agent-install.sh','agent-upgrade.sh']){
    const installed=[...fs.readFileSync(path.join(SCRIPTS,installer),'utf8').matchAll(/^install -m \d+ "\$TMP_DIR\/source\/scripts\/([\w.-]+)" "\$INSTALL_DIR\/\1"$/gm)].map(match=>match[1]);
    assert.equal(installed[0],'host-site.sh',installer);
    for(const script of sourcing.filter(name=>name.startsWith('agent-')||name==='configure-entry-domain.sh'))assert.ok(installed.includes(script),`${installer} installs ${script}`);
  }
  // The panel machine keeps the whole repository, scripts/ included.
  assert.match(fs.readFileSync(path.join(SCRIPTS,'bootstrap.sh'),'utf8'),/^cp -a "\$TMP_DIR\/source\/\." "\$INSTALL_DIR\/"$/m);
});
