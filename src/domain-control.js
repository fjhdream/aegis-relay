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

export function requestDomainSwitch({dir,domain,email,currentDomain='',nowMs=Date.now()}){
  const desiredDomain=normalizeAgentDomain(domain),certificateEmail=String(email||'').trim().toLowerCase();
  if(!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(desiredDomain))throw new Error('代理域名必须是未携带端口或路径的完整 DNS 域名');
  if(!certificateEmail)throw new Error('请先在部署向导保存统一证书邮箱');
  if(!/^[^\s@]+@[^\s@]+$/.test(certificateEmail)||certificateEmail.length>254)throw new Error('证书邮箱格式无效');
  const requestId=randomToken(18),requestedAt=new Date(nowMs).toISOString();
  const request={version:1,requestId,mode:'domain',desiredDomain,certificateEmail,requestedAt};
  const status={requestId,state:'pending',mode:'domain',desiredDomain,currentDomain,message:'等待主机申请证书并切换 Nginx',updatedAt:requestedAt};
  writeJson(path.join(dir,STATUS_FILE),status);
  writeJson(path.join(dir,REQUEST_FILE),request);
  return status;
}

// IP reverse-proxy mode carries no domain or email: the host unit detects the public IP and serves
// plain HTTP.
function requestIpSwitch({dir,currentDomain='',nowMs=Date.now()}){
  const requestId=randomToken(18),requestedAt=new Date(nowMs).toISOString();
  writeJson(path.join(dir,STATUS_FILE),{requestId,state:'pending',mode:'ip',desiredDomain:'',currentDomain,message:'等待主机切换为 IP 反代（HTTP）',updatedAt:requestedAt});
  writeJson(path.join(dir,REQUEST_FILE),{version:1,requestId,mode:'ip',requestedAt});
}

// Where an agent serves right now: what the host last switched it to, else what it was installed with
// (`installed` is {mode,domain,ip} from the install command; mode 'ip' or a missing domain means its
// public IP over plain HTTP). `domain` is the IP in IP mode.
export function servingAddress({dir,installed={}}){
  const status=readDomainStatus(dir),switched=status?.state==='active';
  const mode=switched?status.mode:installed.mode==='ip'?'ip':installed.domain?'domain':installed.ip?'ip':'domain';
  return {mode,domain:switched&&status.currentDomain?status.currentDomain:(mode==='ip'?installed.ip:installed.domain)||''};
}

// A switch the host failed to make is asked for again after this long.
const DOMAIN_RETRY_MS=10*60_000;
// Files a request when the panel wants this agent on another domain, or on its IP, than the one it
// serves on. `desired` is {mode,domain,email} as the panel's check-in answer has it: mode 'ip', or a
// domain with the certificate email; neither means the panel wants nothing changed. One host change at
// a time, and a switch already asked for is left to the host unless it failed long enough ago.
export function followDomain({dir,desired={},installed={},nowMs=Date.now()}){
  const toIp=desired.mode==='ip',domain=toIp?'':String(desired.domain||'');
  if(!toIp&&!domain)return false;
  const serving=servingAddress({dir,installed});
  if(toIp?serving.mode==='ip':serving.mode==='domain'&&serving.domain===domain)return false;
  if(fs.existsSync(path.join(dir,REQUEST_FILE)))return false;
  const status=readDomainStatus(dir);
  if(status&&(toIp?status.mode==='ip':status.mode==='domain'&&status.desiredDomain===domain)){
    if(status.state!=='failed')return false;
    const age=nowMs-Date.parse(status.updatedAt||'');
    if(!Number.isFinite(age)||age<=DOMAIN_RETRY_MS)return false;
  }
  if(toIp){requestIpSwitch({dir,currentDomain:serving.domain,nowMs});return true;}
  // A domain or certificate email the host could not act on is not worth a request.
  try{requestDomainSwitch({dir,domain,email:desired.email,currentDomain:serving.domain,nowMs});return true;}catch{return false;}
}

// A machine that enrolls again starts a new life: what the host did for the previous one must not be
// reported as its own.
export function forgetDomainSwitch(dir){
  for(const file of [STATUS_FILE,REQUEST_FILE])try{fs.rmSync(path.join(dir,file),{force:true})}catch{}
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
