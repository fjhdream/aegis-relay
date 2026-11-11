// What the panel shows, worked out from data: the text, the markup, what a form sends. Nothing in here
// touches the page, the network or the clock (the time comes in as an argument), so every function can
// be called with plain data, from the page or from a test. web/app.js is the other half: it fetches,
// calls these, writes what they return into the page and listens for what the person does next.

export const escapeHtml=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function bytes(n=0){const units=['B','KB','MB','GB','TB'];let i=0;n=Number(n)||0;while(n>=1024&&i<units.length-1){n/=1024;i++}return`${n>=10||i===0?n.toFixed(0):n.toFixed(1)} ${units[i]}`}
// The `count` days (UTC) that end with the day of `now`, oldest first, each with its traffic.
export function recentDays(daily,now,count=14){const rows=[];for(let ago=count-1;ago>=0;ago--){const day=new Date(now);day.setUTCHours(0,0,0,0);day.setUTCDate(day.getUTCDate()-ago);const key=day.toISOString().slice(0,10);rows.push({key,label:`${day.getUTCMonth()+1}/${day.getUTCDate()}`,bytes:Number(daily?.[key]||0)})}return rows}

export const TITLES={dashboard:'仪表盘',nodes:'节点管理',agents:'代理机器',steering:'自动切流',traffic:'流量统计',access:'访问监控',diagnostics:'故障诊断',audit:'安全审计',notifications:'通知提醒',account:'个人设置',deployment:'部署向导'};
// One-click client-identity templates for authorized upstreams. Device ID stays untouched so it remains unique per install.
export const UA_PRESETS=[
  {name:'透传（默认）',clear:true},
  {name:'Infuse',userAgent:'Infuse-Direct/8.1.1',client:'Infuse',deviceName:'Infuse'},
  {name:'Emby Web',userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',client:'Emby Web',deviceName:'Chrome'},
  {name:'Emby for Android',userAgent:'Emby/3.4.10 (Android 14; Pixel 8)',client:'Emby for Android',deviceName:'Pixel 8'},
  {name:'Fileball',userAgent:'Fileball/1.5.0',client:'Fileball',deviceName:'Fileball'},
  {name:'SenPlayer',userAgent:'SenPlayer/1.2.0',client:'SenPlayer',deviceName:'SenPlayer'},
  {name:'VidHub',userAgent:'VidHub/1.9 (iOS 17)',client:'VidHub',deviceName:'VidHub'},
];

// The AegisRelay mark: a solid shield with an A cut out of it, drawn on a 24-unit grid in currentColor.
const BRAND_MARK_PATH='M12 2.4 19.6 5.3v6.2c0 4.9-3.2 8.5-7.6 10.3-4.4-1.8-7.6-5.4-7.6-10.3V5.3zM12 8.1 15.9 15.8h-2.3L12 12.5l-1.6 3.3H8.1z';
export const BRAND_MARK=`<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="${BRAND_MARK_PATH}"/></svg>`;
export const DEFAULT_FAVICON='data:image/svg+xml;base64,'+btoa(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#09090b"/><path transform="translate(12.16 12.16) scale(1.653)" fill="#ffffff" fill-rule="evenodd" d="${BRAND_MARK_PATH}"/></svg>`);

// What an operator copies for a client: the node's whole address, and its key when it has one.
// `data` is what the panel answers for a node's credentials; `origin` stands in when it names no public address.
export function credentialText(data,origin){const full=`${String(data.publicBaseUrl||origin).replace(/\/$/,'')}${data.clientPath}`;return data.accessKey?`客户端服务器地址（复制这一整行）\n${full}\n\n地址保护码（已经包含在上面的地址中，无需单独填写）\n${data.accessKey}\n\n在 Emby 客户端添加服务器时，只需粘贴完整服务器地址。`:`客户端服务器地址（复制这一整行）\n${full}\n\n此节点没有启用连接密码，知道地址的人都可以访问。`}
export const ADDR_MASK='••••••••••••••••••';
export const EYE_SVG='<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
// Whether a node answers to a search (already trimmed and lowercased): by name, path or tag.
export function routeMatches(r,q){if(!q)return true;const hay=`${r.name} ${r.alias} ${(r.tags||[]).join(' ')}`.toLowerCase();return hay.includes(q)}

export function qrSvg(qr){
  const quiet=4,scale=5,dim=(qr.size+quiet*2)*scale;
  let path='';
  qr.rows.forEach((row,y)=>{[...row].forEach((bit,x)=>{if(bit==='1')path+=`M${(x+quiet)*scale} ${(y+quiet)*scale}h${scale}v${scale}h-${scale}z`})});
  return `<svg viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}" role="img" aria-label="两步验证二维码"><rect width="${dim}" height="${dim}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

// ---------------------------------------------------------------------------------------------------
// What a function here hands back for the page is a set of changes: for each element (by selector)
// the properties to give it, among html, text, className, value, checked, disabled, placeholder,
// hidden (the `hidden` class) and display (the style). app.js writes them as they are.

// ---------------------------------------------------------------------------------------------------
// Nodes: the list.

// The pills beside a node: running or not, keyed or public, what it does to requests, a warning when
// the dashboard counted more devices on it than its threshold, then its tags.
function statusPills(r,dashboard){const pills=[`<span class="pill ${r.enabled?'on':'off'}">${r.enabled?'运行中':'已停用'}</span>`,`<span class="pill ${r.accessMode==='key'?'lock':'off'}">${r.accessMode==='key'?'密钥':'公开'}</span>`];if(r.clientProfile&&r.clientProfile.enabled)pills.push(`<span class="pill disguise">伪装${r.clientProfile.client?'：'+escapeHtml(r.clientProfile.client):''}</span>`);if(r.streamRewrite&&r.streamRewrite.enabled)pills.push(`<span class="pill split">分离推流</span>`);const dn=dashboard&&dashboard.nodes&&dashboard.nodes.find(n=>n.id===r.id);if(dn&&dn.suspicious)pills.push(`<span class="pill danger" title="30 天内不同设备 ${dn.distinctDevices} 超过阈值（动态 IP 不计入）">⚠ 疑似被分发</span>`);return pills.concat(r.tags.map(t=>`<span class="tag">${escapeHtml(t)}</span>`)).join('')}

// The node list for a search as it was typed. A row cannot be dragged while a search hides others.
export function nodeListView({routes,dashboard,search}){
  const q=String(search||'').trim().toLowerCase(),visible=routes.filter(r=>routeMatches(r,q));
  return {
    '#node-count':{html:routes.length?`共 <b>${routes.length}</b> 个节点${q?` · 匹配 <b>${visible.length}</b>`:''}`:''},
    '#node-rows':{html:visible.map(r=>`<tr data-id="${r.id}">
    <td><div class="cell-name"><span class="drag-handle" title="${q?'搜索时无法拖动排序':'拖动调整顺序'}" ${q?'':'draggable="true"'}><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/></svg></span><button class="star ${r.favorite?'on':''}" title="置顶">${r.favorite?'★':'☆'}</button><div style="min-width:0"><strong>${escapeHtml(r.name)}</strong><span class="node-path">/${escapeHtml(r.alias)}/${r.accessMode==='key'?'••••••/':''}</span></div></div></td>
    <td><div class="cell-addr"><code class="addr-text">${ADDR_MASK}</code><button class="icon-btn addr-reveal" title="显示 / 隐藏完整地址">${EYE_SVG}</button><button class="btn ghost addr-copy">复制</button></div></td>
    <td><div class="cell-pills">${statusPills(r,dashboard)}</div></td>
    <td class="cell-lines"><small class="muted">${r.upstreams.length} 上游${r.streamRewrite&&r.streamRewrite.enabled?' · 分离推流':''}<br>${r.speedLimitMbps?`${r.speedLimitMbps} Mbps`:'不限速'}</small></td>
    <td><div class="row-actions"><button class="btn ghost test-node">测试</button><button class="btn ghost edit-node">编辑</button><button class="btn ghost toggle-node">${r.enabled?'停用':'启用'}</button><button class="btn ghost rotate-node" ${r.accessMode==='alias_only'?'disabled':''}>密码</button>${r.reminderDays?'<button class="btn ghost reminder-node">已保号</button>':''}<button class="btn ghost danger delete-node">删除</button></div></td>
  </tr>`).join('')},
    '#node-empty':{html:routes.length?(visible.length?'':'<article class="panel empty-state"><h3>没有匹配的节点</h3><p>试着清空搜索条件。</p></article>'):'<article class="panel empty-state"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/></svg><h3>创建第一个 Emby 节点</h3><p>只需填写名称、短路径和上游地址。</p></article>'}
  };
}

// What a connection test found (the panel's diagnostics for the node), for the row's button and the toast.
export function testOutcome(route,d){
  const p=(d.main||[])[0]||{},lat=Number(p.latencyMs);
  return {className:!p.online?'bad':lat<300?'good':lat<800?'warn':'bad',label:p.online?(isFinite(lat)?lat+' ms':'在线'):'失败',failed:!p.online,
    message:p.online?`${route.name} 在线 · ${isFinite(lat)?lat+' ms':'—'} · HTTP ${p.status||'—'}${p.embyVersion?` · Emby ${p.embyVersion}`:''}`:`${route.name} 连接失败${p.error?' · '+p.error:''}`};
}
// A node's whole address for a client, from what the panel answers for its credentials.
export function clientAddress(d,origin){if(!d.available)throw new Error('该节点由旧版本创建，未保存可恢复的地址，请先“更换密码”。');return String(d.publicBaseUrl||origin).replace(/\/$/,'')+d.clientPath}

// Dragging, for the node rows and the machine cards alike: the list with one item moved before or
// after another (null when the item is not in it), and what then has to be saved. Items are numbered
// in tens, so a later single move only has to rewrite the ones that actually moved.
export function moved(list,id,targetId,after){const from=list.findIndex(item=>item.id===id);if(from<0)return null;const next=[...list],[item]=next.splice(from,1);let to=next.findIndex(other=>other.id===targetId);if(to<0)to=next.length-1;next.splice(after?to+1:to,0,item);return next}
export const orderChanges=list=>list.map((item,index)=>({item,order:(index+1)*10})).filter(change=>Number(change.item.sortOrder)!==change.order);

// ---------------------------------------------------------------------------------------------------
// Nodes: the form. One row per control: its id, where its value sits in a node (a dot for one level
// down) and its kind, which says how a node's value is shown in the control and how the control's
// value is sent to the panel. `blank` is what a new node starts with, and `show` how an existing
// node's value is shown, where that is not the kind's own way.
const KINDS={
  text:{blank:'',show:value=>value,send:value=>value},
  // A list typed as text, items parted by `join`; sent as it was typed, the panel splits and checks it.
  list:{blank:'',show:(value,field)=>(value||[]).join(field.join),send:value=>value},
  // A yes/no select.
  choice:{blank:'false',show:value=>String(value),send:value=>value==='true'},
  // A number; an empty control means 0.
  number:{blank:'',show:value=>value,send:value=>Number(value||0)},
  // A checkbox.
  check:{blank:false,show:value=>value===true,send:value=>value}
};
export const ROUTE_FIELDS=[
  {id:'#name',key:'name',kind:'text'},
  {id:'#alias',key:'alias',kind:'text'},
  // The key is never shown back: it is typed only to set one.
  {id:'#access-key',key:'accessKey',kind:'text',show:()=>''},
  {id:'#tags',key:'tags',kind:'list',join:', '},
  {id:'#notes',key:'notes',kind:'text'},
  {id:'#upstreams',key:'upstreams',kind:'list',join:'\n'},
  {id:'#access-mode',key:'accessMode',kind:'text',blank:'key'},
  {id:'#private',key:'allowPrivate',kind:'choice'},
  {id:'#tls',key:'tlsVerify',kind:'choice',blank:'true'},
  {id:'#show-home',key:'showOnHome',kind:'choice'},
  {id:'#favorite',key:'favorite',kind:'choice'},
  {id:'#speed-limit',key:'speedLimitMbps',kind:'number'},
  {id:'#monthly-quota',key:'monthlyQuotaGB',kind:'number'},
  {id:'#reminder-days',key:'reminderDays',kind:'number'},
  {id:'#access-threshold',key:'accessAlertThreshold',kind:'number',show:value=>value||0},
  {id:'#profile-enabled',key:'clientProfile.enabled',kind:'check'},
  {id:'#profile-ua',key:'clientProfile.userAgent',kind:'text'},
  {id:'#profile-client',key:'clientProfile.client',kind:'text'},
  {id:'#profile-device',key:'clientProfile.deviceName',kind:'text'},
  {id:'#profile-device-id',key:'clientProfile.deviceId',kind:'text'},
  {id:'#stream-rewrite-enabled',key:'streamRewrite.enabled',kind:'check'},
  {id:'#stream-rewrite-domains',key:'streamRewrite.domains',kind:'list',join:'\n'},
  {id:'#steer-enabled',key:'autoSteer.enabled',kind:'check'},
  {id:'#steer-min-rate',key:'autoSteer.minRateMbps',kind:'number',show:value=>value||''},
  {id:'#steer-egress',key:'egressAgentId',kind:'text',show:value=>value||''},
  // Line sync is on unless a node says otherwise.
  {id:'#line-sync-enabled',key:'lineSync',kind:'check',blank:true,show:value=>value!==false},
  {id:'#line-sync-upstream',key:'lineSyncUpstream',kind:'check'}
];
// The form's values, by control: text for most, true or false for a checkbox.
export const blankRouteForm=()=>Object.fromEntries(ROUTE_FIELDS.map(field=>[field.id,'blank' in field?field.blank:KINDS[field.kind].blank]));
export const routeToForm=route=>Object.fromEntries(ROUTE_FIELDS.map(field=>[field.id,(field.show||KINDS[field.kind].show)(field.key.split('.').reduce((value,key)=>value?.[key],route),field)]));
// What the form sends: a node as the panel takes it, in the order of the rows above.
export function formToRoute(values){
  const route={};
  for(const field of ROUTE_FIELDS){const keys=field.key.split('.'),last=keys.pop();let at=route;for(const key of keys)at=at[key]||(at[key]={});at[last]=KINDS[field.kind].send(values[field.id])}
  return route;
}
// What saving the form asks of the panel. A new node also says which machine to put it on. An existing
// one keeps its way of access unless the form changed it, and changing it takes a yes first
// (`question`), since every client's address changes with it.
export function routeSave(values,{editing,before,deployTo}){
  const body=formToRoute(values);
  if(!editing)return {create:true,changed:false,question:'',body:{...body,agentId:deployTo}};
  const changed=!!before&&before.accessMode!==body.accessMode;
  if(!changed){delete body.accessMode;delete body.accessKey}
  return {create:false,changed,body,question:changed?(body.accessMode==='key'?'开启连接密码后，客户端地址会变成带密码的新地址，所有现有客户端都需要重新填写。确认继续吗？':'关闭连接密码后，只要知道短路径的人都能访问这个节点，且客户端地址会变短。确认继续吗？'):''};
}
// The form's title and button, and for an existing node what its key field says. (A new node's key
// field keeps the hint the last opened node left there.)
export function routeFormView(route){
  return {'#form-title':{text:route?`编辑 · ${route.name}`:'新增 Emby 节点'},'#access-mode':{disabled:false},
    '#access-key':{disabled:false,...(route?{placeholder:route.accessMode==='key'?'如需更换密码请用列表中的“密码”按钮':'留空则安全随机生成'}:{})},
    '#save-node':{text:route?'保存修改':'创建节点'}};
}

// The client-identity presets as chips, the form values each stands for, and whether the user agent
// in the form is one of them.
export const presetChips=()=>UA_PRESETS.map((p,i)=>`<button type="button" class="preset-chip" data-i="${i}">${escapeHtml(p.name)}</button>`).join('');
export const presetValues=p=>p.clear?{'#profile-enabled':false,'#profile-ua':'','#profile-client':'','#profile-device':''}:{'#profile-enabled':true,'#profile-ua':p.userAgent||'','#profile-client':p.client||'','#profile-device':p.deviceName||''};
export const presetIs=(p,ua)=>!p.clear&&!!ua&&p.userAgent===ua;

// What a client syncs for this node: its lines, each with the node's path (the key stays hidden here).
// `on` and `upstream` are the two line-sync switches as they stand in the form.
export function linePreviewView(route,{on,upstream}){
  const lines=route?route.syncLines||[]:[],path=route?`/${route.alias}${route.accessMode==='alias_only'?'':'/••••••'}`:'';
  return {'#line-sync-options':{hidden:!on},'#line-sync-upstream-hint':{hidden:!upstream},
    '#line-sync-preview':{html:!route?'<small class="line-hint">保存后，按部署这个节点的机器生成线路。</small>':lines.length?`<small class="line-hint">客户端会拿到这 ${lines.length} 条线路：</small>`+lines.map(line=>`<div class="channel-row"><div class="channel-info"><strong>${escapeHtml(line.name)}</strong><div class="chan-url">${escapeHtml(line.base+path)}</div></div></div>`).join(''):'<small class="line-hint">还没有可同步的线路：部署这个节点的机器都还没有对外地址。</small>'}};
}

// The distribution channels of the node in the form. Before the list is asked for: whether there can
// be any (`open`), and what to say when not.
export function channelsGate(route){
  const closed=text=>({'#channels-section':{display:''},'#channels-list':{html:''},'#channels-hint':{text},'#channel-label':{disabled:true},'#add-channel':{disabled:true}});
  if(!route)return {open:false,changes:closed('保存节点后，可在此为不同用户添加分发通道。')};
  if(route.accessMode!=='key')return {open:false,changes:closed('该节点是公开别名模式（无连接密码），无法区分多用户。请在上方“连接密码保护”开启后再来。')};
  return {open:true,changes:{'#channels-section':{display:''},'#channel-label':{disabled:false},'#add-channel':{disabled:false},'#channels-hint':{text:''}}};
}
export function channelRows(d,origin){
  const bu=String(d.publicBaseUrl||origin).replace(/\/$/,'');
  return (d.channels||[]).map(c=>`<div class="channel-row" data-cid="${escapeHtml(c.id)}"><div class="channel-info"><strong>${escapeHtml(c.label||'默认')}</strong>${c.isDefault?' <span class="pill off">默认 / 自己</span>':''}<br><code class="muted chan-url">${escapeHtml(bu+c.clientPath)}</code></div><div class="channel-actions"><button type="button" class="btn ghost copy-chan" data-url="${escapeHtml(bu+c.clientPath)}">复制链接</button>${c.isDefault?'':'<button type="button" class="btn ghost danger del-chan">删除</button>'}</div></div>`).join('');
}

// Machines a node's upstream traffic can leave from: any machine with its own HTTPS domain, and the
// one already chosen whatever it is now.
export const egressOptions=(agents,selected)=>'<option value="">不使用：每台机器自己连上游</option>'+(agents||[]).filter(a=>a.domain&&(a.id==='local'||a.proxyMode!=='ip')||a.id===selected).map(a=>`<option value="${escapeHtml(a.id)}">${escapeHtml(a.name||a.id)}（${escapeHtml(a.domain||'无域名')}）</option>`).join('');
// Where a new node can be put: the panel machine, or one of the others. A single other machine is
// chosen without being asked for (`chosen`).
export const DEPLOY_HERE='<option value="">面板本机（默认）</option>';
export function deployOptions(agents){
  const remote=(agents||[]).filter(a=>a.id&&a.id!=='local');
  return {html:remote.map(a=>`<option value="${escapeHtml(a.id)}">${escapeHtml(a.name||a.id)}${a.domain?' · '+escapeHtml(a.domain):(a.proxyMode==='ip'?' · IP 反代':'')}</option>`).join(''),chosen:remote.length===1?remote[0].id:null};
}

// ---------------------------------------------------------------------------------------------------
// Machines.

// A moment, in the viewer's own language and time zone.
export const localTime=at=>new Date(at).toLocaleString();

// One card per machine: its state, the address it serves on, the nodes it carries (ticked among all
// the nodes there are), and what its last change of address came to. `panelVersion` is what a
// machine's own version is held against.
export function agentsView({agents,routes,panelVersion}){
  const labels={online:'在线',stale:'连接延迟',offline:'失联',revoked:'已撤销'};
  return {'#agent-grid':{html:agents.map(a=>{const change=a.domainChange,working=change&&['pending','applying'].includes(change.state),failed=change?.state==='failed',local=a.transport==='loopback',isIp=a.proxyMode==='ip',inputDomain=working||failed?(change.mode==='ip'?'':change.desiredDomain):(isIp?'':a.domain),targetLabel=change?(change.mode==='ip'?'IP 反代':change.desiredDomain||''):'',status=change?`<div class="node-test show"><span class="${failed?'bad':working?'warn':'good'}">●</span>&nbsp;${escapeHtml(change.message||'')}${targetLabel&&targetLabel!==a.domain?` · 目标 ${escapeHtml(targetLabel)}`:''}</div>`:'';const probeVer=local?panelVersion:(a.agentVersion||''),probeCurrent=!!panelVersion&&probeVer===panelVersion;return`<article class="node-card agent-card" data-id="${escapeHtml(a.id)}" data-status="${escapeHtml(a.status)}"><div class="node-card-head"><span class="drag-handle" title="拖动调整机器顺序" draggable="true"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/></svg></span><div style="min-width:0;flex:1"><h3><input class="agent-name" value="${escapeHtml(a.name||'')}" maxlength="80" title="直接修改名称，点「保存名称与节点」后生效"></h3><span class="node-path">${escapeHtml(a.transport==='loopback'?'本机环回':'安全轮询')}</span></div><span class="pill ${a.inSync?'on':'warn'}">${a.inSync?'配置已同步':'等待同步'}</span>${a.agentVersion&&panelVersion&&a.agentVersion!==panelVersion?`<span class="pill warn" title="该机器仍在运行旧版本代理程序">待升级 ${escapeHtml(a.agentVersion)}</span>`:''}</div><div class="tag-row"><span class="pill ${a.status==='online'?'on':'warn'}">${labels[a.status]||'失联'}</span>${local?'':`<span class="pill ${isIp?'':'info'}">${isIp?'IP 反代':'HTTPS 域名'}</span>`}<span class="pill ${working?'warn':a.applyState==='active'?'info':'warn'}">${working?(change.mode==='ip'?'正在切换 IP 反代':'正在配置域名'):a.applyState==='active'?'代理运行中':a.applyState==='error'?'新配置未生效':'已注册 · 等待配置'}</span></div><div class="node-meta"><div><small>当前生效域名</small><strong>${isIp?('IP 反代'+(a.domain?' · '+escapeHtml(a.domain):'')):escapeHtml(a.domain||'尚未设置')}</strong></div><div><small>已选节点</small><strong>${a.routeIds.length} 个</strong></div><div><small>探针·反代版本</small><strong>${probeVer?`v${escapeHtml(probeVer)}${panelVersion?` <span style="color:var(--${probeCurrent?'green':'amber'})">· ${probeCurrent?'最新':'待升级'}</span>`:''}`:'未知'}</strong></div><div><small>最近回执</small><strong>${a.lastSeen?localTime(a.lastSeen):'尚未连接'}</strong></div></div><div class="agent-editor"><label>代理域名<div class="agent-domain-row"><input class="agent-domain" value="${escapeHtml(inputDomain||'')}" placeholder="${local?'emby.example.com':'留空＝用本机 IP 反代'}" ${working?'disabled':''}><button type="button" class="btn ghost switch-domain" ${working?'disabled':''}>切换代理域名</button></div><small>${local?'只有点「切换代理域名」才会改域名：自动配置 Nginx、申请证书并停用旧代理域名，必须与面板域名不同。本机只做面板管理、不承担反代时留空即可，不用点这个按钮。':'只有点「切换代理域名」才会改域名：填写域名自动申请证书走 HTTPS；留空则以本机公网 IP 明文 HTTP 反代。'}</small></label><details class="agent-routes"><summary>部署节点<span class="routes-count">已选 ${a.routeIds.length} / ${routes.length}</span></summary>${routes.length?`<div class="route-tools"><button type="button" class="route-bulk route-all">全选</button><button type="button" class="route-bulk route-none">全不选</button>${routes.length>8?'<input class="agent-route-search" placeholder="搜索节点">':''}</div>`:''}<div class="agent-route-list">${routes.map(r=>`<label class="${a.routeIds.includes(r.id)?'checked':''}" data-search="${escapeHtml((r.name+' '+r.alias).toLowerCase())}"><input type="checkbox" data-route-id="${r.id}" ${a.routeIds.includes(r.id)?'checked':''}><span><b>${escapeHtml(r.name)}</b><small>/${escapeHtml(r.alias)}/</small></span></label>`).join('')||'<small>请先创建 Emby 节点</small>'}</div></details><div class="node-actions"><button class="btn primary save-agent">保存名称与节点</button>${a.canDelete?'<button class="btn ghost danger delete-agent">从面板删除</button>':''}</div></div>${status||a.error?status||`<div class="node-test show"><span class="bad">●</span>&nbsp;${escapeHtml(a.error)}</div>`:''}${a.agentVersion&&panelVersion&&a.agentVersion!==panelVersion?`<div class="node-test show"><span class="warn">●</span>&nbsp;代理程序 ${escapeHtml(a.agentVersion)} 落后于面板 ${escapeHtml(panelVersion)}，在该机器执行：<code>sudo aegis-relay-agent update</code></div>`:''}</article>`}).join('')||'<article class="panel empty-state"><svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="18" r="2"/><path d="M12 7v4M6.7 16.8l3.8-4M17.3 16.8l-3.8-4"/></svg><h3>添加第一台代理机器</h3><p>生成一次性安装指令，机器注册后会自动出现。</p><button class="btn primary open-agent">添加机器</button></article>'}};
}
// How many of a machine's node boxes are ticked.
export const routesChosen=(chosen,total)=>`已选 ${chosen} / ${total}`;
// What saving a card asks of the panel: the name and the nodes, never the address (a panel machine
// that only manages has no address to send, and the panel would refuse the whole change for it).
export function agentSave(agent,{name,routeIds}){
  const clean=String(name).trim();
  if(!clean)return {error:'机器名称不能为空'};
  return {body:{name:clean,routeIds},message:agent.id==='local'?'代理机器配置已保存':'已保存，正在下发到该机器…',watch:agent.id!=='local'};
}
// What 「切换代理域名」 asks of the panel: the address as typed, where empty means the machine's own IP
// over plain HTTP. Nothing is asked when that is what the machine serves on already.
export function domainSwitch(agent,typed){
  const domain=String(typed).trim(),current=agent.proxyMode==='ip'?'':(agent.domain||'');
  if(domain===current)return {unchanged:true,message:'代理域名没有变化，无需切换'};
  return {unchanged:false,body:{domain},message:domain?'域名切换已提交，正在申请证书':'已提交：切换为 IP 反代（HTTP）'};
}
// After a save: whether some machine that is not known to be gone has yet to apply its configuration.
export const awaitingSync=agents=>agents.some(a=>a.id!=='local'&&a.status!=='offline'&&!a.inSync);
// After a switch of address: whether one is still under way, and what the first that failed says.
export function switchProgress(agents){
  const failed=agents.find(a=>a.domainChange?.state==='failed');
  return {working:agents.some(a=>a.domainChange&&['pending','applying'].includes(a.domainChange.state)),failure:failed?failed.domainChange.message||'切换失败':''};
}

// Adding a machine: the form as it opens, with the nodes it could carry, and the command once made.
export function enrollFormView(routes){
  return {'#agent-name':{value:''},'#agent-domain-new':{value:''},'#agent-command-wrap':{hidden:true},'#agent-enroll-form':{hidden:false},
    '#agent-enroll-routes':{html:routes.map(route=>`<label><input type="checkbox" data-enroll-route="${route.id}"><span><b>${escapeHtml(route.name)}</b><small>/${escapeHtml(route.alias)}/</small></span></label>`).join('')||'<small>暂时不部署节点，注册后仍可选择。</small>'}};
}
export function enrollmentView(result){
  return {'#agent-command':{text:result.command},'#agent-command-expiry':{text:`有效期至 ${new Date(result.expiresAt).toLocaleTimeString()}`},'#agent-enroll-form':{hidden:true},'#agent-command-wrap':{hidden:false}};
}

// ---------------------------------------------------------------------------------------------------
// Automatic steering: the settings, which machines and nodes are ready for it, the command each
// machine's entry domain is set up with, and the live view from the panel's hub.
const STEER_MODES={off:'关闭',shadow:'只测不切',on:'已开启'},STEER_REASONS={explore:'试探另一台',better_line:'切到更快的线路',history:'该网段历史上另一台更快',target_unavailable:'目标机器不可用，切回',landing_timeout:'客户端没有跟随跳转'},STEER_VERDICTS={ok:'正常',starved_down:'到观众的线路慢',starved_up:'源站或转码慢',unknown:'未知'};
export const mbps=bps=>bps?`${(bps*8/1e6).toFixed(1)} Mbps`:'—';
export const clockTime=ms=>ms?new Date(ms).toLocaleTimeString('zh-CN',{hour12:false}):'—';

// The whole page for what the panel answers: the settings as saved, readiness, and the live tables.
// `now` is the moment it is drawn at (what counts as a recent stream request is told against it).
export function steeringView(d,now){
  const changes={};
  const st=d.settings||{},machines=d.machines||[],names=new Map(machines.map(m=>[m.id,m.name]));
  const nameOf=id=>id?escapeHtml(names.get(id)||id):'收到请求的机器';
  Object.assign(changes,{'#steering-mode':{value:st.mode||'off'},'#steering-entry':{value:st.entryDomain||''},'#steering-excluded':{value:(st.excludedClients||[]).join('\n')},'#steering-bounded':{value:(st.boundedClients||[]).join('\n')},'#steering-bound':{value:st.boundMB||64},'#steering-bound-auto':{checked:st.boundAuto===true}});
  changes['#steering-mode-state']={text:STEER_MODES[st.mode]||'关闭',className:`pill ${st.mode==='on'?'on':st.mode==='shadow'?'info':''}`};
  const auto=Object.keys(st.autoExcluded||{});
  changes['#steering-auto-excluded']={text:auto.length?`自动排除（跳转后经常没有到达目标机器）：${auto.join('、')}`:''};
  const rangeOn=Object.keys(st.autoBounded||{}),rangeOff=Object.keys(st.autoUnbounded||{});
  changes['#steering-auto-ranges']={text:[rangeOn.length?`自动加入分段：${rangeOn.join('、')}`:'',rangeOff.length?`历史停用（可清空后重试）：${rangeOff.join('、')}`:''].filter(Boolean).join('；')};
  const ready=machines.filter(m=>!m.issues.length).length,steered=(d.routes||[]).filter(r=>!r.issues.length).length;
  changes['#steering-status']={html:`<article class="deploy-card"><small>可参与切流的机器</small><strong>${ready} / ${machines.length}</strong></article><article class="deploy-card"><small>正在切流的节点</small><strong>${steered}</strong></article><article class="deploy-card"><small>入口域名</small><strong>${escapeHtml(st.entryDomain||'尚未设置')}</strong></article>`};
  changes['#steering-machines']={html:machines.map(m=>`<tr><td><strong>${escapeHtml(m.name)}</strong>${m.local?'<br><small class="muted">面板本机</small>':''}</td><td>${escapeHtml(m.domain||'—')}</td><td>${m.issues.length?m.issues.map(i=>`<span class="pill warn">${escapeHtml(i)}</span>`).join(' '):'<span class="pill on">可参与</span>'}</td><td><label class="switch-row"><input type="checkbox" class="steer-target" data-id="${escapeHtml(m.id)}" ${m.steerTarget?'checked':''}></label></td></tr>`).join('')||'<tr><td colspan="4" class="muted">还没有机器</td></tr>'};
  const commands=d.entryCommands||[];
  const ENTRY_STATES={waiting:['','等待机器执行'],pending:['info','等待主机执行'],applying:['info','正在配置并申请证书'],active:['on','已生效'],failed:['warn','暂未成功，稍后自动重试']};
  const entryState=c=>{const [tone,label]=ENTRY_STATES[c.state]||ENTRY_STATES.waiting;return `<span class="pill ${tone}">${label}${c.state==='failed'&&c.attempt?`（第 ${c.attempt} 次）`:''}</span>${c.message&&c.state!=='active'?`<small class="muted">${escapeHtml(c.message)}</small>`:''}`};
  changes['#steering-commands']={html:commands.length?commands.map(c=>c.auto?`<div><div class="command-row"><strong>${escapeHtml(c.name)}</strong>${entryState(c)}</div><details><summary class="muted">自动配置；也可以手动执行</summary><pre>${escapeHtml(c.command)}</pre><button class="btn ghost copy-steer-command" data-command="${escapeHtml(c.command)}">复制命令</button></details></div>`:`<div><div class="command-row"><strong>${escapeHtml(c.name)}</strong><button class="btn ghost copy-steer-command" data-command="${escapeHtml(c.command)}">复制</button></div><pre>${escapeHtml(c.command)}</pre><small class="muted">这台机器的探针版本较旧，需要手动执行一次；升级后会自动配置。</small></div>`).join(''):`<p class="muted">${st.entryDomain?(d.certificateEmail?'还没有可参与切流的机器。':'请先在「部署向导」保存统一证书邮箱。'):'填写入口域名并保存后，这里会给出每台机器要执行的命令。'}</p>`};
  changes['#steering-routes']={html:(d.routes||[]).map(r=>`<tr><td><strong>${escapeHtml(r.name||r.alias)}</strong><br><small class="muted">/${escapeHtml(r.alias)}/</small></td><td>${r.enabled?'<span class="pill on">开启</span>':'<span class="pill off">关闭</span>'}</td><td>${r.issues.length?r.issues.filter(i=>r.enabled||i!=='未开启自动切流').map(i=>`<span class="pill warn">${escapeHtml(i)}</span>`).join(' ')||'—':`<span class="pill on">${st.mode==='on'?'切流中':st.mode==='shadow'?'只测不切':'总开关关闭'}</span>${(r.entryGaps||[]).length?` <span class="pill warn">${escapeHtml(r.entryGaps.join('、'))} 没有部署该节点，对外仍用直连地址</span>`:''}`}${r.egressAgentId?(r.egressActive?` <span class="pill info">统一出口：${nameOf(r.egressAgentId)}</span>`:(r.egressIssues||[]).map(i=>` <span class="pill danger">统一出口未生效：${escapeHtml(i)}</span>`).join('')):''}</td></tr>`).join('')||'<tr><td colspan="3" class="muted">还没有节点</td></tr>'};
  return {...changes,...steeringLiveView(d,now)};
}
// The live tables alone: what the timer redraws, leaving the settings as someone may be editing them.
export function steeringLiveView(d,now){
  const changes={};
  const names=new Map((d.machines||[]).map(m=>[m.id,m.name])),routeNames=new Map((d.routes||[]).map(r=>[r.id,r.name||r.alias])),live=d.live||{};
  const nameOf=id=>id?escapeHtml(names.get(id)||id):'收到请求的机器';
  const PLAY_STATES={playing:'进度持续推进',paused:'已暂停',seeking:'刚拖动，重新采样',possible_stall:'疑似停滞',collecting:'收集播放进度',stopped:'已结束',unknown:'缺少新进度上报'};
  const ADVICE={would_switch:'建议试切（未执行）',enough:'传输余量充足',low_margin:'传输余量偏低，继续观察',collecting:'等待更多分段',missing_bitrate:'缺少影片码率',stale:'传输样本已过期',inactive:'暂停／已结束',observe:'继续观察'};
  changes['#steering-playback']={html:(live.playback||[]).map(x=>`<tr><td>${escapeHtml(x.client||'—')}<br><code>${escapeHtml(x.session)}</code></td><td>${escapeHtml(routeNames.get(x.routeId)||x.routeId)}</td><td><span class="pill ${x.state==='playing'?'on':x.state==='possible_stall'?'warn':''}">${escapeHtml(PLAY_STATES[x.state]||'未知')}</span></td><td>${clockTime(x.lastProgressAt)}</td><td>${(x.machines||[]).map(m=>`<div><strong>${nameOf(m.id)}</strong> · ${escapeHtml(ADVICE[m.advice]||'继续观察')}<br><small class="muted">传输 ${mbps(m.rateBps)} · 影片 ${mbps(m.bitrate/8)} · 最近 ${Math.min(m.samples,3)} 段${m.margin!==null?` · 码率余量 ${Number(m.margin).toFixed(2)}×`:''}</small></div>`).join('')||'等待完整分段样本'}</td></tr>`).join('')||'<tr><td colspan="5" class="muted">等待新的播放进度或完整分段；已有缓存的播放可能暂时没有新取流请求。</td></tr>'};
  changes['#steering-events']={html:(live.events||[]).map(e=>`<tr><td>${clockTime(e.at)}</td><td>${escapeHtml(routeNames.get(e.routeId)||e.routeId)}</td><td>${nameOf(e.from)} → ${nameOf(e.to)}${e.mode==='shadow'?' <span class="pill info">本应切换</span>':''}</td><td>${escapeHtml(STEER_REASONS[e.reason]||e.reason)}</td><td>${mbps(e.fromRateBps)}${e.toRateBps?` → ${mbps(e.toRateBps)}`:''}</td><td>${escapeHtml(e.client||'—')}</td></tr>`).join('')||'<tr><td colspan="6" class="muted">暂无切流决策</td></tr>'};
  changes['#steering-sessions']={html:(live.sessions||[]).map(x=>`<tr><td><code>${escapeHtml(x.session)}</code><br><small class="muted">最近取流 ${clockTime(x.lastSeen)}</small></td><td>${escapeHtml(routeNames.get(x.routeId)||x.routeId)}</td><td>${nameOf(x.assigned)}</td><td><span class="pill ${now-x.lastSeen<=60000?'on':''}">${now-x.lastSeen<=60000?'近 1 分钟有取流':'近期未取流'}</span></td><td><div class="steer-scores">${Object.entries(x.scores||{}).map(([id,sc])=>sc.verdict==='unknown'?`<span class="pill" title="尚未积累足够的测速样本，分段缓存时也可能出现">${nameOf(id)} · 测速样本不足</span>`:sc.stale?`<span class="pill" title="历史速率 ${mbps(sc.rateBps)} · 采样 ${clockTime(sc.at)}">${nameOf(id)} · 历史测速已过期</span>`:`<span class="pill ${sc.verdict==='ok'?'on':sc.verdict==='starved_down'?'warn':''}" title="采样 ${clockTime(sc.at)}">${nameOf(id)} · ${escapeHtml(STEER_VERDICTS[sc.verdict]||sc.verdict)} · ${mbps(sc.rateBps)}</span>`).join('')||'测速样本不足'}</div></td><td>${escapeHtml(x.client||'—')}</td></tr>`).join('')||'<tr><td colspan="6" class="muted">最近 10 分钟没有取流会话</td></tr>'};
  const fx=live.effects||{},on=fx.on||{},sh=fx.shadow||{},pct=(n,d)=>d?`${Math.round(n*100/d)}%`:'—',gain=g=>g?`${g}×`:'—';
  changes['#steering-effects']={html:`<article class="deploy-card"><small>真实切换（最近 ${on.total||0} 次）</small><strong>${pct(on.better||0,on.total)} 卡顿解除</strong><small>仍卡顿 ${on.worse||0} · 源站慢 ${on.upstream||0} · 没跟随跳转 ${on.notLanded||0} · 未测到 ${on.unmeasured||0} · 中位提速 ${gain(on.medianGain)}</small></article><article class="deploy-card"><small>只测不切：本应切换（最近 ${sh.total||0} 次）</small><strong>${pct(sh.persisted||0,sh.total)} 持续卡顿</strong><small>3 分钟内自行恢复 ${sh.recovered||0} · 未测到 ${sh.unmeasured||0}。持续卡顿占比越高，说明开启切流越有用。</small></article><article class="deploy-card"><small>已积累历史的客户端网段</small><strong>${live.networks||0}</strong><small>按网段记录各机器的表现，用来优先试最可能快的机器</small></article>`};
  changes['#steering-effect-pairs']={html:(on.pairs||[]).map(p=>`<tr><td>${nameOf(p.from)} → ${nameOf(p.to)}</td><td>${p.total}</td><td>${p.better}</td><td>${p.worse}</td><td>${gain(p.medianGain)}</td></tr>`).join('')||'<tr><td colspan="5" class="muted">还没有真实切换</td></tr>'};
  const RANGE_STATES={on:'<span class="pill on">分段中</span>',trial:'<span class="pill info">试探中</span>',off:'<span class="pill off">不分段</span>'};
  changes['#steering-ranges']={html:(live.ranges||[]).map(r=>`<tr><td>${escapeHtml(r.client)}</td><td>${r.continued} 次</td><td>${r.trialContinued} 次</td><td>${RANGE_STATES[r.state]||'—'}</td></tr>`).join('')||'<tr><td colspan="4" class="muted">还没有已确认的分段接续</td></tr>'};
  changes['#steering-clients']={html:(live.clients||[]).map(c=>`<tr><td>${escapeHtml(c.client)}</td><td>${c.total}</td><td>${c.landed}</td><td>${c.autoExcluded?'<span class="pill danger">已自动排除</span>':'<span class="pill on">正常</span>'}</td></tr>`).join('')||'<tr><td colspan="4" class="muted">还没有跳转记录</td></tr>'};
  return changes;
}
// The settings as they stand in the page, and what saving them sends (`extra` for the two buttons that
// also clear what the panel learned by itself). An empty segment size means the usual 64 MB.
export const STEERING_FIELDS=['#steering-mode','#steering-entry','#steering-excluded','#steering-bounded','#steering-bound','#steering-bound-auto'].map(id=>({id}));
export function steeringSave(values,extra={}){
  return {mode:values['#steering-mode'],entryDomain:values['#steering-entry'],excludedClients:values['#steering-excluded'],boundedClients:values['#steering-bounded'],boundMB:Number(values['#steering-bound']||64),boundAuto:values['#steering-bound-auto'],...extra};
}

// Keeping the page up to date. `load` asks the panel once: never a second request while one is out; an
// answer that comes after the person left the page or signed out is dropped; a failure leaves what is
// shown and says so (aloud only when the person asked for the page). `tick` is the timer's turn: it
// loads only while the page is being looked at, and has only the live tables redrawn, so that it never
// replaces settings someone is in the middle of changing. Everything it touches is handed in: `ask`
// fetches, `showAll` draws the whole page and `showLive` the live tables only, `status` writes the
// line under the title.
export const STEERING_REFRESH_MS=5000;
export function steeringRefresher({ask,onPage,signedIn,hidden,showAll,showLive,status,toast,now}){
  let loading=false;
  async function load(liveOnly=false){
    if(loading)return;
    loading=true;
    try{
      const data=await ask();
      if(!onPage()||!signedIn())return;
      if(liveOnly)showLive(data);else showAll(data);
      status(`每 5 秒刷新 · 更新于 ${clockTime(now())}`);
    }catch(e){if(onPage()){status('刷新失败，保留上次结果，稍后重试');if(!liveOnly)toast(e.message,true)}}
    finally{loading=false}
  }
  return {load,tick:()=>{if(onPage()&&!hidden()&&signedIn())return load(true)}};
}

// ---------------------------------------------------------------------------------------------------
// Dashboard, traffic and access: what the panel counted.

// The dashboard for the panel's figures (`data`), the nodes there are, and the moment it is drawn at
// (the chart ends with that day).
export function dashboardView({data,routes,now}){
  const changes={};
  const machines=Array.isArray(data.machines)?data.machines:[],online=machines.filter(machine=>machine.status==='online'&&machine.proxyHealthy).length;
  Object.assign(changes,{'#m-nodes':{text:routes.length},'#m-running':{text:`${data.running} 个运行中`},'#m-traffic':{text:bytes(data.totalBytes)},'#m-month-traffic':{text:`本月 ${bytes(data.monthBytes)}`},'#m-requests':{text:Number(data.totalRequests||0).toLocaleString()},'#m-active':{text:`${data.active||0} 个活动连接`},'#m-agents':{text:`${online} / ${machines.length}`},'#m-agent-state':{text:machines.length?`${machines.length-online} 台需关注`:'暂无代理机器'}});
  const days=recentDays(data.daily,now),max=Math.max(1,...days.map(day=>day.bytes)),today=days.at(-1)?.bytes||0,week=days.slice(-7).reduce((sum,day)=>sum+day.bytes,0),peak=days.reduce((best,day)=>day.bytes>best.bytes?day:best,days[0]);
  changes['#traffic-chart']={html:days.map(day=>{const pct=day.bytes?Math.max(3,day.bytes/max*100):0;return`<div class="traffic-day${day.bytes?'':' empty'}" title="${day.key} · ${bytes(day.bytes)}"><div class="traffic-track"><i style="height:${pct}%"></i>${day.bytes?`<b class="traffic-value" style="bottom:calc(${pct}% + 6px)">${bytes(day.bytes)}</b>`:''}</div><small>${day.label}</small></div>`}).join('')};
  changes['#traffic-insights']={html:`<div><small>今日流量</small><strong>${bytes(today)}</strong></div><div><small>近 7 天</small><strong>${bytes(week)}</strong></div><div><small>单日峰值</small><strong>${bytes(peak?.bytes||0)}</strong><em>${peak?.label||'—'}</em></div><div><small>播放请求</small><strong>${Number(data.playbackRequests||0).toLocaleString()}</strong></div>`};
  const statusLabel={online:'在线',stale:'连接延迟',offline:'失联',revoked:'已撤销'};
  changes['#dashboard-machines']={html:machines.map(machine=>{const t=machine.telemetry,share=data.totalBytes&&t?Math.min(100,t.totalBytes/data.totalBytes*100):0,healthy=machine.status==='online'&&machine.proxyHealthy;return`<div class="machine-tile" data-status="${escapeHtml(machine.status)}"><div class="machine-title"><div><strong><i class="machine-dot ${healthy?'':'off'}"></i>${escapeHtml(machine.name)}</strong><small>${escapeHtml(machine.domain||machine.transport||'尚未设置域名')}</small></div><div class="tag-row"><span class="pill ${healthy?'on':'warn'}">${statusLabel[machine.status]||'未知'}</span><span class="pill ${machine.inSync?'info':'warn'}">${machine.inSync?'已同步':'待同步'}</span></div></div>${t?`<div class="machine-stats"><div><small>累计流量</small><strong>${bytes(t.totalBytes)}</strong></div><div><small>本月流量</small><strong>${bytes(t.monthBytes)}</strong></div><div><small>请求 / 播放</small><strong>${Number(t.totalRequests).toLocaleString()} / ${Number(t.playbackRequests).toLocaleString()}</strong></div><div><small>活动连接</small><strong>${t.active||0}</strong></div></div><div class="machine-share"><i style="width:${share}%"></i></div><small class="machine-report">占全网流量 ${share.toFixed(1)}% · 最近上报 ${machine.lastTelemetryAt?localTime(machine.lastTelemetryAt):'—'}</small>`:'<div class="telemetry-missing">等待该 Agent 升级后上报流量</div>'}</div>`}).join('')||'<div class="empty-state"><p>还没有代理机器</p></div>'};
  const nodeMetrics=new Map((data.nodes||[]).map(x=>[x.id,x]));
  changes['#dashboard-nodes']={html:routes.slice(0,6).map(r=>{const m=nodeMetrics.get(r.id)||{};return`<div class="mini-row"><div><strong><i class="status-dot ${r.enabled?'':'off'}"></i>${escapeHtml(r.name)}</strong><small>/${escapeHtml(r.alias)}/ · 主代理机 ${bytes(m.bytesOut)}</small></div><span class="pill">${m.active||0} 活动</span></div>`}).join('')||'<div class="empty-state"><p>还没有节点</p></div>'};
  return changes;
}
// Traffic per node this month against its quota.
export function trafficView({data,routes}){
  const metrics=new Map(data.nodes.map(x=>[x.id,x]));
  return {'#traffic-table':{html:routes.map(r=>{const m=metrics.get(r.id)||{},quota=m.quotaBytes||0,ratio=quota?Math.min(100,(m.monthBytes||0)/quota*100):0,rcls=ratio>85?'danger':ratio>50?'warn':'';return`<tr><td><strong>${escapeHtml(r.name)}</strong><br><small class="muted">/${escapeHtml(r.alias)}/</small></td><td>${Number(m.requests||0).toLocaleString()}</td><td>${Number(m.playbackRequests||0).toLocaleString()}</td><td>${bytes(m.bytesOut)}</td><td>${bytes(m.monthBytes)} / ${quota?bytes(quota):'不限额'}<div class="progress"><i class="${rcls}" style="width:${ratio}%"></i></div></td><td>${m.speedLimitMbps?`${m.speedLimitMbps} Mbps`:'不限速'}</td><td>${m.errors||0}</td></tr>`}).join('')}};
}
// Who watched what: node › channel › device, for the nodes there still are.
export const ACCESS_LOADING={'#access-list':{html:'<article class="panel empty-state"><h3>正在汇总访问记录…</h3></article>'}};
export const accessFailed=message=>({'#access-list':{html:`<article class="panel empty-state"><h3>加载失败</h3><p>${escapeHtml(message)}</p></article>`}});
export function accessView(d,routes){
  const nodes=(d.nodes||[]).filter(n=>routes.some(r=>r.id===n.id));
  if(!nodes.length)return {'#access-list':{html:'<article class="panel empty-state"><h3>暂无访问记录</h3><p>有人通过反代观看后，这里会按“节点 › 分发通道 › 设备”折叠显示。</p></article>'}};
  const fmt=t=>t?new Date(Number(t)).toLocaleString():'—';
  return {'#access-list':{html:nodes.map(n=>{
    const channels=(n.channels||[]).map(c=>{
      const rows=(c.viewers||[]).map(v=>`<tr><td><code>${escapeHtml(v.ip)}</code></td><td>${escapeHtml(v.deviceName||v.client||'—')}${v.client&&v.deviceName?`<br><small class="muted">${escapeHtml(v.client)}</small>`:''}</td><td><small class="muted">${escapeHtml((v.ua||'').slice(0,50))}</small></td><td>${escapeHtml(v.machine||'—')}</td><td>${v.hits||0}</td><td>${fmt(v.lastSeen)}</td></tr>`).join('');
      return `<details class="chan-detail ${c.suspicious?'suspicious':''}"><summary><span class="chan-name">${escapeHtml(c.label)}</span><span class="pill ${c.suspicious?'warn':'info'}">设备 ${c.distinctDevices}</span><span class="pill off" title="动态 IP 仅供参考">IP ${c.distinctIps}</span>${c.suspicious?'<span class="pill danger">⚠ 疑似转分发</span>':''}</summary>${rows?`<div class="table-wrap"><table><thead><tr><th>IP</th><th>设备 / 客户端</th><th>UA</th><th>机器</th><th>请求</th><th>最近访问</th></tr></thead><tbody>${rows}</tbody></table></div>`:'<p class="muted">该通道暂无观看记录。</p>'}</details>`;
    }).join('');
    return `<details class="panel access-node ${n.suspicious?'suspicious':''}"><summary class="access-node-head"><span class="access-node-name">${escapeHtml(n.name)} <small class="muted">/${escapeHtml(n.alias)}/</small></span><span class="node-status ${n.suspicious?'bad':'ok'}">${n.suspicious?'⚠ 疑似多人共享':'✓ 安全'}</span><span class="pill off">通道 ${(n.channels||[]).length}</span><span class="pill off">设备合计 ${n.distinctDevices}</span></summary><div class="access-node-body">${channels||'<p class="muted">暂无访问记录。</p>'}</div></details>`;
  }).join('')}};
}

// ---------------------------------------------------------------------------------------------------
// The panel's answers, signing in, and the smaller pages.

// What an answer from the panel's API comes to: its data, or what went wrong (`error`). `signedOut`
// says the session is over: any 401 except the one a wrong password gets at /login.
export function readResponse({status,ok,type,body,path}){
  let data={};
  if(String(type||'').includes('application/json')){try{data=body?JSON.parse(body):{}}catch{return {error:'管理接口返回了损坏的数据，请刷新页面后重试'}}}
  else if(status===401&&path!=='/login')return {error:'登录已失效，请重新登录',signedOut:true};
  else if([502,503,504].includes(status))return {error:`管理服务连接中断（HTTP ${status}），容器可能正在重启，请稍后重试并检查服务日志`};
  else return {error:ok?`管理接口返回了网页而不是数据（HTTP ${status}），请刷新页面后重试`:`请求未到达管理接口（HTTP ${status}），请检查 Nginx/CDN 是否允许 /api/ 路径`};
  if(status===401&&path!=='/login')return {error:'登录已失效，请重新登录',signedOut:true};
  if(!ok)return {error:data.error||'请求失败'};
  return {data};
}
// The live feed has dropped and is being asked for again.
export const LIVE_RECONNECTING={'#live-state':{html:'<i></i>重连中'}};
// The live feed arrives in pieces: the data of each whole event in what has been read so far, and the
// unfinished rest to keep for the next piece.
export function feedEvents(buffer){
  const chunks=buffer.split('\n\n'),rest=chunks.pop(),events=[];
  for(const chunk of chunks){const line=chunk.split('\n').find(x=>x.startsWith('data: '));if(line)events.push(line.slice(6))}
  return {events,rest};
}

// What signing in sends: the password and one second factor, never both. With two-step verification
// on, a saved recovery code stands in for the authenticator's code when its field is the one showing.
export const loginRequest=({password,code,recovery,usingRecovery})=>usingRecovery?{password,recovery:String(recovery).trim()}:{password,code};
// Swapping between the two: the field put away is emptied, and the one now showing is to be focused.
export function secondFactorView(toRecovery){
  return {focus:toRecovery?'#recovery':'#code',changes:{'#code-field':{hidden:toRecovery},'#recovery-field':{hidden:!toRecovery},[toRecovery?'#code':'#recovery']:{value:''},'#recovery-toggle':{text:toRecovery?'改用动态验证码':'丢失验证器？使用恢复码'}}};
}

// Something to copy, shown once in the dialog: a node's address by default.
export function secretView(content,{eyebrow='连接信息',title='节点连接信息',description='完整节点地址和连接密码可由管理员随时再次查看。'}={}){
  return {'#modal-eyebrow':{text:eyebrow},'#modal-title':{text:title},'#modal-description':{text:description},'#secret':{text:content},'#modal':{hidden:false}};
}
export const iconStateView=custom=>({'#icon-state':{text:custom?'自定义':'默认',className:`pill ${custom?'on':''}`}});

// Diagnostics: the nodes to choose from, each upstream's standing, and a probe's report.
export const diagnosticOptions=routes=>routes.map(r=>`<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');
export const runtimeView=d=>({'#diag-runtime':{html:d.nodes.flatMap(n=>n.upstreams.map((u,i)=>`<span class="pill ${u.circuitOpen||u.lastError?'warn':'on'}">${escapeHtml(n.alias)} · 线路 ${i+1} · ${u.circuitOpen?'熔断':u.lastError?escapeHtml(u.lastError):'就绪'}</span>`)).join('')}});
export const DIAGNOSTIC_RUNNING={'#diagnostic-result':{html:'<article class="panel empty-state"><h3>正在探测回源…</h3></article>'}};
export function diagnosticView(d){
  const section=(title,list)=>`<article class="panel diag-card"><span class="eyebrow">${title}</span><h3>${escapeHtml(d.node.name)}</h3>${(list||[]).map(x=>{const lat=Number(x.latencyMs),lcls=!x.online?'bad':lat<300?'good':lat<800?'warn':'bad';return`<div class="diag-line"><span>连接状态</span><b class="${x.online?'good':'bad'}">${x.online?'在线':'失败'}</b></div><div class="diag-line"><span>HTTP 状态</span><b>${x.status||'—'}</b></div><div class="diag-line"><span>响应延迟</span><b class="${lcls}">${isFinite(lat)?lat+' ms':x.latencyMs}</b></div><div class="diag-line"><span>Emby 版本</span><b>${escapeHtml(x.embyVersion||'—')}</b></div>${x.tls?`<div class="diag-line"><span>TLS</span><b class="${x.tls.authorized?'good':'warn'}">${x.tls.authorized?'有效':'未验证'}</b></div><div class="diag-line"><span>证书到期</span><b>${escapeHtml(x.tls.validTo||'—')}</b></div>`:''}${x.error?`<div class="diag-line"><span>错误</span><b class="bad">${escapeHtml(x.error)}</b></div>`:''}`}).join('')}</article>`;
  return {'#diagnostic-result':{html:section('主回源',d.main)+(d.stream?section('推流域名',d.stream):'')+`<article class="panel diag-card"><span class="eyebrow">请求头</span><h3>请求头策略</h3>${Object.entries(d.headerPreview).map(([k,v])=>`<div class="diag-line"><span>${escapeHtml(k)}</span><b>${escapeHtml(v)}</b></div>`).join('')}</article>`}};
}
export const auditView=d=>({'#audit-list':{html:d.audit.map(x=>`<div class="event"><time>${localTime(x.at)}</time><strong>${escapeHtml(x.action)}</strong><div><span>${escapeHtml(x.ip)}</span><br>${escapeHtml(x.detail)}</div></div>`).join('')||'<div class="empty-state"><p>暂无审计事件</p></div>'}});

export function deploymentView(d){
  return {'#deployment-status':{html:`<article class="deploy-card"><small>管理面板域名</small><strong>${escapeHtml(d.publicBaseUrl||'尚未设置')}</strong></article><article class="deploy-card"><small>本地代理域名</small><strong>${escapeHtml(d.localProxyBaseUrl||'尚未设置')}</strong></article><article class="deploy-card"><small>域名隔离</small><strong>${d.splitDomains?'已分离':'等待在代理机器中切换'}</strong></article>`},'#certificate-email':{value:d.certificateEmail||''},'#certificate-email-state':{text:d.certificateEmail?'已配置':'未配置',className:`pill ${d.certificateEmail?'on':'warn'}`}};
}
// Telegram: whether it is set up; the token and chat are never shown back.
export const notificationsView=d=>({'#telegram-state':{text:d.telegram.configured?'已配置':'未配置'},'#telegram-enabled':{checked:d.telegram.enabled},'#telegram-chat':{value:''},'#telegram-token':{value:''}});

// The account page: who is signed in, and two-step verification in one of its three stages (off, being
// set up, on). Every password and code field is emptied whenever the page is drawn.
export const totpStageView=stage=>Object.fromEntries(['totp-off','totp-setup','totp-on'].map(id=>[`#${id}`,{hidden:id!==stage}]));
export function accountView(d){
  return {'#account-user':{text:d.username||'admin'},'#totp-state':{text:d.totpEnabled?'已开启':'未开启',className:`pill ${d.totpEnabled?'on':'warn'}`},
    '#totp-hint':{text:d.totpEnabled?`登录时需要输入动态验证码。剩余恢复码 ${d.recoveryRemaining} 个。`:'开启后，登录时除密码外还需要输入动态验证码。'},...totpStageView(d.totpEnabled?'totp-on':'totp-off'),
    ...Object.fromEntries(['#pw-current','#pw-new','#pw-confirm','#totp-password','#totp-code','#totp-off-password','#totp-off-code'].map(id=>[id,{value:''}]))};
}
// A new password is checked here before the panel is asked: long enough, and typed the same twice.
export function passwordChange({current,next,again}){
  if(next.length<14)return {error:'新密码至少 14 位'};
  if(next!==again)return {error:'两次输入的新密码不一致'};
  return {body:{currentPassword:current,newPassword:next}};
}
export const totpSetupView=d=>({'#totp-qr':{html:qrSvg(d.qr)},'#totp-secret':{text:d.secret},...totpStageView('totp-setup')});
export const recoveryCodes=d=>({content:`恢复码（每行一个，只显示这一次）\n${d.recovery.join('\n')}`,options:{eyebrow:'恢复码',title:'两步验证已开启',description:'请立即离线保存这些恢复码；丢失验证器时可用它们登录。'}});

// Import and export: what an import made (the new nodes' addresses, when any were made), and the
// name an export is saved under.
export function importOutcome(d){
  const secrets=d.credentials.map(x=>`${x.alias}\n${x.clientPath}${x.accessKey?`\n${x.accessKey}`:''}`).join('\n\n');
  return {message:`已导入 ${d.imported} 个节点`,secret:secrets?{content:`新生成的节点凭据\n\n${secrets}`,options:{eyebrow:'IMPORT CREDENTIALS',title:'导入节点连接信息',description:'这些节点地址和连接密码可由管理员随时再次查看。'}}:null};
}
export const exportName=now=>`aegis-relay-${new Date(now).toISOString().slice(0,10)}.json`;
