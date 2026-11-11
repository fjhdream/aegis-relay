import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DOMAIN_REQUEST_FILE, followDomain, readDomainStatus, servingAddress } from '../src/domain-control.js';

// The host scripts, run for real against a stand-in host: a temporary directory holds Nginx's site
// directories, the install directories and Let's Encrypt's, and a bin/ ahead of PATH holds stand-ins
// for the commands that would touch the machine (nginx, certbot, systemctl, apt-get, …). The scripts,
// the shell and the text tools they use are the real ones.

const SCRIPTS=new URL('../scripts/',import.meta.url).pathname,LIBRARY=new URL('../src/host-site.sh',import.meta.url).pathname;
const which=name=>spawnSync('/bin/sh',['-c',`command -v ${name}`],{encoding:'utf8'}).stdout.trim();
const STUBS={
  id:'echo 0',
  // A dead third-party source fails `update`; a package that cannot be had fails `install`.
  'apt-get':'[ "$1" = update ] && [ "${TEST_APT_SOURCE_DEAD:-0}" = 1 ] && exit 100; [ "$1" = install ] && [ "${TEST_APT_PACKAGE_MISSING:-0}" = 1 ] && exit 100; exit 0',
  // The first address of a local interface: not necessarily a public one.
  hostname:'echo 198.51.100.7',
  systemctl:'exit 0',
  docker:'exit 0',
  'docker-compose':'exit 0',
  // `nginx -t` passes unless the test says this host's Nginx rejects the configuration.
  nginx:'[ "${TEST_NGINX_REJECTS:-0}" = 1 ] && { echo "nginx: configuration file test failed" >&2; exit 1; }; exit 0',
  // The public-address lookup answers (or cannot be reached); any request that saves a body (the entry
  // domain probing itself) fails, so nothing looks already set up.
  curl:'for a in "$@"; do [ "$a" = -o ] && exit 22; done; [ "${TEST_LOOKUP_DOWN:-0}" = 1 ] && exit 6; echo "${TEST_LOOKUP_SAYS:-203.0.113.9}"',
  getent:'[ "$1" = ahostsv4 ] && echo "203.0.113.9 STREAM $2"; exit 0',
  // certbot --nginx rewrites the site it finds the domain in; certonly leaves a certificate behind.
  certbot:`[ "\${TEST_CERTBOT_FAILS:-0}" = 1 ] && { printf '%s\\n' "\${TEST_CERTBOT_SAYS:-certbot: challenge failed}" >&2; exit 1; }
domain=; only=0; prev=
for a in "$@"; do [ "$prev" = -d ] && domain=$a; [ "$a" = certonly ] && only=1; prev=$a; done
if [ "$only" = 1 ]; then mkdir -p "$AEGIS_LETSENCRYPT_DIR/live/$domain"; : > "$AEGIS_LETSENCRYPT_DIR/live/$domain/fullchain.pem"; : > "$AEGIS_LETSENCRYPT_DIR/live/$domain/privkey.pem"; exit 0; fi
for site in "$AEGIS_NGINX_DIR"/sites-available/*.conf; do grep -q "server_name $domain;" "$site" && printf '    # managed by Certbot: %s\\n' "$domain" >> "$site"; done
exit 0`
};

// The real tools, except where a test asks otherwise. Not recorded among the calls.
const QUIET_STUBS={
  // The awk writing an .env fails when the disk is full (for every key, or from one key on): the shell
  // has already created the empty output file by then, as on a real full disk.
  awk:`case "$*" in *'END{if(!done)print key"="value}'*) case "\${TEST_DISK_FULL:-0} $*" in 1\\ *|*"key=\${TEST_DISK_FULL_AT:-no such key} "*) echo "awk: write failure" >&2; exit 2;; esac;; esac\nexec ${which('awk')} "$@"`,
  // Random bytes the test knows, so that it can put something at the name they lead to.
  od:`[ "\${TEST_KNOWN_RANDOM:-0}" = 1 ] && { echo " 01 02 03 04 05 06 07 08"; exit 0; }\nexec ${which('od')} "$@"`,
  // A temporary file in the agent's data directory that its owner swapped for something else the
  // moment it appeared: mktemp hands back the name, and what is there now is not what it made.
  mktemp:`for a in "$@"; do case "$a" in */data/.host-domain-status.*) [ -n "\${TEST_SWAPPED_TEMP:-}" ] && { echo "$TEST_SWAPPED_TEMP"; exit 0; };; esac; done\nexec ${which('mktemp')} "$@"`
};

// One set of stand-ins for the whole file (each records its calls in the host it was run for), and
// every temporary host is removed when the file is done.
const BIN=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-host-bin-')),ROOTS=[BIN];
for(const [name,body] of Object.entries(STUBS))fs.writeFileSync(path.join(BIN,name),`#!/bin/sh\nprintf '%s %s\\n' ${name} "$*" >> "$TEST_CALLS"\n${body}\n`,{mode:0o755});
for(const [name,body] of Object.entries(QUIET_STUBS))fs.writeFileSync(path.join(BIN,name),`#!/bin/sh\n${body}\n`,{mode:0o755});
after(()=>{for(const root of ROOTS)fs.rmSync(root,{recursive:true,force:true})});

// What an agent has on disk is what its installer put there: the scripts on the installer's list, and
// src/, which it copies whole. The list has been the same since before the library existed, which is
// why the library is in src/: an installer older than the scripts it installs still delivers it.
const INSTALLED_ON_AGENT=[...fs.readFileSync(path.join(SCRIPTS,'agent-install.sh'),'utf8').matchAll(/^install -m \d+ "\$TMP_DIR\/source\/scripts\/([\w.-]+)" (?:"\$INSTALL_DIR\/\1"|\/usr\/local\/bin\/\1)$/gm)].map(match=>match[1]).sort();

function host() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aegis-host-')),dir=name=>path.join(root,name),calls=dir('calls');
  ROOTS.push(root);
  for(const name of ['nginx/sites-available','nginx/sites-enabled','letsencrypt','acme-root','tmp','agent/data','agent/src','panel/scripts','panel/src'])fs.mkdirSync(dir(name),{recursive:true});
  for(const name of INSTALLED_ON_AGENT)fs.copyFileSync(path.join(SCRIPTS,name),path.join(dir('agent'),name));
  // The panel machine keeps the whole repository: its scripts in scripts/, the library beside them in src/.
  for(const name of fs.readdirSync(SCRIPTS))fs.copyFileSync(path.join(SCRIPTS,name),path.join(dir('panel/scripts'),name));
  for(const to of ['agent/src','panel/src'])fs.copyFileSync(LIBRARY,path.join(dir(to),'host-site.sh'));
  fs.writeFileSync(path.join(dir('agent'),'.env'),'PANEL_URL=https://panel.example.com\nAGENT_DOMAIN=\nAGENT_EMAIL=\n');
  fs.writeFileSync(path.join(dir('panel'),'.env'),'ADMIN_PATH=secret-admin\n');
  const env={PATH:`${BIN}:${process.env.PATH}`,TMPDIR:dir('tmp'),TEST_CALLS:calls,AEGIS_NGINX_DIR:dir('nginx'),AEGIS_LETSENCRYPT_DIR:dir('letsencrypt'),AEGIS_AGENT_DIR:dir('agent'),AEGIS_PANEL_DIR:dir('panel'),AEGIS_ACME_ROOT:path.join(dir('acme-root'),'acme')};
  const read=file=>{try{return fs.readFileSync(file,'utf8')}catch{return null}};
  const sh=(args,extra)=>{const result=spawnSync('/bin/sh',args,{encoding:'utf8',timeout:30_000,env:{...env,...extra}});return {...result,output:`${result.stdout}${result.stderr}`}};
  const dotenv=install=>Object.fromEntries((read(path.join(dir(install),'.env'))||'').split('\n').filter(Boolean).map(line=>[line.slice(0,line.indexOf('=')),line.slice(line.indexOf('=')+1)]));
  // The agent container reads .env once, when it is created. Nothing here recreates it unless a test says so.
  const installedWith=()=>{const values=dotenv('agent');return {mode:values.AGENT_PROXY_MODE||'',domain:values.AGENT_DOMAIN||'',ip:values.AGENT_PROXY_IP||''}};
  let container=installedWith();
  return {
    root,dir,
    // Run a script as the machine would: an agent's from its install directory, the panel's from scripts/.
    run:(script,args=[],extra={})=>sh([path.join(dir(INSTALLED_ON_AGENT.includes(script)?'agent':'panel/scripts'),script),...args],extra),
    site:name=>read(path.join(dir('nginx'),'sites-available',`${name}.conf`)),
    enabled:name=>fs.existsSync(path.join(dir('nginx'),'sites-enabled',`${name}.conf`)),
    // What an upgrade does once the new agent is up, in the form agent-upgrade.sh calls it: on the left
    // of `||`, where the shell does not stop at a failing command.
    upgrade:(extra={})=>sh(['-c','. "$1"; agent_serve_current || exit $?','sh',path.join(dir('agent/src'),'host-site.sh')],extra),
    // Since when: the calls made after the first `count` ones.
    since:count=>(read(calls)||'').trim().split('\n').filter(Boolean).slice(count),
    calls:()=>(read(calls)||'').trim().split('\n').filter(Boolean),
    // The agent's side of things: the status file as the agent reads it, the environment its container
    // has, the address it will report on its next heartbeat (the reading src/agent-runtime.js does),
    // and a request as it files one.
    status:()=>readDomainStatus(dir('agent/data')),
    containerEnv:()=>container,
    recreateContainer(){container=installedWith()},
    reported:()=>servingAddress({dir:dir('agent/data'),installed:container}),
    forgetStatus:()=>fs.rmSync(path.join(dir('agent/data'),'host-domain-status.json'),{force:true}),
    request:value=>fs.writeFileSync(path.join(dir('agent/data'),DOMAIN_REQUEST_FILE),typeof value==='string'?value:JSON.stringify(value)),
    requested:()=>fs.existsSync(path.join(dir('agent/data'),DOMAIN_REQUEST_FILE)),
    // An install's .env as an object ("panel" or "agent"); what the scripts left in the temporary directory.
    env:dotenv,
    leftovers:()=>fs.readdirSync(dir('tmp'))
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
  const render=(name,file,steps)=>{const h=host();for(const [script,args,extra,expect=0] of steps){const result=h.run(script,args,extra);assert.equal(result.status,expect,`${name}: ${script} ${result.output}`)}sites[name]=h.site(file);assert.ok(sites[name],name);assert.ok(h.enabled(file),`${name} is enabled`)};
  render('agent on a domain','aegis-relay-agent',[['agent-configure-domain.sh',['HK.Example.com','ops@example.com']]]);
  render('agent on its IP','aegis-relay-agent',[['agent-configure-ip.sh']]);
  render('panel on one domain','aegis-relay',[['configure-domain.sh',['panel.example.com','ops@example.com']]]);
  render('panel with a separate proxy domain','aegis-relay',[['configure-domain.sh',['panel.example.com','ops@example.com']],['configure-local-domain.sh',['emby.example.com','ops@example.com']]]);
  render('entry domain','aegis-relay-entry',[['configure-entry-domain.sh',['entry.example.com','ops@example.com','peer-a.example.com','peer-b.example.com']]]);
  render('entry domain, no other machine','aegis-relay-entry',[['configure-entry-domain.sh',['entry.example.com','ops@example.com']]]);
  render('entry domain before its certificate','aegis-relay-entry',[['configure-entry-domain.sh',['entry.example.com','ops@example.com','peer-a.example.com'],{TEST_CERTBOT_FAILS:'1'},1]]);
  return renderedSites=sites;
}

test('every site that carries Emby traffic gets the one data-plane location',()=>{
  const sites=rendered();
  // What the library prints, asked for directly.
  const printed=spawnSync('/bin/sh',['-c','. "$1"; data_plane_location aegis_x_backend aegis_x_connection_upgrade','sh',LIBRARY],{encoding:'utf8'});
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

test('an agent on a domain gets a certificate that renews itself; on its IP it needs none',()=>{
  const h=host();
  assert.equal(h.run('agent-configure-domain.sh',['HK.Example.com','ops@example.com']).status,0);
  assert.deepEqual(h.calls().filter(call=>call.startsWith('certbot ')),['certbot --nginx -d hk.example.com --non-interactive --agree-tos --redirect -m ops@example.com']);
  assert.match(h.site('aegis-relay-agent'),/# managed by Certbot: hk\.example\.com/,'the certificate went into the site');
  assert.ok(h.calls().includes('systemctl enable --now certbot.timer'));
  // Moved to its public IP: plain HTTP, no certificate, and the distribution's default site out of the way.
  fs.symlinkSync('../sites-available/default',path.join(h.dir('nginx'),'sites-enabled','default'));
  assert.equal(h.run('agent-configure-ip.sh').status,0);
  assert.equal(h.calls().filter(call=>call.startsWith('certbot ')).length,1);
  assert.equal(fs.existsSync(path.join(h.dir('nginx'),'sites-enabled','default')),false);
  assert.equal(fs.statSync(path.join(h.dir('agent'),'.env')).mode&0o777,0o600);
  // Input that is not a domain and an email is turned away before anything is touched.
  const fresh=host();
  for(const args of [['bad_domain!','ops@example.com'],['hk.example.com','not-an-email'],['hk.example.com']]){
    assert.equal(fresh.run('agent-configure-domain.sh',args).status,1,args.join(' '));
    assert.deepEqual([fresh.site('aegis-relay-agent'),fresh.status(),fresh.calls()],[null,null,[]],args.join(' '));
  }
});

// The request files are read with python3 on the host; a machine without it cannot run those tests.
const PYTHON=spawnSync('python3',['-c','print(1)']).status===0;
// An agent installed on its IP, as `agent-install.sh --mode ip` leaves it: the container is started
// first, with an .env that names no address yet, and the address is set up after.
function agentOnItsIp() {
  const h=host();
  fs.writeFileSync(path.join(h.dir('agent'),'.env'),'PANEL_URL=https://panel.example.com\nAGENT_DOMAIN=\nAGENT_EMAIL=\nAGENT_VERSION=0.13.12\n');
  h.recreateContainer();
  assert.equal(h.run('agent-configure-ip.sh').status,0);
  return h;
}
// The three ways a switch is asked for. The installer and the upgrade run the configure scripts.
const CALLERS={
  'the configure scripts (installer, upgrade)':{domain:(h,domain,email,extra)=>h.run('agent-configure-domain.sh',[domain,email],extra),ip:(h,extra)=>h.run('agent-configure-ip.sh',[],extra)},
  'the aegis-relay-agent command':{domain:(h,domain,email,extra)=>h.run('aegis-relay-agent',['domain',domain,email],extra),ip:(h,extra)=>h.run('aegis-relay-agent',['ip'],extra)},
  'a request from the panel':{python:true,
    domain:(h,domain,email,extra)=>{h.request({version:1,requestId:'request-0001',mode:'domain',desiredDomain:domain,certificateEmail:email});return h.run('agent-host-domain-apply.sh',[],extra)},
    ip:(h,extra)=>{h.request({version:1,requestId:'request-0002',mode:'ip'});return h.run('agent-host-domain-apply.sh',[],extra)}}
};

test('whoever sets an agent\'s direct address, the agent ends up reporting what Nginx serves',t=>{
  const ends=[];
  for(const [who,caller] of Object.entries(CALLERS)){
    if(caller.python&&!PYTHON){t.diagnostic(`python3 is not installed: skipping "${who}"`);continue}
    const h=agentOnItsIp(),calls=h.calls().length,seen=[];
    assert.deepEqual(h.containerEnv(),{mode:'',domain:'',ip:''},'the container was started before any address was set');
    // From its IP to a domain.
    const toDomain=caller.domain(h,'HK.Example.com','ops@example.com');
    assert.equal(toDomain.status,0,`${who}: ${toDomain.output}`);
    assert.match(h.site('aegis-relay-agent'),/server_name hk\.example\.com;/,who);
    assert.deepEqual(h.env('agent'),{PANEL_URL:'https://panel.example.com',AGENT_DOMAIN:'hk.example.com',AGENT_EMAIL:'ops@example.com',AGENT_VERSION:'0.13.12',AGENT_PROXY_MODE:'domain',AGENT_PROXY_IP:'203.0.113.9'},who);
    const {requestId,updatedAt,...onDomain}=h.status();
    assert.deepEqual(onDomain,{state:'active',mode:'domain',desiredDomain:'hk.example.com',currentDomain:'hk.example.com',message:'域名已切换，证书自动续期已启用'},who);
    assert.ok(Math.abs(Date.now()-Date.parse(updatedAt))<60_000,`${who}: ${updatedAt}`);
    assert.deepEqual(h.reported(),{mode:'domain',domain:'hk.example.com'},who);
    seen.push(h.env('agent'),onDomain);
    // A machine that enrolls again loses the status file and gets a new container: .env alone says the same.
    h.forgetStatus();h.recreateContainer();
    assert.deepEqual(h.reported(),{mode:'domain',domain:'hk.example.com'},`${who}, from .env alone`);
    // And back to its IP.
    const toIp=caller.ip(h);
    assert.equal(toIp.status,0,`${who}: ${toIp.output}`);
    assert.match(h.site('aegis-relay-agent'),/server_name _;/,who);
    assert.deepEqual(h.env('agent'),{PANEL_URL:'https://panel.example.com',AGENT_DOMAIN:'',AGENT_EMAIL:'ops@example.com',AGENT_VERSION:'0.13.12',AGENT_PROXY_MODE:'ip',AGENT_PROXY_IP:'203.0.113.9'},who);
    const {requestId:second,updatedAt:later,...onIp}=h.status();
    assert.deepEqual(onIp,{state:'active',mode:'ip',desiredDomain:'',currentDomain:'203.0.113.9',message:'已切换为 IP 反代（HTTP）'},who);
    assert.deepEqual(h.reported(),{mode:'ip',domain:'203.0.113.9'},who);
    h.forgetStatus();h.recreateContainer();
    assert.deepEqual(h.reported(),{mode:'ip',domain:'203.0.113.9'},`${who}, from .env alone`);
    seen.push(h.env('agent'),onIp);
    // The status names the panel's request when there was one.
    assert.deepEqual([requestId,second],caller.python?['request-0001','request-0002']:['',''],who);
    // The agent container is left running: nobody watching through this machine loses their stream.
    assert.deepEqual(h.calls().slice(calls).filter(call=>call.startsWith('docker')),[],who);
    assert.deepEqual(h.leftovers(),[],`${who}: no temporary file is left behind`);
    ends.push(seen);
  }
  for(const end of ends)assert.deepEqual(end,ends[0],'every caller leaves the same state');
});

test('the agent goes by the status file, not by the environment its container was started with',()=>{
  // The container is not restarted after a switch, so what it was started with says less and less.
  const h=agentOnItsIp(),data=h.dir('agent/data'),wanted={mode:'',domain:'hk.example.com',email:'ops@example.com'};
  // What the host does with a request the agent filed, whichever way the test machine can do it.
  const hostHandles=extra=>{if(PYTHON)return h.run('agent-host-domain-apply.sh',[],extra);const request=JSON.parse(fs.readFileSync(path.join(data,DOMAIN_REQUEST_FILE),'utf8'));fs.rmSync(path.join(data,DOMAIN_REQUEST_FILE));return request.mode==='ip'?h.run('agent-configure-ip.sh',[],extra):h.run('agent-configure-domain.sh',[request.desiredDomain,request.certificateEmail],extra)};
  assert.deepEqual([h.containerEnv(),h.reported()],[{mode:'',domain:'',ip:''},{mode:'ip',domain:'203.0.113.9'}]);
  // The panel wants a domain. The agent files the request; while it waits it still reports its IP.
  assert.equal(followDomain({dir:data,desired:wanted,installed:h.containerEnv()}),true);
  assert.deepEqual([h.status().state,h.reported()],['pending',{mode:'ip',domain:'203.0.113.9'}]);
  // The certificate cannot be issued. Read from the container's environment this would be a domain
  // with no name, and the panel would hand out https:// addresses for an IP.
  assert.equal(hostHandles({TEST_CERTBOT_FAILS:'1'}).status,1);
  assert.deepEqual([h.status().state,h.reported()],['failed',{mode:'ip',domain:'203.0.113.9'}]);
  assert.equal(followDomain({dir:data,desired:wanted,installed:h.containerEnv()}),false,'and the agent does not ask again at once');
  // Later it goes through; then a switch back to the IP fails. Still the domain, not what the container started with.
  assert.equal(h.run('agent-configure-domain.sh',['hk.example.com','ops@example.com']).status,0);
  assert.equal(followDomain({dir:data,desired:{mode:'ip'},installed:h.containerEnv()}),true);
  assert.deepEqual(h.reported(),{mode:'domain',domain:'hk.example.com'},'while the request waits');
  assert.equal(hostHandles({TEST_NGINX_REJECTS:'1'}).status,1);
  assert.deepEqual([h.status().state,h.reported()],['failed',{mode:'domain',domain:'hk.example.com'}]);
  // An agent installed on a domain, moved to its IP with the command, then asked for a domain that fails.
  const moved=host();fs.writeFileSync(path.join(moved.dir('agent'),'.env'),'AGENT_DOMAIN=first.example.com\nAGENT_EMAIL=ops@example.com\n');moved.recreateContainer();
  assert.equal(moved.run('agent-configure-domain.sh',['first.example.com','ops@example.com']).status,0);
  assert.equal(moved.run('aegis-relay-agent',['ip']).status,0);
  assert.equal(moved.run('agent-configure-domain.sh',['second.example.com','ops@example.com'],{TEST_CERTBOT_FAILS:'1'}).status,1);
  assert.deepEqual([moved.containerEnv().domain,moved.reported()],['first.example.com',{mode:'ip',domain:'203.0.113.9'}],'not the domain it was installed with');
  // An IPv6 literal is not a domain either. (The panel takes no IPv6 address at all, in any version;
  // that is not for this reading to decide.)
  fs.writeFileSync(path.join(moved.dir('agent/data'),'host-domain-status.json'),JSON.stringify({state:'failed',mode:'domain',desiredDomain:'x.example.com',currentDomain:'2001:db8::7'}));
  assert.deepEqual(moved.reported(),{mode:'ip',domain:'2001:db8::7'});
});

test('a machine whose .env and status file disagreed is put right by the next switch',()=>{
  // Two states older versions could leave behind. An agent that once got a domain from the panel, with
  // the status file still saying so, switched since by a path that did not update it:
  const stale=agentOnItsIp();
  fs.writeFileSync(path.join(stale.dir('agent/data'),'host-domain-status.json'),JSON.stringify({requestId:'old-request-01',state:'active',mode:'domain',desiredDomain:'old.example.com',currentDomain:'old.example.com',message:'',updatedAt:'2026-01-01T00:00:00Z'}));
  assert.deepEqual(stale.reported(),{mode:'domain',domain:'old.example.com'},'it reports a domain Nginx no longer serves');
  assert.equal(stale.run('aegis-relay-agent',['domain','new.example.com','ops@example.com']).status,0);
  assert.deepEqual([stale.reported(),stale.status().currentDomain,stale.status().requestId],[{mode:'domain',domain:'new.example.com'},'new.example.com','']);
  // And one moved from its IP to a domain while .env kept AGENT_PROXY_MODE=ip:
  const marked=host();
  fs.writeFileSync(path.join(marked.dir('agent'),'.env'),'AGENT_DOMAIN=hk.example.com\nAGENT_EMAIL=ops@example.com\nAGENT_PROXY_MODE=ip\nAGENT_PROXY_IP=203.0.113.9\n');marked.recreateContainer();
  assert.deepEqual(marked.reported(),{mode:'ip',domain:'203.0.113.9'},'it reports its IP while Nginx serves the domain');
  assert.equal(marked.run('agent-configure-domain.sh',['hk.example.com','ops@example.com']).status,0);
  assert.deepEqual([marked.reported(),marked.env('agent').AGENT_PROXY_MODE],[{mode:'domain',domain:'hk.example.com'},'domain']);
});

test('a request from the panel is checked before it reaches Nginx, and answered in the status file',{skip:!PYTHON&&'python3 is not installed'},()=>{
  const h=agentOnItsIp(),before=h.status(),quiet=()=>h.calls().filter(call=>/^(nginx|certbot|systemctl|apt-get) /.test(call)).length,calls=quiet();
  assert.deepEqual([h.run('agent-host-domain-apply.sh').status,quiet()],[0,calls],'nothing to do without a request');
  // The request comes from an unprivileged container: anything unexpected is dropped, not acted on.
  const good={version:1,requestId:'request-0003',mode:'domain',desiredDomain:'hk.example.com',certificateEmail:'ops@example.com'};
  for(const [what,request] of [['no request id',{...good,requestId:''}],['a request id with shell characters',{...good,requestId:'$(reboot)-0001'}],['an unknown mode',{...good,mode:'tunnel'}],
    ['a domain with shell characters',{...good,desiredDomain:'hk.example.com;reboot'}],['a domain that is a path',{...good,desiredDomain:'../../etc'}],['no email',{...good,certificateEmail:''}],['an email with a space',{...good,certificateEmail:'ops @example.com'}],
    ['a domain that is not a string',{...good,desiredDomain:['hk.example.com']}],['not JSON','{']]){
    h.request(request);
    assert.equal(h.run('agent-host-domain-apply.sh').status,1,what);
    assert.deepEqual([h.requested(),quiet(),h.status()],[false,calls,before],what);
  }
  // A switch that fails is reported with the reason, under the request's id, and the request is gone.
  h.request(good);
  const failed=h.run('agent-host-domain-apply.sh',[],{TEST_CERTBOT_FAILS:'1',TEST_CERTBOT_SAYS:'Challenge failed for "hk.example.com":\tDNS problem\\NXDOMAIN'});
  assert.deepEqual([failed.status,h.requested()],[1,false]);
  const status=h.status();
  assert.deepEqual([status.requestId,status.state,status.mode,status.desiredDomain,status.currentDomain],['request-0003','failed','domain','hk.example.com','203.0.113.9']);
  assert.ok(status.message.includes('Challenge failed for "hk.example.com": DNS problem\\NXDOMAIN')&&status.message.endsWith('请检查 DNS、Cloudflare 与 80/443 端口后重试。'),status.message);
  assert.deepEqual([h.env('agent').AGENT_DOMAIN,h.env('agent').AGENT_PROXY_MODE],['','ip'],'.env still names the address it had');
  assert.deepEqual([fs.readdirSync(h.dir('agent/data')),h.leftovers()],[['host-domain-status.json'],[]],'no temporary file is left behind');
  // Whatever stops the switch, the request gets an answer: the agent files no second one while the
  // first is unanswered. An install without its .env:
  const broken=agentOnItsIp();fs.rmSync(path.join(broken.dir('agent'),'.env'));
  broken.request({...good,requestId:'request-0004'});
  assert.equal(broken.run('agent-host-domain-apply.sh').status,1);
  assert.deepEqual([broken.requested(),broken.status().requestId,broken.status().state,broken.status().message],[false,'request-0004','failed','未找到 Agent 安装']);
  // And one that has lost the library: the request must at least not sit there re-triggering the unit.
  const damaged=agentOnItsIp();fs.rmSync(path.join(damaged.dir('agent/src'),'host-site.sh'));
  damaged.request(good);
  const helpless=damaged.run('agent-host-domain-apply.sh');
  assert.deepEqual([helpless.status,damaged.requested(),damaged.status(),/sudo aegis-relay-agent update/.test(helpless.output)],[1,false,null,true]);
  // With no answer on record the agent asks again on its next heartbeat, instead of waiting for ever.
  assert.equal(followDomain({dir:damaged.dir('agent/data'),desired:{mode:'',domain:'hk.example.com',email:'ops@example.com'},installed:{mode:'ip',domain:'',ip:'203.0.113.9'}}),true);
});

test('a switch that fails leaves the agent serving on the address it had',t=>{
  for(const [who,caller] of Object.entries(CALLERS)){
    if(caller.python&&!PYTHON){t.diagnostic(`python3 is not installed: skipping "${who}"`);continue}
    // On its IP, asked for a domain whose certificate cannot be issued.
    const h=agentOnItsIp(),ipSite=h.site('aegis-relay-agent'),env=h.env('agent'),calls=h.calls().length;
    const refused=caller.domain(h,'hk.example.com','ops@example.com',{TEST_CERTBOT_FAILS:'1'});
    assert.equal(refused.status,1,who);
    assert.equal(h.site('aegis-relay-agent'),ipSite,`${who}: the IP site is back, byte for byte`);
    assert.ok(h.enabled('aegis-relay-agent'),who);
    const after=h.since(calls),certbot=after.findIndex(call=>call.startsWith('certbot '));
    assert.ok(certbot>=0&&after.slice(certbot).includes('systemctl reload nginx'),`${who}: Nginx loads the restored site`);
    assert.deepEqual(h.env('agent'),env,`${who}: .env is untouched`);
    const status=h.status();
    assert.deepEqual([status.state,status.mode,status.desiredDomain,status.currentDomain],['failed','domain','hk.example.com','203.0.113.9'],who);
    assert.match(status.message,/certbot: challenge failed.*已恢复原来的站点/,who);
    assert.deepEqual(h.reported(),{mode:'ip',domain:'203.0.113.9'},`${who}: the agent goes on reporting its IP`);
    // The same request again, once the certificate can be had, goes through.
    assert.equal(caller.domain(h,'hk.example.com','ops@example.com').status,0,who);
    assert.deepEqual(h.reported(),{mode:'domain',domain:'hk.example.com'},who);

    // On that domain now, with the certificate in its site; a switch Nginx rejects changes nothing.
    const domainSite=h.site('aegis-relay-agent'),domainEnv=h.env('agent'),mark=h.calls().length;
    assert.match(domainSite,/# managed by Certbot: hk\.example\.com/);
    fs.symlinkSync('../sites-available/default',path.join(h.dir('nginx'),'sites-enabled','default'));
    const toIp=caller.ip(h,{TEST_NGINX_REJECTS:'1'}),toOther=caller.domain(h,'jp.example.com','ops@example.com',{TEST_NGINX_REJECTS:'1'});
    assert.deepEqual([toIp.status,toOther.status],[1,1],who);
    assert.equal(h.site('aegis-relay-agent'),domainSite,`${who}: the site with its certificate is back`);
    assert.equal(fs.readlinkSync(path.join(h.dir('nginx'),'sites-enabled','default')),'../sites-available/default',`${who}: the default site it moved aside is back`);
    assert.deepEqual(h.since(mark).filter(call=>call.startsWith('certbot ')),[],`${who}: no certificate is asked for a site Nginx refused`);
    assert.deepEqual([h.env('agent'),h.status().state,h.status().currentDomain,h.reported()],[domainEnv,'failed','hk.example.com',{mode:'domain',domain:'hk.example.com'}],who);
    assert.deepEqual(h.leftovers(),[],`${who}: no temporary file is left behind`);
  }
});

test('a first setup that fails leaves no half-made site behind',()=>{
  // A fresh agent, as the installer runs it: no site yet.
  const fresh=host();
  assert.equal(fresh.run('agent-configure-domain.sh',['hk.example.com','ops@example.com'],{TEST_CERTBOT_FAILS:'1'}).status,1);
  assert.deepEqual([fresh.site('aegis-relay-agent'),fresh.enabled('aegis-relay-agent'),fresh.status().state,fresh.env('agent').AGENT_PROXY_MODE],[null,false,'failed',undefined]);
  // A site an operator had disabled stays disabled when the attempt to replace it fails.
  const disabled=host(),available=path.join(disabled.dir('nginx'),'sites-available','aegis-relay-agent.conf');
  fs.writeFileSync(available,'# kept by hand\n');
  assert.equal(disabled.run('agent-configure-ip.sh',[],{TEST_NGINX_REJECTS:'1'}).status,1);
  assert.deepEqual([disabled.site('aegis-relay-agent'),disabled.enabled('aegis-relay-agent')],['# kept by hand\n',false]);
  // What a successful switch replaced is kept beside the site.
  assert.equal(disabled.run('agent-configure-ip.sh').status,0);
  const copies=fs.readdirSync(path.join(disabled.dir('nginx'),'sites-available')).filter(name=>/^aegis-relay-agent\.conf\.backup\.\d{14}$/.test(name));
  assert.equal(copies.length>=1&&fs.readFileSync(path.join(disabled.dir('nginx'),'sites-available',copies[0]),'utf8'),'# kept by hand\n');
  assert.deepEqual([fresh.leftovers(),disabled.leftovers()],[[],[]],'no temporary file is left behind');
});

test('the panel keeps the site it had when a domain setup fails',()=>{
  const h=host();
  assert.equal(h.run('configure-domain.sh',['panel.example.com','ops@example.com']).status,0);
  const live=h.site('aegis-relay'),env=h.env('panel'),calls=h.calls().length;
  assert.match(live,/# managed by Certbot: panel\.example\.com/);
  // An update renders the site again. If the certificate step fails then, HTTPS must not be lost.
  const update=h.run('configure-domain.sh',['panel.example.com','ops@example.com'],{TEST_CERTBOT_FAILS:'1'});
  assert.deepEqual([update.status,/证书申请失败，已恢复原来的站点/.test(update.output)],[1,true]);
  assert.equal(h.site('aegis-relay'),live,'the site with its certificate is back');
  const after=h.since(calls),certbot=after.findIndex(call=>call.startsWith('certbot '));
  assert.ok(after.slice(certbot).includes('systemctl reload nginx'));
  assert.deepEqual([h.env('panel'),after.filter(call=>call.startsWith('docker'))],[env,[]],'.env is untouched and the panel is not restarted');
  // The same for Nginx refusing the new site, and for the two-domain setup at either certificate.
  assert.equal(h.run('configure-domain.sh',['other.example.com','ops@example.com'],{TEST_NGINX_REJECTS:'1'}).status,1);
  assert.equal(h.site('aegis-relay'),live);
  assert.equal(h.run('configure-local-domain.sh',['emby.example.com','ops@example.com'],{TEST_NGINX_REJECTS:'1'}).status,1);
  assert.equal(h.run('configure-local-domain.sh',['emby.example.com','ops@example.com'],{TEST_CERTBOT_FAILS:'1'}).status,1);
  assert.deepEqual([h.site('aegis-relay'),h.env('panel')],[live,env]);
  // A first setup that fails leaves nothing on port 80 in the panel's name.
  const fresh=host();
  assert.equal(fresh.run('configure-domain.sh',['panel.example.com','ops@example.com'],{TEST_CERTBOT_FAILS:'1'}).status,1);
  assert.deepEqual([fresh.site('aegis-relay'),fresh.enabled('aegis-relay'),fresh.env('panel')],[null,false,{ADMIN_PATH:'secret-admin'}]);
  assert.deepEqual([h.leftovers(),fresh.leftovers()],[[],[]],'no temporary file is left behind');
});

test('an upgrade renders again the address Nginx serves, whatever .env says',()=>{
  // A healthy agent on a domain, and one on its IP: the same address afterwards, freshly rendered.
  const onDomain=host();onDomain.run('agent-configure-domain.sh',['hk.example.com','ops@example.com']);
  fs.appendFileSync(path.join(onDomain.dir('nginx'),'sites-available','aegis-relay-agent.conf'),'# tuning from an older version\n');
  assert.equal(onDomain.upgrade().status,0);
  assert.deepEqual([onDomain.reported(),onDomain.status().state,onDomain.site('aegis-relay-agent').includes('older version'),/server_name hk\.example\.com;/.test(onDomain.site('aegis-relay-agent'))],[{mode:'domain',domain:'hk.example.com'},'active',false,true]);
  assert.equal(onDomain.calls().filter(call=>call.startsWith('certbot --nginx -d hk.example.com ')&&call.endsWith('-m ops@example.com')).length,2,'the certificate is put back into the new site');
  const onIp=agentOnItsIp();
  assert.equal(onIp.upgrade().status,0);
  assert.deepEqual([onIp.reported(),/server_name _;/.test(onIp.site('aegis-relay-agent'))],[{mode:'ip',domain:'203.0.113.9'},true]);

  // An agent an older version left with AGENT_PROXY_MODE=ip in .env while Nginx serves its domain: it
  // keeps the domain, and from now on reports it. Read from .env it would be switched to its IP.
  const drifted=host();drifted.run('agent-configure-domain.sh',['hk.example.com','ops@example.com']);
  fs.writeFileSync(path.join(drifted.dir('agent'),'.env'),'AGENT_DOMAIN=hk.example.com\nAGENT_EMAIL=ops@example.com\nAGENT_PROXY_MODE=ip\nAGENT_PROXY_IP=203.0.113.9\n');
  drifted.forgetStatus();drifted.recreateContainer();
  assert.deepEqual(drifted.reported(),{mode:'ip',domain:'203.0.113.9'},'before: it reports its IP');
  assert.equal(drifted.upgrade().status,0);
  assert.match(drifted.site('aegis-relay-agent'),/server_name hk\.example\.com;/);
  assert.deepEqual([drifted.reported(),drifted.env('agent').AGENT_PROXY_MODE],[{mode:'domain',domain:'hk.example.com'},'domain']);
  // The other way round: Nginx serves the IP site while .env still names a domain.
  const other=agentOnItsIp();
  fs.writeFileSync(path.join(other.dir('agent'),'.env'),'AGENT_DOMAIN=old.example.com\nAGENT_EMAIL=ops@example.com\nAGENT_PROXY_IP=203.0.113.9\n');
  assert.equal(other.upgrade().status,0);
  assert.deepEqual([other.reported(),other.env('agent').AGENT_DOMAIN,other.calls().filter(call=>call.startsWith('certbot ')).length],[{mode:'ip',domain:'203.0.113.9'},'',0]);
  // A domain site with no certificate email on record cannot be rendered again; nothing is touched.
  const noEmail=host();noEmail.run('agent-configure-domain.sh',['hk.example.com','ops@example.com']);
  fs.writeFileSync(path.join(noEmail.dir('agent'),'.env'),'AGENT_DOMAIN=hk.example.com\n');
  const kept=noEmail.site('aegis-relay-agent'),calls=noEmail.calls().length,refused=noEmail.upgrade();
  assert.deepEqual([refused.status,/没有证书邮箱/.test(refused.output),noEmail.site('aegis-relay-agent'),noEmail.since(calls)],[1,true,kept,[]]);
});

test('rendering again is not a switch: the address stays, and a failure is not reported as one',()=>{
  // On its IP the agent keeps the address on record, whatever a new lookup would say: the first
  // address of a local interface is often not a public one, and nobody asked for another address.
  const onIp=agentOnItsIp();
  assert.equal(onIp.upgrade({TEST_LOOKUP_SAYS:'198.51.100.99'}).status,0);
  assert.equal(onIp.upgrade({TEST_LOOKUP_DOWN:'1'}).status,0);
  assert.deepEqual([onIp.env('agent').AGENT_PROXY_IP,onIp.status().currentDomain,onIp.calls().filter(call=>call.startsWith('curl ')).length],['203.0.113.9','203.0.113.9',1],'no lookup at all');
  // Asked to switch, it looks the address up; when the lookup cannot be reached it keeps the one it has
  // rather than guess, and only a machine with none on record falls back to its interface.
  assert.equal(onIp.run('agent-configure-ip.sh',[],{TEST_LOOKUP_DOWN:'1'}).status,0);
  assert.equal(onIp.env('agent').AGENT_PROXY_IP,'203.0.113.9');
  assert.equal(onIp.run('agent-configure-ip.sh',[],{TEST_LOOKUP_SAYS:'198.51.100.99'}).status,0);
  assert.deepEqual([onIp.env('agent').AGENT_PROXY_IP,onIp.reported()],['198.51.100.99',{mode:'ip',domain:'198.51.100.99'}]);
  const unknown=host();
  assert.equal(unknown.run('agent-configure-ip.sh',[],{TEST_LOOKUP_DOWN:'1'}).status,0);
  assert.equal(unknown.env('agent').AGENT_PROXY_IP,'198.51.100.7');

  // A re-render that fails leaves the site as it was, and no failed switch appears in the panel for a
  // change nobody asked for: the status goes on saying `active`, with the address Nginx serves.
  const onDomain=host();onDomain.run('agent-configure-domain.sh',['hk.example.com','ops@example.com']);
  const live=onDomain.site('aegis-relay-agent'),{updatedAt,...status}=onDomain.status(),failed=onDomain.upgrade({TEST_CERTBOT_FAILS:'1'}),{updatedAt:later,...after}=onDomain.status();
  assert.deepEqual([failed.status,onDomain.site('aegis-relay-agent'),after,onDomain.reported()],[1,live,status,{mode:'domain',domain:'hk.example.com'}]);

  // The status is made to say what Nginx serves before anything is rendered, because the agent goes
  // by it and an older version may have left one that names another address. Such a machine: the panel
  // once asked for a domain that failed (status: failed, then on a.example.com), the operator later
  // moved it to its IP with a command that did not write the status, and now the upgrade's rendering
  // fails (apt is locked). Without that step the agent would report the domain it left long ago.
  const old=agentOnItsIp();old.recreateContainer();
  fs.writeFileSync(path.join(old.dir('agent/data'),'host-domain-status.json'),JSON.stringify({requestId:'old-request-01',state:'failed',mode:'domain',desiredDomain:'b.example.com',currentDomain:'a.example.com',message:'',updatedAt:'2026-01-01T00:00:00Z'}));
  assert.deepEqual(old.reported(),{mode:'domain',domain:'a.example.com'},'before the upgrade the stale status decides');
  const site=old.site('aegis-relay-agent');
  assert.equal(old.upgrade({TEST_APT_PACKAGE_MISSING:'1'}).status,1);
  assert.deepEqual([old.site('aegis-relay-agent'),old.status().state,old.status().requestId,old.reported()],[site,'active','',{mode:'ip',domain:'203.0.113.9'}]);
  // The same on a domain, where the site names it.
  const named=host();named.run('agent-configure-domain.sh',['hk.example.com','ops@example.com']);
  fs.writeFileSync(path.join(named.dir('agent/data'),'host-domain-status.json'),JSON.stringify({state:'failed',mode:'ip',desiredDomain:'',currentDomain:'203.0.113.9'}));
  assert.equal(named.upgrade({TEST_NGINX_REJECTS:'1'}).status,1);
  assert.deepEqual([named.status().state,named.reported()],['active',{mode:'domain',domain:'hk.example.com'}]);
  // A failed switch the panel is still waiting for is forgotten with it: the agent asks again.
  const waiting=agentOnItsIp(),wanted={mode:'',domain:'hk.example.com',email:'ops@example.com'},ask=()=>followDomain({dir:waiting.dir('agent/data'),desired:wanted,installed:waiting.containerEnv()});
  waiting.run('agent-configure-domain.sh',['hk.example.com','ops@example.com'],{TEST_CERTBOT_FAILS:'1'});
  assert.deepEqual([waiting.status().state,ask()],['failed',false]);
  assert.equal(waiting.upgrade({TEST_NGINX_REJECTS:'1'}).status,1);
  assert.deepEqual([waiting.status().state,waiting.reported(),ask()],['active',{mode:'ip',domain:'203.0.113.9'},true]);
  assert.deepEqual([onIp.leftovers(),onDomain.leftovers(),old.leftovers(),waiting.leftovers()],[[],[],[],[]]);
});

test('an upgrade on a machine with no site yet goes by .env, and does nothing when nothing was set up',()=>{
  const env=(h,text)=>fs.writeFileSync(path.join(h.dir('agent'),'.env'),text);
  // Installed with a domain whose certificate failed at the time: the upgrade tries again.
  const pending=host();env(pending,'AGENT_DOMAIN=hk.example.com\nAGENT_EMAIL=ops@example.com\n');
  assert.equal(pending.upgrade().status,0);
  assert.deepEqual(pending.reported(),{mode:'domain',domain:'hk.example.com'});
  const ip=host();env(ip,'AGENT_DOMAIN=\nAGENT_PROXY_MODE=ip\nAGENT_PROXY_IP=203.0.113.9\n');
  assert.equal(ip.upgrade().status,0);
  assert.match(ip.site('aegis-relay-agent'),/server_name _;/);
  // A site the operator disabled counts as none.
  const disabled=agentOnItsIp();fs.rmSync(path.join(disabled.dir('nginx'),'sites-enabled','aegis-relay-agent.conf'));env(disabled,'AGENT_DOMAIN=hk.example.com\nAGENT_EMAIL=ops@example.com\n');
  assert.equal(disabled.upgrade().status,0);
  assert.match(disabled.site('aegis-relay-agent'),/server_name hk\.example\.com;/);
  // Nothing set up: no domain, or a domain without an email, and no site. The upgrade says how to set one up.
  for(const text of ['AGENT_DOMAIN=\nAGENT_EMAIL=\n','AGENT_DOMAIN=hk.example.com\nAGENT_EMAIL=\n','']){
    const bare=host();env(bare,text);
    const result=bare.upgrade();
    assert.deepEqual([result.status,bare.site('aegis-relay-agent'),bare.status(),bare.calls()],[3,null,null,[]],JSON.stringify(text));
  }
  // agent-upgrade.sh is the caller: it must hand the outcome on, not swallow it.
  const upgrade=fs.readFileSync(path.join(SCRIPTS,'agent-upgrade.sh'),'utf8');
  assert.match(upgrade,/^\. "\$INSTALL_DIR\/src\/host-site\.sh"\nagent_serve_current \|\| case \$\? in\n  3\) echo "若尚未配置直连地址/m);
  assert.ok(upgrade.indexOf('agent_up --force-recreate')<upgrade.indexOf('agent_serve_current'),'the new agent is running before its site is rendered again');
});

test('the status file is written without following anything the agent container put in its data directory',()=>{
  // data/ belongs to the container's user; the scripts run as root. Nothing the container puts there
  // may make root write somewhere else.
  const h=agentOnItsIp(),data=h.dir('agent/data'),statusFile=path.join(data,'host-domain-status.json'),victim=path.join(h.root,'victim');
  assert.equal(fs.statSync(statusFile).mode&0o777,0o644,'the container can read it');
  // The status file replaced by a link to a file only root may write.
  fs.writeFileSync(victim,'root only\n');fs.rmSync(statusFile);fs.symlinkSync(victim,statusFile);
  assert.equal(h.run('agent-configure-ip.sh').status,0);
  assert.equal(fs.readFileSync(victim,'utf8'),'root only\n','nothing is written through the link');
  assert.deepEqual([fs.lstatSync(statusFile).isFile(),h.status().state,fs.readdirSync(data)],[true,'active',['host-domain-status.json']]);
  // A link to a directory in its place: GNU mv, without the care taken, would move the file into it.
  if(spawnSync('mv',['--version']).status===0){
    const elsewhere=path.join(h.root,'elsewhere');fs.mkdirSync(elsewhere);fs.rmSync(statusFile);fs.symlinkSync(elsewhere,statusFile);
    assert.equal(h.run('agent-configure-ip.sh').status,0);
    assert.deepEqual([fs.readdirSync(elsewhere),fs.lstatSync(statusFile).isFile(),h.status().state],[[],true,'active']);
  }
  // The file is first written under a name made of random bytes, so the container cannot have put
  // anything there. Suppose it could: the bytes are known here, and the file a mktemp would have made
  // has been swapped for the container's link by the time it is written. Nothing goes through it.
  const planted=path.join(data,'.host-domain-status.0102030405060708'),known={TEST_KNOWN_RANDOM:'1',TEST_SWAPPED_TEMP:planted};
  fs.writeFileSync(victim,'root only\n');fs.chmodSync(victim,0o600);
  fs.symlinkSync(victim,planted);
  const refused=h.run('agent-configure-ip.sh',[],known);
  assert.deepEqual([fs.readFileSync(victim,'utf8'),fs.statSync(victim).mode&0o777],['root only\n',0o600],'the file behind the link is neither written nor made readable');
  assert.deepEqual([refused.status,/无法写入状态文件/.test(refused.output)],[1,true],'the switch stops instead');
  // A link to a pipe (or a device): the shell would open and write into one of those.
  fs.rmSync(planted);assert.equal(spawnSync('mkfifo',[path.join(h.root,'pipe')]).status,0);fs.symlinkSync(path.join(h.root,'pipe'),planted);
  const piped=h.run('agent-configure-ip.sh',[],known);
  assert.deepEqual([piped.status,piped.error?.code],[1,undefined],'refused at once, not left waiting on the pipe');
  fs.rmSync(planted);
  // A write that cannot be finished leaves no empty file in the container's directory.
  assert.equal(h.run('agent-configure-ip.sh').status,0);
  assert.deepEqual(fs.readdirSync(data),['host-domain-status.json']);
  // The data directory gone altogether: the switch says so instead of pretending.
  const lost=agentOnItsIp();fs.rmSync(lost.dir('agent/data'),{recursive:true});
  const result=lost.run('agent-configure-ip.sh');
  assert.deepEqual([result.status,/无法写入状态文件/.test(result.output),lost.leftovers()],[1,true,[]]);
});

test('a value is written into .env as it is, and a write that fails leaves .env as it was',()=>{
  const h=agentOnItsIp(),envFile=path.join(h.dir('agent'),'.env');
  // An email with backslash sequences passes the checks (it has no space in it). Given to awk the usual
  // way, \012 would become a line break and the rest a second line of .env.
  const email='ops@example.com\\012PANEL_URL=https://elsewhere.example';
  assert.equal(h.run('agent-configure-domain.sh',['hk.example.com',email]).status,0);
  assert.deepEqual([h.env('agent').AGENT_EMAIL,h.env('agent').PANEL_URL,fs.readFileSync(envFile,'utf8').split('\n').filter(line=>line.startsWith('PANEL_URL=')).length],[email,'https://panel.example.com',1]);
  // A full disk: the new .env cannot be written. .env is not replaced by an empty file, the site Nginx
  // had is back, and the switch is reported as failed, by every way of asking.
  const before=fs.readFileSync(envFile,'utf8'),site=h.site('aegis-relay-agent'),full={TEST_DISK_FULL:'1'};
  for(const attempt of [()=>h.upgrade(full),()=>h.run('agent-configure-ip.sh',[],full),()=>h.run('aegis-relay-agent',['domain','jp.example.com','ops@example.com'],full)]){
    const result=attempt();
    assert.equal(result.status,1,result.output);
    assert.match(result.output,/无法写入 .*\.env/);
    assert.deepEqual([fs.readFileSync(envFile,'utf8'),fs.existsSync(`${envFile}.tmp`),h.site('aegis-relay-agent'),h.reported()],[before,false,site,{mode:'domain',domain:'hk.example.com'}]);
  }
  // Not half of it either: the disk giving out at the second key leaves the first as it was.
  const half=h.run('agent-configure-ip.sh',[],{TEST_DISK_FULL_AT:'AGENT_PROXY_MODE'});
  assert.deepEqual([half.status,fs.readFileSync(envFile,'utf8'),fs.existsSync(`${envFile}.tmp`),fs.existsSync(`${envFile}.next`),h.site('aegis-relay-agent')],[1,before,false,false,site]);
  assert.deepEqual([h.status().state,h.status().mode,h.reported()],['failed','ip',{mode:'domain',domain:'hk.example.com'}]);
  assert.deepEqual(h.leftovers(),[]);
  // The panel's script stops at a failed write too, with its .env as it was.
  const panel=host();
  assert.notEqual(panel.run('configure-domain.sh',['panel.example.com','ops@example.com'],full).status,0);
  assert.deepEqual([panel.env('panel'),panel.calls().some(call=>call.startsWith('certbot ')),panel.calls().some(call=>call.startsWith('docker compose up'))],[{ADMIN_PATH:'secret-admin'},true,false],'it had got as far as the certificate, and did not restart the panel');
});

test('the aegis-relay-agent command says how it is used instead of guessing',()=>{
  const h=agentOnItsIp(),calls=h.calls().length;
  for(const args of [['domain'],['domain','hk.example.com'],['domain','hk.example.com','ops@example.com','extra'],['entry','entry.example.com'],['nonsense']]){
    const result=h.run('aegis-relay-agent',args);
    assert.deepEqual([result.status,/用法/.test(result.output)],[1,true],args.join(' '));
  }
  assert.equal(h.calls().length,calls,'and touches nothing');
  // Its `entry` sets up the steering entry domain next to the agent's own site.
  assert.equal(h.run('aegis-relay-agent',['entry','entry.example.com','ops@example.com','peer-a.example.com']).status,0);
  assert.ok(h.enabled('aegis-relay-entry')&&h.enabled('aegis-relay-agent'));
  assert.match(h.site('aegis-relay-entry'),/server_name entry\.example\.com;/);
  // The panel's command hands `entry` to the same script (it cannot be run here: its paths are fixed).
  assert.match(fs.readFileSync(path.join(SCRIPTS,'aegis-relay'),'utf8'),/^do_entry\(\)\{ "\$INSTALL_DIR\/scripts\/configure-entry-domain\.sh" "\$@"; \}$/m);
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

test('whichever version of the installer delivers the scripts, the library comes with them',()=>{
  // An agent's scripts are copied one by one from a fixed list. The installer comes from the panel's own
  // version and the upgrade script may be cached, while the code is the newest tarball: either can be
  // older than the scripts it installs. So a script may rely only on the others on that list, which has
  // not changed since before the library existed, and on src/, which every version copies whole.
  assert.deepEqual(INSTALLED_ON_AGENT,['aegis-relay-agent','agent-configure-domain.sh','agent-configure-ip.sh','agent-host-domain-apply.sh','configure-entry-domain.sh','host-entry-apply.sh']);
  const text=name=>fs.readFileSync(path.join(SCRIPTS,name),'utf8'),copiesSrc=/^rm -rf "\$INSTALL_DIR\/src"; cp -a "\$TMP_DIR\/source\/src" "\$INSTALL_DIR\/src"$/m;
  for(const installer of ['agent-install.sh','agent-upgrade.sh']){
    assert.match(text(installer),copiesSrc,installer);
    assert.ok(text(installer).search(copiesSrc)<text(installer).search(/^install -m /m),`${installer} copies src/ before any script`);
    assert.equal(text(installer).includes('scripts/host-site.sh'),false,`${installer} has no entry of its own for the library`);
  }
  // Every script that needs the library looks for it in src/, beside itself or one directory up.
  const sourcing=fs.readdirSync(SCRIPTS).filter(name=>text(name).includes('host-site.sh')).sort();
  assert.deepEqual(sourcing,['agent-configure-domain.sh','agent-configure-ip.sh','agent-host-domain-apply.sh','agent-upgrade.sh','configure-domain.sh','configure-entry-domain.sh','configure-local-domain.sh']);
  for(const name of sourcing)for(const line of text(name).split('\n').filter(line=>/(^|[ ;])\. "/.test(line)))assert.match(line,/\. "\$(AEGIS_HERE|INSTALL_DIR)\/(\.\.\/)?src\/host-site\.sh"/,`${name}: ${line}`);
  // The panel machine keeps the whole repository, src/ and scripts/ side by side.
  assert.match(text('bootstrap.sh'),/^cp -a "\$TMP_DIR\/source\/\." "\$INSTALL_DIR\/"$/m);
});
