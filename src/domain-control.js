import fs from 'node:fs';
import path from 'node:path';
import { randomToken } from './security.js';
import { writeAtomic } from './store.js';
import { normalizeAgentDomain } from './agent-registry.js';
import { cleanEntryStatus, entryAttempt } from './steering-topology.js';

// Host changes a containerised process cannot make itself (Nginx, certificates): it drops a request
// file into its data directory, and a narrowly scoped host unit, triggered by that exact file, applies
// it and writes back a status file. The panel machine and every agent use the same files; `dir` is the
// data directory they live in.
const REQUEST_FILE='host-domain-request.json';
const STATUS_FILE='host-domain-status.json';

function readJson(file){try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{return null}}
function writeJson(file,value){writeAtomic(file,`${JSON.stringify(value)}\n`)}

export function baseHostname(value){
  if(!value)return'';
  try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&url.pathname==='/'&&!url.search&&!url.hash?url.hostname.toLowerCase():''}catch{return''}
}

export function activeLocalDomain({localProxyBaseUrl='',publicBaseUrl=''}){
  return baseHostname(localProxyBaseUrl)||baseHostname(publicBaseUrl);
}

export function domainRequestRole({panelHostname='',proxyHostname='',requestHostname=''}){
  const panel=String(panelHostname).toLowerCase(),proxy=String(proxyHostname).toLowerCase(),request=String(requestHostname).toLowerCase();
  if(!panel||!proxy||panel===proxy)return'legacy';
  if(request===panel)return'control';
  if(request===proxy)return'proxy';
  return'reject';
}

export function readDomainStatus(dir){
  const value=readJson(path.join(dir,STATUS_FILE));
  if(!value||typeof value!=='object')return null;
  return {
    requestId:String(value.requestId||'').slice(0,80),
    state:['pending','applying','active','failed'].includes(value.state)?value.state:'failed',
    mode:value.mode==='ip'?'ip':'domain',
    desiredDomain:String(value.desiredDomain||'').slice(0,253),
    currentDomain:String(value.currentDomain||'').slice(0,253),
    message:String(value.message||'').slice(0,500),
    updatedAt:String(value.updatedAt||'').slice(0,40)
  };
}

export function requestDomainSwitch({dir,domain,email,currentDomain=''}){
  const desiredDomain=normalizeAgentDomain(domain),certificateEmail=String(email||'').trim().toLowerCase();
  if(!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(desiredDomain))throw new Error('代理域名必须是未携带端口或路径的完整 DNS 域名');
  if(!certificateEmail)throw new Error('请先在部署向导保存统一证书邮箱');
  if(!/^[^\s@]+@[^\s@]+$/.test(certificateEmail)||certificateEmail.length>254)throw new Error('证书邮箱格式无效');
  const requestId=randomToken(18),requestedAt=new Date().toISOString();
  const request={version:1,requestId,mode:'domain',desiredDomain,certificateEmail,requestedAt};
  const status={requestId,state:'pending',mode:'domain',desiredDomain,currentDomain,message:'等待主机申请证书并切换 Nginx',updatedAt:requestedAt};
  writeJson(path.join(dir,STATUS_FILE),status);
  writeJson(path.join(dir,REQUEST_FILE),request);
  return status;
}

// The steering entry domain: same plumbing, its own host unit (host-entry-apply.sh).
const ENTRY_REQUEST_FILE='host-entry-request.json',ENTRY_STATUS_FILE='host-entry-status.json';
export function readEntryStatus(dir){return cleanEntryStatus(readJson(path.join(dir,ENTRY_STATUS_FILE)))}

// Files a request when the entry setup on this host differs from `entry` (or failed and is due for a
// retry). One host change at a time: never next to a pending domain switch.
export function followEntry({dir,entry,nowMs=Date.now()}){
  if(!entry||fs.existsSync(path.join(dir,ENTRY_REQUEST_FILE))||fs.existsSync(path.join(dir,REQUEST_FILE)))return false;
  const attempt=entryAttempt(entry,readEntryStatus(dir),nowMs);
  if(!attempt)return false;
  const requestId=randomToken(18),requestedAt=new Date(nowMs).toISOString();
  writeJson(path.join(dir,ENTRY_STATUS_FILE),{requestId,state:'pending',entryDomain:entry.domain,peers:entry.peers,attempt,message:'等待主机配置入口域名',updatedAt:requestedAt});
  writeJson(path.join(dir,ENTRY_REQUEST_FILE),{version:1,requestId,entryDomain:entry.domain,certificateEmail:entry.email,peers:entry.peers,attempt,requestedAt});
  return true;
}

export const DOMAIN_REQUEST_FILE=REQUEST_FILE;
