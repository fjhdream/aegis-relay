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
