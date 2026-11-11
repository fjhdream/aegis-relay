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
