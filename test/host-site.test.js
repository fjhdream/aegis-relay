import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DOMAIN_REQUEST_FILE, readDomainStatus, servingAddress } from '../src/domain-control.js';

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
  certbot:`[ "\${TEST_CERTBOT_FAILS:-0}" = 1 ] && { printf '%s\\n' "\${TEST_CERTBOT_SAYS:-certbot: challenge failed}" >&2; exit 1; }
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
    run(script,args=[],extra={}){const knobs=Object.fromEntries(Object.entries(process.env).filter(([name])=>name.startsWith('TEST_')));const result=spawnSync('/bin/sh',[path.join(dir(script.startsWith('agent-')?'agent':'panel/scripts'),script),...args],{encoding:'utf8',env:{...env,...knobs,...extra}});return {...result,output:`${result.stdout}${result.stderr}`}},
    site:name=>read(path.join(dir('nginx'),'sites-available',`${name}.conf`)),
    enabled:name=>fs.existsSync(path.join(dir('nginx'),'sites-enabled',`${name}.conf`)),
    // What an upgrade does once the new agent is up: the library's agent_serve_current, as agent-upgrade.sh calls it.
    upgrade(extra={}){const knobs=Object.fromEntries(Object.entries(process.env).filter(([name])=>name.startsWith('TEST_')));const result=spawnSync('/bin/sh',['-c','set -eu; . "$1"; agent_serve_current','sh',path.join(dir('agent'),'host-site.sh')],{encoding:'utf8',env:{...env,...knobs,...extra}});return {...result,output:`${result.stdout}${result.stderr}`}},
    // Since when: the calls made after the first `count` ones.
    since:count=>(read(calls)||'').trim().split('\n').filter(Boolean).slice(count),
    calls:()=>(read(calls)||'').trim().split('\n').filter(Boolean),
    // The agent's side of things: the status file as the agent reads it, the address it will report on
    // its next heartbeat (the same reading src/agent-runtime.js does), and a request as it files one.
    status:()=>readDomainStatus(dir('agent/data')),
    reported(){const env=this.env('agent');return servingAddress({dir:dir('agent/data'),installed:{mode:env.AGENT_PROXY_MODE||'',domain:env.AGENT_DOMAIN||'',ip:env.AGENT_PROXY_IP||''}})},
    forgetStatus:()=>fs.rmSync(path.join(dir('agent/data'),'host-domain-status.json'),{force:true}),
    request:value=>fs.writeFileSync(path.join(dir('agent/data'),DOMAIN_REQUEST_FILE),typeof value==='string'?value:JSON.stringify(value)),
    requested:()=>fs.existsSync(path.join(dir('agent/data'),DOMAIN_REQUEST_FILE)),
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
// An agent installed on its IP, as `agent-install.sh --mode ip` leaves it.
function agentOnItsIp() {
  const h=host();
  fs.writeFileSync(path.join(h.dir('agent'),'.env'),'PANEL_URL=https://panel.example.com\nAGENT_DOMAIN=\nAGENT_EMAIL=\nAGENT_VERSION=0.13.12\n');
  assert.equal(h.run('agent-configure-ip.sh').status,0);
  return h;
}
// The three ways a switch is asked for. The installer and the upgrade run the configure scripts.
const CALLERS={
  'the configure scripts (installer, upgrade)':{domain:(h,domain,email)=>h.run('agent-configure-domain.sh',[domain,email]),ip:h=>h.run('agent-configure-ip.sh')},
  'the aegis-relay-agent command':{domain:(h,domain,email)=>h.run('aegis-relay-agent',['domain',domain,email]),ip:h=>h.run('aegis-relay-agent',['ip'])},
  'a request from the panel':{python:true,
    domain:(h,domain,email)=>{h.request({version:1,requestId:'request-0001',mode:'domain',desiredDomain:domain,certificateEmail:email});return h.run('agent-host-domain-apply.sh')},
    ip:h=>{h.request({version:1,requestId:'request-0002',mode:'ip'});return h.run('agent-host-domain-apply.sh')}}
};

test('whoever sets an agent\'s direct address, the agent ends up reporting what Nginx serves',t=>{
  const ends=[];
  for(const [who,caller] of Object.entries(CALLERS)){
    if(caller.python&&!PYTHON){t.diagnostic(`python3 is not installed: skipping "${who}"`);continue}
    const h=agentOnItsIp(),calls=h.calls().length,seen=[];
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
    // The status file goes when the machine enrolls again; .env alone must say the same.
    h.forgetStatus();
    assert.deepEqual(h.reported(),{mode:'domain',domain:'hk.example.com'},`${who}, from .env alone`);
    // And back to its IP.
    const toIp=caller.ip(h);
    assert.equal(toIp.status,0,`${who}: ${toIp.output}`);
    assert.match(h.site('aegis-relay-agent'),/server_name _;/,who);
    assert.deepEqual(h.env('agent'),{PANEL_URL:'https://panel.example.com',AGENT_DOMAIN:'',AGENT_EMAIL:'ops@example.com',AGENT_VERSION:'0.13.12',AGENT_PROXY_MODE:'ip',AGENT_PROXY_IP:'203.0.113.9'},who);
    const {requestId:second,updatedAt:later,...onIp}=h.status();
    assert.deepEqual(onIp,{state:'active',mode:'ip',desiredDomain:'',currentDomain:'203.0.113.9',message:'已切换为 IP 反代（HTTP）'},who);
    assert.deepEqual(h.reported(),{mode:'ip',domain:'203.0.113.9'},who);
    h.forgetStatus();
    assert.deepEqual(h.reported(),{mode:'ip',domain:'203.0.113.9'},`${who}, from .env alone`);
    seen.push(h.env('agent'),onIp);
    // The status names the panel's request when there was one.
    assert.deepEqual([requestId,second],caller.python?['request-0001','request-0002']:['',''],who);
    // The agent container is left running: nobody watching through this machine loses their stream.
    assert.deepEqual(h.calls().slice(calls).filter(call=>call.startsWith('docker')),[],who);
    ends.push(seen);
  }
  for(const end of ends)assert.deepEqual(end,ends[0],'every caller leaves the same state');
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
  fs.writeFileSync(path.join(marked.dir('agent'),'.env'),'AGENT_DOMAIN=hk.example.com\nAGENT_EMAIL=ops@example.com\nAGENT_PROXY_MODE=ip\nAGENT_PROXY_IP=203.0.113.9\n');
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
  assert.equal(fs.statSync(path.join(h.dir('agent/data'),'host-domain-status.json')).mode&0o777,0o644,'the agent container can read it');
  assert.deepEqual(fs.readdirSync(h.dir('agent/data')),['host-domain-status.json'],'no temporary file is left behind');
});

test('a switch that fails leaves the agent serving on the address it had',t=>{
  for(const [who,caller] of Object.entries(CALLERS)){
    if(caller.python&&!PYTHON){t.diagnostic(`python3 is not installed: skipping "${who}"`);continue}
    // On its IP, asked for a domain whose certificate cannot be issued.
    const h=agentOnItsIp(),ipSite=h.site('aegis-relay-agent'),env=h.env('agent'),calls=h.calls().length;
    process.env.TEST_CERTBOT_FAILS='1';
    const refused=caller.domain(h,'hk.example.com','ops@example.com');
    delete process.env.TEST_CERTBOT_FAILS;
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
    process.env.TEST_NGINX_REJECTS='1';
    const toIp=caller.ip(h),toOther=caller.domain(h,'jp.example.com','ops@example.com');
    delete process.env.TEST_NGINX_REJECTS;
    assert.deepEqual([toIp.status,toOther.status],[1,1],who);
    assert.equal(h.site('aegis-relay-agent'),domainSite,`${who}: the site with its certificate is back`);
    assert.equal(fs.readlinkSync(path.join(h.dir('nginx'),'sites-enabled','default')),'../sites-available/default',`${who}: the default site it moved aside is back`);
    assert.deepEqual(h.since(mark).filter(call=>call.startsWith('certbot ')),[],`${who}: no certificate is asked for a site Nginx refused`);
    assert.deepEqual([h.env('agent'),h.status().state,h.status().currentDomain,h.reported()],[domainEnv,'failed','hk.example.com',{mode:'domain',domain:'hk.example.com'}],who);
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
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter(name=>name.startsWith('aegis-agent-site.')||name.startsWith('aegis-agent-address.')),[],'no temporary file is left behind');
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
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter(name=>name.startsWith('aegis-panel-site.')),[],'no temporary file is left behind');
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
  drifted.forgetStatus();
  assert.deepEqual(drifted.reported(),{mode:'ip',domain:'203.0.113.9'},'before: it reports its IP');
  assert.equal(drifted.upgrade().status,0);
  assert.match(drifted.site('aegis-relay-agent'),/server_name hk\.example\.com;/);
  assert.deepEqual([drifted.reported(),drifted.env('agent').AGENT_PROXY_MODE],[{mode:'domain',domain:'hk.example.com'},'domain']);
  // The other way round: Nginx serves the IP site while .env still names a domain.
  const other=agentOnItsIp();
  fs.writeFileSync(path.join(other.dir('agent'),'.env'),'AGENT_DOMAIN=old.example.com\nAGENT_EMAIL=ops@example.com\n');
  assert.equal(other.upgrade().status,0);
  assert.deepEqual([other.reported(),other.env('agent').AGENT_DOMAIN,other.calls().filter(call=>call.startsWith('certbot ')).length],[{mode:'ip',domain:'203.0.113.9'},'',0]);

  // A failed re-render leaves the machine as it was and tells the upgrade so.
  const live=onDomain.site('aegis-relay-agent'),failed=onDomain.upgrade({TEST_CERTBOT_FAILS:'1'});
  assert.deepEqual([failed.status,onDomain.site('aegis-relay-agent'),onDomain.reported()],[1,live,{mode:'domain',domain:'hk.example.com'}]);
  // A domain site with no certificate email on record cannot be rendered again; nothing is touched.
  const noEmail=host();noEmail.run('agent-configure-domain.sh',['hk.example.com','ops@example.com']);
  fs.writeFileSync(path.join(noEmail.dir('agent'),'.env'),'AGENT_DOMAIN=hk.example.com\n');
  const kept=noEmail.site('aegis-relay-agent'),calls=noEmail.calls().length,refused=noEmail.upgrade();
  assert.deepEqual([refused.status,/没有证书邮箱/.test(refused.output),noEmail.site('aegis-relay-agent'),noEmail.since(calls)],[1,true,kept,[]]);
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
  assert.match(upgrade,/^\. "\$INSTALL_DIR\/host-site\.sh"\nagent_serve_current \|\| case \$\? in\n  3\) echo "若尚未配置直连地址/m);
  assert.ok(upgrade.indexOf('agent_up --force-recreate')<upgrade.indexOf('agent_serve_current'),'the new agent is running before its site is rendered again');
});

test('the aegis-relay-agent command says how it is used instead of guessing',()=>{
  const h=agentOnItsIp(),calls=h.calls().length;
  for(const args of [['domain'],['domain','hk.example.com'],['domain','hk.example.com','ops@example.com','extra'],['nonsense']]){
    const result=h.run('aegis-relay-agent',args);
    assert.deepEqual([result.status,/用法/.test(result.output)],[1,true],args.join(' '));
  }
  assert.equal(h.calls().length,calls,'and touches nothing');
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
  assert.deepEqual(sourcing,['agent-configure-domain.sh','agent-configure-ip.sh','agent-host-domain-apply.sh','configure-domain.sh','configure-entry-domain.sh','configure-local-domain.sh']);
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
