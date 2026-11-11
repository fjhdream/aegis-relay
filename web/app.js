// The page's side of the panel: it fetches, hands the data to view.js, writes what comes back into the
// page and listens for what the person does next. What is shown is decided in view.js.
import {ACCESS_LOADING,ADDR_MASK,BRAND_MARK,DEFAULT_FAVICON,DEPLOY_HERE,ROUTE_FIELDS,STEERING_FIELDS,STEERING_REFRESH_MS,TITLES,UA_PRESETS,accessFailed,accessView,agentSave,agentsView,awaitingSync,blankRouteForm,channelRows,channelsGate,clientAddress,credentialText,dashboardView,deployOptions,domainSwitch,egressOptions,enrollFormView,enrollmentView,escapeHtml,linePreviewView,moved,nodeListView,orderChanges,presetChips,presetIs,presetValues,qrSvg,routeFormView,routeSave,routeToForm,routesChosen,steeringLiveView,steeringRefresher,steeringSave,steeringView,switchProgress,testOutcome,trafficView} from './view.js';
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
// A module has no document.currentScript; its own address says where the panel is served from.
const scriptPath=new URL(import.meta.url).pathname;
const base=scriptPath.endsWith('/app.js')?scriptPath.replace(/\/app\.js$/,'/api'):location.pathname.replace(/\/$/,'')+'/api';
// Theme: apply the saved (or system) preference before first paint of the app shell.
const THEME_KEY='aegis-theme';
(function(){let t;try{t=localStorage.getItem(THEME_KEY)}catch{}if(t!=='dark'&&t!=='light')t=window.matchMedia&&matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';document.documentElement.dataset.theme=t})();
function toggleTheme(){const next=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=next;try{localStorage.setItem(THEME_KEY,next)}catch{}}
const state={csrf:'',routes:[],agents:[],panelVersion:'',dashboard:null,editing:null,page:'dashboard',panelIcon:''};
function showLogin(message='登录已失效，请重新登录'){
  state.csrf='';
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  $('#setup').classList.add('hidden');
  $('#login').classList.remove('hidden');
  $('#gate-msg').textContent=message;
}
async function call(path,options={}){
  options.headers={'content-type':'application/json',...(state.csrf?{'x-csrf-token':state.csrf}:{}),...(options.headers||{})};
  const response=await fetch(base+path,options),type=String(response.headers.get('content-type')||''),raw=await response.text();
  let data={};
  if(type.includes('application/json')){try{data=raw?JSON.parse(raw):{}}catch{throw Error('管理接口返回了损坏的数据，请刷新页面后重试')}}
  else if(response.status===401&&path!=='/login'){showLogin();throw Error('登录已失效，请重新登录')}
  else if([502,503,504].includes(response.status))throw Error(`管理服务连接中断（HTTP ${response.status}），容器可能正在重启，请稍后重试并检查服务日志`);
  else throw Error(response.ok?`管理接口返回了网页而不是数据（HTTP ${response.status}），请刷新页面后重试`:`请求未到达管理接口（HTTP ${response.status}），请检查 Nginx/CDN 是否允许 /api/ 路径`);
  if(response.status===401&&path!=='/login'){showLogin();throw Error('登录已失效，请重新登录')}
  if(!response.ok)throw Error(data.error||'请求失败');
  return data;
}
const value=id=>$(id).value;
// Write what view.js decided: for each element, the properties it names.
function write(changes){for(const [selector,change] of Object.entries(changes)){const el=$(selector);
  if('html' in change)el.innerHTML=change.html;
  if('text' in change)el.textContent=change.text;
  if('className' in change)el.className=change.className;
  if('value' in change)el.value=change.value??'';
  if('checked' in change)el.checked=change.checked;
  if('disabled' in change)el.disabled=change.disabled;
  if('placeholder' in change)el.placeholder=change.placeholder;
  if('hidden' in change)el.classList.toggle('hidden',change.hidden);
  if('display' in change)el.style.display=change.display;
}}
// A form's controls as values by control (true or false for a checkbox), and back.
const readForm=fields=>Object.fromEntries(fields.map(field=>[field.id,$(field.id).type==='checkbox'?$(field.id).checked:$(field.id).value]));
function writeForm(values){for(const [id,v] of Object.entries(values)){if(typeof v==='boolean')$(id).checked=v;else $(id).value=v??''}}
function toast(message,error=false){const el=$('#toast');el.textContent=message;el.classList.remove('hidden');el.classList.toggle('error',error);clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.classList.add('hidden'),3200)}
function showSecret(content,{eyebrow='连接信息',title='节点连接信息',description='完整节点地址和连接密码可由管理员随时再次查看。'}={}){$('#modal-eyebrow').textContent=eyebrow;$('#modal-title').textContent=title;$('#modal-description').textContent=description;$('#secret').textContent=content;$('#modal').classList.remove('hidden')}

function applyPanelIcon(icon){
  state.panelIcon=String(icon||'');
  for(const el of document.querySelectorAll('.brand-mark')){
    if(state.panelIcon){const img=document.createElement('img');img.src=state.panelIcon;img.alt='面板图标';el.classList.add('custom');el.replaceChildren(img)}
    else{el.classList.remove('custom');el.innerHTML=BRAND_MARK}
  }
  let link=document.querySelector('link[rel="icon"]');
  if(!link){link=document.createElement('link');link.rel='icon';document.head.appendChild(link)}
  link.href=state.panelIcon||DEFAULT_FAVICON;
  const iconState=$('#icon-state');if(iconState){iconState.textContent=state.panelIcon?'自定义':'默认';iconState.className=`pill ${state.panelIcon?'on':''}`}
}

async function enterApp(){$('#auth').classList.add('hidden');$('#app').classList.remove('hidden');await refreshAll();streamDashboard()}
async function start(){
  // The icon is public branding: fetch it before login so the auth page and favicon match the panel.
  applyPanelIcon('');call('/branding').then(d=>applyPanelIcon(d.icon||'')).catch(()=>{});
  // Resume a still-valid session (survives refresh) before falling back to the login screen.
  try{const r=await fetch(base+'/session',{headers:{'content-type':'application/json'}});if(r.ok){const d=await r.json();if(d&&d.csrf){state.csrf=d.csrf;await enterApp();return}}}catch{}
  try{const status=await call('/status');$('#auth').classList.remove('hidden');$(status.initialized?'#login':'#setup').classList.remove('hidden')}catch(e){$('#gate-msg').textContent=e.message}
}
$('#setup-btn').onclick=async()=>{try{await call('/setup',{method:'POST',body:JSON.stringify({username:value('#su-user'),password:value('#su-pass'),setupToken:value('#su-token')})});$('#setup').classList.add('hidden');$('#login').classList.remove('hidden');$('#gate-msg').textContent='管理员已创建，请用密码登录；可稍后在“个人设置”开启两步验证。'}catch(e){$('#gate-msg').textContent=e.message}};
// With two-step verification on, a saved recovery code stands in for the TOTP code; each mode sends only its own field.
$('#login-btn').onclick=async()=>{try{const password=value('#password'),body=$('#recovery-field').classList.contains('hidden')?{password,code:value('#code')}:{password,recovery:value('#recovery').trim()};const data=await call('/login',{method:'POST',body:JSON.stringify(body)});state.csrf=data.csrf;await enterApp()}catch(e){$('#gate-msg').textContent=e.message}};
$('#recovery-toggle').onclick=()=>{const recovery=$('#recovery-field').classList.contains('hidden');$('#code-field').classList.toggle('hidden',recovery);$('#recovery-field').classList.toggle('hidden',!recovery);setValue(recovery?'#code':'#recovery','');$('#recovery-toggle').textContent=recovery?'改用动态验证码':'丢失验证器？使用恢复码';$(recovery?'#recovery':'#code').focus()};
$('#logout').onclick=async()=>{try{await call('/logout',{method:'POST',body:'{}'})}finally{location.reload()}};

async function refreshAll(){const [routes,dashboard]=await Promise.all([call('/routes'),call('/dashboard')]);state.routes=routes.routes;state.dashboard=dashboard;renderRoutes();renderDashboard(dashboard);renderTraffic(dashboard);fillDiagnosticNodes()}
function renderDashboard(data){write(dashboardView({data,routes:state.routes,now:Date.now()}))}
function renderPresets(){const host=$('#profile-presets');if(!host)return;host.innerHTML=presetChips();host.querySelectorAll('.preset-chip').forEach(chip=>chip.onclick=()=>applyPreset(UA_PRESETS[+chip.dataset.i]))}
function applyPreset(p){writeForm(presetValues(p));markActivePreset()}
function markActivePreset(){const ua=value('#profile-ua'),host=$('#profile-presets');if(!host)return;host.querySelectorAll('.preset-chip').forEach(chip=>chip.classList.toggle('active',presetIs(UA_PRESETS[+chip.dataset.i],ua)))}
async function testConnection(route,row){const btn=row.querySelector('.test-node');btn.disabled=true;btn.classList.remove('good','warn','bad');btn.textContent='测试中…';try{const found=testOutcome(route,await call(`/diagnostics/${route.id}`));btn.classList.add(found.className);btn.textContent=found.label;toast(found.message,found.failed)}catch(e){btn.classList.add('bad');btn.textContent='失败';toast(e.message,true)}finally{btn.disabled=false}}
function askConnectionKey(){return prompt('输入新的连接密码（8–64 位字母、数字、下划线或连字符）。留空将安全随机生成；点击取消则不更换。','')}
async function viewCredentials(route){try{const data=await call(`/routes/${route.id}/credentials`);if(!data.available){if(!confirm('这个节点由旧版本创建，当时没有保存可恢复的连接密码。是否现在更换密码？更换后旧客户端地址会立即失效。'))return;const custom=askConnectionKey();if(custom===null)return;const rotated=await call(`/routes/${route.id}/rotate-key`,{method:'POST',body:JSON.stringify({accessKey:custom})});showSecret(credentialText(rotated,location.origin));return}showSecret(credentialText(data,location.origin))}catch(e){toast(e.message,true)}}
async function nodeUrl(r){if(r._url)return r._url;r._url=clientAddress(await call(`/routes/${r.id}/credentials`),location.origin);return r._url}
let dragRouteId=null;
async function persistOrder(){
  const updates=orderChanges(state.routes);
  if(!updates.length)return;
  try{
    for(const {item:route,order} of updates){await call(`/routes/${route.id}`,{method:'PATCH',body:JSON.stringify({sortOrder:order})});route.sortOrder=order}
    toast('排序已保存');
  }catch(error){toast(error.message,true);await refreshAll()}
}
function bindRowDrag(row,route){
  const handle=row.querySelector('.drag-handle');
  if(!handle||!handle.getAttribute('draggable'))return;
  handle.addEventListener('dragstart',event=>{dragRouteId=route.id;row.classList.add('dragging');event.dataTransfer.effectAllowed='move';try{event.dataTransfer.setData('text/plain',route.id)}catch{}});
  handle.addEventListener('dragend',()=>{dragRouteId=null;row.classList.remove('dragging');$$('.drop-above,.drop-below').forEach(el=>el.classList.remove('drop-above','drop-below'))});
  row.addEventListener('dragover',event=>{
    if(!dragRouteId||dragRouteId===route.id)return;
    event.preventDefault();event.dataTransfer.dropEffect='move';
    const box=row.getBoundingClientRect(),after=event.clientY>box.top+box.height/2;
    row.classList.toggle('drop-below',after);row.classList.toggle('drop-above',!after);
  });
  row.addEventListener('dragleave',()=>row.classList.remove('drop-above','drop-below'));
  row.addEventListener('drop',event=>{
    if(!dragRouteId||dragRouteId===route.id)return;
    event.preventDefault();
    const box=row.getBoundingClientRect(),after=event.clientY>box.top+box.height/2;
    const next=moved(state.routes,dragRouteId,route.id,after);
    if(!next)return;
    state.routes=next;
    dragRouteId=null;
    renderRoutes();
    persistOrder();
  });
}
function renderRoutes(){
  write(nodeListView({routes:state.routes,dashboard:state.dashboard,search:($('#node-search')||{}).value}));
  const body=$('#node-rows');
  body.querySelectorAll('tr').forEach(row=>{const r=state.routes.find(x=>x.id===row.dataset.id);if(!r)return;
    bindRowDrag(row,r);row.querySelector('.test-node').onclick=()=>testConnection(r,row);
    row.querySelector('.addr-copy').onclick=async()=>{try{await navigator.clipboard.writeText(await nodeUrl(r));toast('客户端地址已复制')}catch(e){toast(e.message,true)}};
    row.querySelector('.addr-reveal').onclick=async()=>{const el=row.querySelector('.addr-text'),wrap=row.querySelector('.cell-addr');if(el.dataset.shown){el.textContent=ADDR_MASK;el.dataset.shown='';wrap.classList.remove('shown')}else{el.textContent='加载中…';try{el.textContent=await nodeUrl(r);el.dataset.shown='1';wrap.classList.add('shown')}catch(e){el.textContent=ADDR_MASK;toast(e.message,true)}}};
    row.querySelector('.toggle-node').onclick=()=>patchRoute(r,{enabled:!r.enabled});
    row.querySelector('.star').onclick=()=>patchRoute(r,{favorite:!r.favorite});
    row.querySelector('.edit-node').onclick=()=>openDrawer(r);
    row.querySelector('.rotate-node').onclick=async()=>{if(!confirm('更换连接密码后，所有使用旧地址的客户端会立即失效。确认继续吗？'))return;const custom=askConnectionKey();if(custom===null)return;try{const x=await call(`/routes/${r.id}/rotate-key`,{method:'POST',body:JSON.stringify({accessKey:custom})});r._url=null;showSecret(credentialText(x,location.origin))}catch(e){toast(e.message,true)}};
    const reminder=row.querySelector('.reminder-node');if(reminder)reminder.onclick=async()=>{await call(`/routes/${r.id}/reminder-complete`,{method:'POST',body:'{}'});toast('维护提醒周期已重新开始');await refreshAll()};
    row.querySelector('.delete-node').onclick=async()=>{if(confirm(`确认删除“${r.name}”？`)){await call(`/routes/${r.id}`,{method:'DELETE'});toast('节点已删除');await refreshAll()}};
  });
}
async function patchRoute(route,data){try{await call(`/routes/${route.id}`,{method:'PATCH',body:JSON.stringify(data)});await refreshAll()}catch(e){toast(e.message,true)}}

function renderTraffic(data){write(trafficView({data,routes:state.routes}))}

function fillDiagnosticNodes(){const select=$('#diag-node'),current=select.value;select.innerHTML=state.routes.map(r=>`<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');if(state.routes.some(r=>r.id===current))select.value=current}
async function loadRuntime(){const d=await call('/diagnostics');$('#diag-runtime').innerHTML=d.nodes.flatMap(n=>n.upstreams.map((u,i)=>`<span class="pill ${u.circuitOpen||u.lastError?'warn':'on'}">${escapeHtml(n.alias)} · 线路 ${i+1} · ${u.circuitOpen?'熔断':u.lastError?escapeHtml(u.lastError):'就绪'}</span>`)).join('')}
$('#refresh-access').onclick=loadAccess;
$('#add-channel').onclick=async()=>{if(!state.editing)return toast('请先保存节点，再添加分发通道',true);const route=state.routes.find(r=>r.id===state.editing);if(!route)return;try{await call(`/routes/${route.id}/channels`,{method:'POST',body:JSON.stringify({label:value('#channel-label').trim()})});setValue('#channel-label','');await renderChannels(route);toast('分发通道已添加')}catch(e){toast(e.message,true)}};
$('#run-diagnostic').onclick=async()=>{const id=value('#diag-node');if(!id)return toast('请先创建节点',true);$('#diagnostic-result').innerHTML='<article class="panel empty-state"><h3>正在探测回源…</h3></article>';try{const d=await call(`/diagnostics/${id}`);const section=(title,list)=>`<article class="panel diag-card"><span class="eyebrow">${title}</span><h3>${escapeHtml(d.node.name)}</h3>${(list||[]).map(x=>{const lat=Number(x.latencyMs),lcls=!x.online?'bad':lat<300?'good':lat<800?'warn':'bad';return`<div class="diag-line"><span>连接状态</span><b class="${x.online?'good':'bad'}">${x.online?'在线':'失败'}</b></div><div class="diag-line"><span>HTTP 状态</span><b>${x.status||'—'}</b></div><div class="diag-line"><span>响应延迟</span><b class="${lcls}">${isFinite(lat)?lat+' ms':x.latencyMs}</b></div><div class="diag-line"><span>Emby 版本</span><b>${escapeHtml(x.embyVersion||'—')}</b></div>${x.tls?`<div class="diag-line"><span>TLS</span><b class="${x.tls.authorized?'good':'warn'}">${x.tls.authorized?'有效':'未验证'}</b></div><div class="diag-line"><span>证书到期</span><b>${escapeHtml(x.tls.validTo||'—')}</b></div>`:''}${x.error?`<div class="diag-line"><span>错误</span><b class="bad">${escapeHtml(x.error)}</b></div>`:''}`}).join('')}</article>`;$('#diagnostic-result').innerHTML=section('主回源',d.main)+(d.stream?section('推流域名',d.stream):'')+`<article class="panel diag-card"><span class="eyebrow">请求头</span><h3>请求头策略</h3>${Object.entries(d.headerPreview).map(([k,v])=>`<div class="diag-line"><span>${escapeHtml(k)}</span><b>${escapeHtml(v)}</b></div>`).join('')}</article>`;await loadRuntime()}catch(e){toast(e.message,true)}};

async function loadAudit(){const d=await call('/audit');$('#audit-list').innerHTML=d.audit.map(x=>`<div class="event"><time>${new Date(x.at).toLocaleString()}</time><strong>${escapeHtml(x.action)}</strong><div><span>${escapeHtml(x.ip)}</span><br>${escapeHtml(x.detail)}</div></div>`).join('')||'<div class="empty-state"><p>暂无审计事件</p></div>'}
// Renumber with gaps so a later single move only has to rewrite the machines that actually moved.
async function persistAgentOrder(){
  const updates=orderChanges(state.agents);
  if(!updates.length)return;
  try{for(const {item:agent,order} of updates){await call(`/agents/${agent.id}`,{method:'PATCH',body:JSON.stringify({sortOrder:order})});agent.sortOrder=order}toast('排序已保存')}
  catch(error){toast(error.message,true);await loadAgents()}
}
async function loadAgents(){
  const d=await call('/agents');state.agents=d.agents||[];state.panelVersion=d.panelVersion||"";
  renderAgents();
}
let dragAgentId=null;
// Card drag mirrors the node table's row drag; cards sit in a grid, so left/right halves decide the
// drop side instead of top/bottom.
function bindAgentDrag(card,agent){
  const handle=card.querySelector('.drag-handle');
  if(!handle||!handle.getAttribute('draggable'))return;
  const side=event=>{const box=card.getBoundingClientRect();return event.clientX>box.left+box.width/2};
  handle.addEventListener('dragstart',event=>{dragAgentId=agent.id;card.classList.add('dragging');event.dataTransfer.effectAllowed='move';try{event.dataTransfer.setData('text/plain',agent.id)}catch{}});
  handle.addEventListener('dragend',()=>{dragAgentId=null;card.classList.remove('dragging');$$('.agent-card').forEach(el=>el.classList.remove('drop-above','drop-below'))});
  card.addEventListener('dragover',event=>{
    if(!dragAgentId||dragAgentId===agent.id)return;
    event.preventDefault();event.dataTransfer.dropEffect='move';
    const after=side(event);card.classList.toggle('drop-below',after);card.classList.toggle('drop-above',!after);
  });
  card.addEventListener('dragleave',()=>card.classList.remove('drop-above','drop-below'));
  card.addEventListener('drop',event=>{
    if(!dragAgentId||dragAgentId===agent.id)return;
    event.preventDefault();
    const next=moved(state.agents,dragAgentId,agent.id,side(event));
    if(!next)return;
    state.agents=next;
    dragAgentId=null;renderAgents();persistAgentOrder();
  });
}
function renderAgents(){
  write(agentsView({agents:state.agents,routes:state.routes,panelVersion:state.panelVersion}));
  $('#agent-grid').querySelectorAll('.agent-card').forEach(card=>{const agent=state.agents.find(item=>item.id===card.dataset.id);const search=card.querySelector('.agent-route-search');if(search)search.oninput=()=>{const q=search.value.trim().toLowerCase();card.querySelectorAll('.agent-route-list label').forEach(l=>{l.style.display=!q||(l.dataset.search||'').includes(q)?'':'none'})};const counter=card.querySelector('.routes-count'),syncRoutes=()=>{card.querySelectorAll('[data-route-id]').forEach(b=>b.closest('label').classList.toggle('checked',b.checked));if(counter)counter.textContent=routesChosen(card.querySelectorAll('[data-route-id]:checked').length,state.routes.length)};card.querySelectorAll('[data-route-id]').forEach(box=>box.addEventListener('change',syncRoutes));const allBtn=card.querySelector('.route-all'),noneBtn=card.querySelector('.route-none');if(allBtn)allBtn.onclick=()=>{card.querySelectorAll('[data-route-id]').forEach(b=>b.checked=true);syncRoutes()};if(noneBtn)noneBtn.onclick=()=>{card.querySelectorAll('[data-route-id]').forEach(b=>b.checked=false);syncRoutes()};// Deploying nodes and switching the proxy domain are two unrelated operations and must stay on two
// buttons. Sending them together made a management-only panel machine impossible to configure: its
// proxy domain field is empty (or equals the panel domain), the server rejects that with 400/409,
// and the node selection in the same request was thrown away — so its nodes could never be turned
// off. This handler deliberately omits `domain` so the domain validation is never reached.
card.querySelector('.save-agent').onclick=async()=>{try{const save=agentSave(agent,{name:card.querySelector('.agent-name').value,routeIds:[...card.querySelectorAll('[data-route-id]:checked')].map(input=>input.dataset.routeId)});if(save.error)return toast(save.error,true);await call(`/agents/${agent.id}`,{method:'PATCH',body:JSON.stringify(save.body)});toast(save.message);await refreshAll();await loadAgents();if(save.watch)watchAgentSync()}catch(e){toast(e.message,true)}};
const switchDomain=card.querySelector('.switch-domain');if(switchDomain)switchDomain.onclick=async()=>{try{const asked=domainSwitch(agent,card.querySelector('.agent-domain').value);if(asked.unchanged)return toast(asked.message);await call(`/agents/${agent.id}`,{method:'PATCH',body:JSON.stringify(asked.body)});toast(asked.message);await refreshAll();await loadAgents();watchDomainSwitch()}catch(e){toast(e.message,true)}};
bindAgentDrag(card,agent);const remove=card.querySelector('.delete-agent');if(remove)remove.onclick=async()=>{if(!confirm(`确认从面板删除“${agent.name}”？请先在对应机器执行卸载。`))return;try{await call(`/agents/${agent.id}`,{method:'DELETE'});toast('代理机器已从面板删除');await loadAgents()}catch(e){toast(e.message,true)}}});
  $$('.open-agent').forEach(button=>button.onclick=openAgentModal);
}
// A node selection is pushed to a remote machine on its next heartbeat, so the card is briefly
// 「等待同步」 after saving. Poll until the machine has actually applied it instead of leaving a
// stale card that makes a working change look like it did nothing.
let syncWatchTimer=null,syncWatchUntil=0;
function watchAgentSync(){
  clearTimeout(syncWatchTimer);
  if(!syncWatchUntil)syncWatchUntil=Date.now()+60000;
  syncWatchTimer=setTimeout(async()=>{
    try{
      await loadAgents();
      const pending=awaitingSync(state.agents);
      if(pending&&Date.now()<syncWatchUntil){watchAgentSync();return}
      syncWatchUntil=0;
      if(!pending)await refreshAll();
    }catch{if(Date.now()<syncWatchUntil)watchAgentSync();else syncWatchUntil=0}
  },3000);
}
let domainWatchTimer=null;
function watchDomainSwitch(){clearTimeout(domainWatchTimer);domainWatchTimer=setTimeout(async()=>{try{await loadAgents();const progress=switchProgress(state.agents);if(progress.working){watchDomainSwitch();return}if(progress.failure){toast(progress.failure,true);return}await refreshAll()}catch{watchDomainSwitch()}},4000)}
async function loadDeployment(){const d=await call('/deployment');$('#deployment-status').innerHTML=`<article class="deploy-card"><small>管理面板域名</small><strong>${escapeHtml(d.publicBaseUrl||'尚未设置')}</strong></article><article class="deploy-card"><small>本地代理域名</small><strong>${escapeHtml(d.localProxyBaseUrl||'尚未设置')}</strong></article><article class="deploy-card"><small>域名隔离</small><strong>${d.splitDomains?'已分离':'等待在代理机器中切换'}</strong></article>`;setValue('#certificate-email',d.certificateEmail||'');$('#certificate-email-state').textContent=d.certificateEmail?'已配置':'未配置';$('#certificate-email-state').className=`pill ${d.certificateEmail?'on':'warn'}`;return d}
async function loadNotifications(){const d=await call('/notifications');$('#telegram-state').textContent=d.telegram.configured?'已配置':'未配置';$('#telegram-enabled').checked=d.telegram.enabled;setValue('#telegram-chat','');setValue('#telegram-token','')}


function showTotpStage(stage){for(const id of ['#totp-off','#totp-setup','#totp-on'])$(id).classList.toggle('hidden',id!=='#'+stage)}
async function loadAccount(){
  const d=await call('/account');
  $('#account-user').textContent=d.username||'admin';
  $('#totp-state').textContent=d.totpEnabled?'已开启':'未开启';
  $('#totp-state').className=`pill ${d.totpEnabled?'on':'warn'}`;
  $('#totp-hint').textContent=d.totpEnabled?`登录时需要输入动态验证码。剩余恢复码 ${d.recoveryRemaining} 个。`:'开启后，登录时除密码外还需要输入动态验证码。';
  showTotpStage(d.totpEnabled?'totp-on':'totp-off');
  for(const id of ['#pw-current','#pw-new','#pw-confirm','#totp-password','#totp-code','#totp-off-password','#totp-off-code'])setValue(id,'');
}
$('#save-password').onclick=async()=>{
  if(value('#pw-new').length<14)return toast('新密码至少 14 位',true);
  if(value('#pw-new')!==value('#pw-confirm'))return toast('两次输入的新密码不一致',true);
  try{await call('/account/password',{method:'POST',body:JSON.stringify({currentPassword:value('#pw-current'),newPassword:value('#pw-new')})});toast('密码已更新');await loadAccount()}catch(e){toast(e.message,true)}
};
$('#totp-begin').onclick=async()=>{
  try{
    const d=await call('/account/totp/begin',{method:'POST',body:JSON.stringify({password:value('#totp-password')})});
    $('#totp-qr').innerHTML=qrSvg(d.qr);$('#totp-secret').textContent=d.secret;
    showTotpStage('totp-setup');setTimeout(()=>$('#totp-code').focus(),0);
  }catch(e){toast(e.message,true)}
};
$('#totp-cancel').onclick=()=>showTotpStage('totp-off');
$('#totp-confirm').onclick=async()=>{
  try{
    const d=await call('/account/totp/enable',{method:'POST',body:JSON.stringify({code:value('#totp-code')})});
    await loadAccount();
    showSecret(`恢复码（每行一个，只显示这一次）\n${d.recovery.join('\n')}`,{eyebrow:'恢复码',title:'两步验证已开启',description:'请立即离线保存这些恢复码；丢失验证器时可用它们登录。'});
  }catch(e){toast(e.message,true)}
};
$('#totp-disable').onclick=async()=>{
  if(!confirm('关闭两步验证后，登录将只需要密码。确认继续吗？'))return;
  try{await call('/account/totp/disable',{method:'POST',body:JSON.stringify({password:value('#totp-off-password'),code:value('#totp-off-code')})});toast('两步验证已关闭');await loadAccount()}catch(e){toast(e.message,true)}
};
async function savePanelIcon(payload){const d=await call('/account/icon',{method:'PUT',body:JSON.stringify(payload)});applyPanelIcon(d.icon||'');return d}
$('#icon-upload').onclick=()=>$('#icon-file').click();
$('#icon-file').onchange=()=>{
  const file=$('#icon-file').files[0];
  if(!file)return;
  if(file.size>256*1024){toast('图标不能超过 256KB',true);$('#icon-file').value='';return}
  const reader=new FileReader();
  reader.onerror=()=>{toast('读取文件失败',true);$('#icon-file').value=''};
  reader.onload=async()=>{try{await savePanelIcon({icon:reader.result});toast('面板图标已更新')}catch(e){toast(e.message,true)}finally{$('#icon-file').value=''}};
  reader.readAsDataURL(file);
};
$('#icon-apply-url').onclick=async()=>{
  const url=value('#icon-url').trim();
  if(!url)return toast('请输入图片地址',true);
  const btn=$('#icon-apply-url');btn.disabled=true;btn.textContent='拉取中…';
  try{await savePanelIcon({url});setValue('#icon-url','');toast('面板图标已更新')}catch(e){toast(e.message,true)}finally{btn.disabled=false;btn.textContent='拉取并使用'}
};
$('#icon-reset').onclick=async()=>{try{await savePanelIcon({icon:''});toast('已恢复默认图标')}catch(e){toast(e.message,true)}};
async function switchPage(page){state.page=page;$$('.page').forEach(x=>x.classList.add('hidden'));$(`#${page}-page`).classList.remove('hidden');$$('[data-page]').forEach(x=>x.classList.toggle('active',x.dataset.page===page));$('#page-title').textContent=TITLES[page];$('#global-add').style.display=page==='dashboard'?'':'none';closeMenu();if(page==='audit')await loadAudit();if(page==='agents')await loadAgents();if(page==='steering')await loadSteering();if(page==='deployment')await loadDeployment();if(page==='notifications')await loadNotifications();if(page==='account')await loadAccount();if(page==='diagnostics')await loadRuntime();if(page==='access')await loadAccess()}
async function loadAccess(){write(ACCESS_LOADING);try{write(accessView(await call('/access'),state.routes))}catch(e){write(accessFailed(e.message))}}
async function renderChannels(route){const gate=channelsGate(route),list=$('#channels-list');write(gate.changes);if(!gate.open)return;
  try{list.innerHTML=channelRows(await call(`/routes/${route.id}/channels`),location.origin);
    list.querySelectorAll('.copy-chan').forEach(b=>b.onclick=async()=>{try{await navigator.clipboard.writeText(b.dataset.url);toast('专属链接已复制')}catch(e){toast(e.message,true)}});
    list.querySelectorAll('.del-chan').forEach(b=>b.onclick=async()=>{const cid=b.closest('.channel-row').dataset.cid;if(!confirm('删除该通道后，用这把密码的用户会立即无法访问（不影响其他人）。确认删除？'))return;try{await call(`/routes/${route.id}/channels/${cid}`,{method:'DELETE'});await renderChannels(route);toast('通道已删除')}catch(e){toast(e.message,true)}});
  }catch(e){write({'#channels-list':{html:''},'#channels-hint':{text:e.message}})}}
function closeMenu(){$('#mobile-menu').classList.add('hidden')}
$('#theme-toggle').onclick=toggleTheme;
$('#nav-toggle').onclick=()=>$('#mobile-menu').classList.toggle('hidden');
$('#mobile-menu').onclick=e=>{if(e.target.id==='mobile-menu')closeMenu()};
$('#nav-logout').onclick=()=>$('#logout').onclick();
$$('[data-page]').forEach(b=>b.onclick=()=>switchPage(b.dataset.page));$$('[data-jump]').forEach(b=>b.onclick=()=>switchPage(b.dataset.jump));

function setValue(id,v){$(id).value=v??''}
// Machines a node's upstream traffic can leave from: any machine with its own HTTPS domain.
function fillEgressOptions(selected){if(!(state.agents||[]).length){call('/agents').then(d=>{if((d.agents||[]).length){state.agents=d.agents;fillEgressOptions(selected)}}).catch(()=>{})}const select=$('#steer-egress');select.innerHTML=egressOptions(state.agents,selected);select.value=selected||''}
function resetDrawer(){state.editing=null;writeForm(blankRouteForm());write(routeFormView(null));fillEgressOptions('');renderLinePreview(null);renderPresets();markActivePreset();renderChannels(null)}
function openDrawer(route=null){resetDrawer();if(route){state.editing=route.id;writeForm(routeToForm(route));write(routeFormView(route));fillEgressOptions(route.egressAgentId||'');renderLinePreview(route);renderChannels(route)}const _deployField=$('#deploy-agent-field');if(route){if(_deployField)_deployField.classList.add('hidden')}else if(_deployField){_deployField.classList.remove('hidden');populateDeployAgents()}markActivePreset();$('#drawer-backdrop').classList.remove('hidden');$('#node-drawer').classList.remove('hidden')}
async function populateDeployAgents(){const sel=$('#deploy-agent');if(!sel)return;sel.innerHTML=DEPLOY_HERE;try{const options=deployOptions((await call('/agents')).agents);sel.insertAdjacentHTML('beforeend',options.html);if(options.chosen)sel.value=options.chosen}catch{}}
function closeDrawer(){$('#drawer-backdrop').classList.add('hidden');$('#node-drawer').classList.add('hidden')}

// The lines a client syncs for the node in the form, as the two line-sync switches stand.
function renderLinePreview(route){write(linePreviewView(route,{on:$('#line-sync-enabled').checked,upstream:$('#line-sync-upstream').checked}))}
$('#line-sync-enabled').onchange=()=>$('#line-sync-options').classList.toggle('hidden',!$('#line-sync-enabled').checked);
$('#line-sync-upstream').onchange=()=>$('#line-sync-upstream-hint').classList.toggle('hidden',!$('#line-sync-upstream').checked);
$('#access-mode').onchange=()=>{$('#access-key').disabled=value('#access-mode')==='alias_only';if($('#access-key').disabled)setValue('#access-key','')};
$('#save-node').onclick=async()=>{try{const save=routeSave(readForm(ROUTE_FIELDS),{editing:!!state.editing,before:state.routes.find(x=>x.id===state.editing),deployTo:value('#deploy-agent')});if(save.question&&!confirm(save.question))return;if(!save.create){const updated=await call(`/routes/${state.editing}`,{method:'PATCH',body:JSON.stringify(save.body)});const target=state.routes.find(x=>x.id===state.editing);if(target)target._url=null;if(save.changed&&updated.clientPath){closeDrawer();await refreshAll();showSecret(credentialText(updated,location.origin),{title:'客户端地址已更新',description:'连接密码设置已更改，请把下面的新地址同步到所有客户端。'});return}toast('节点已更新')}else{const x=await call('/routes',{method:'POST',body:JSON.stringify(save.body)});showSecret(credentialText(x,location.origin))}closeDrawer();await refreshAll()}catch(e){toast(e.message,true)}};
$('#profile-ua').oninput=markActivePreset;$('#close-drawer').onclick=closeDrawer;$('#cancel-edit').onclick=closeDrawer;$('#drawer-backdrop').onclick=closeDrawer;$$('.add-node').forEach(b=>b.onclick=()=>openDrawer());$('#global-add').onclick=()=>openDrawer();

async function openAgentModal(){try{write(enrollFormView(state.routes));$('#agent-enroll-routes').onchange=e=>{const box=e.target.closest('[data-enroll-route]');if(box)box.closest('label').classList.toggle('checked',box.checked)};$('#agent-modal').classList.remove('hidden');setTimeout(()=>$('#agent-name').focus(),0)}catch(e){toast(e.message,true)}}
function closeAgentModal(){$('#agent-modal').classList.add('hidden');$('#agent-command').textContent=''}
$('#add-agent').onclick=openAgentModal;$('#close-agent-modal').onclick=closeAgentModal;
$('#create-enrollment').onclick=async()=>{const button=$('#create-enrollment');try{button.disabled=true;button.textContent='正在生成…';const routeIds=[...$$('[data-enroll-route]:checked')].map(input=>input.dataset.enrollRoute),result=await call('/agents/enrollment',{method:'POST',body:JSON.stringify({name:value('#agent-name'),domain:value('#agent-domain-new'),routeIds})});write(enrollmentView(result))}catch(e){toast(e.message,true)}finally{button.disabled=false;button.textContent='生成一键安装指令'}};
$('#copy-agent-command').onclick=async()=>{await navigator.clipboard.writeText($('#agent-command').textContent);toast('安装指令已复制')};

$('#node-search').oninput=()=>renderRoutes();
$('#export-btn').onclick=async()=>{try{const d=await call('/export'),blob=new Blob([JSON.stringify(d,null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`aegis-relay-${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(a.href);toast('配置已导出；连接密码不会包含在文件中')}catch(e){toast(e.message,true)}};
$('#import-btn').onclick=()=>$('#import-modal').classList.remove('hidden');$('#close-import').onclick=()=>$('#import-modal').classList.add('hidden');$('#do-import').onclick=async()=>{try{const parsed=JSON.parse(value('#import-json')),d=await call('/import',{method:'POST',body:JSON.stringify(parsed)});$('#import-modal').classList.add('hidden');const secrets=d.credentials.map(x=>`${x.alias}\n${x.clientPath}${x.accessKey?`\n${x.accessKey}`:''}`).join('\n\n');if(secrets)showSecret(`新生成的节点凭据\n\n${secrets}`,{eyebrow:'IMPORT CREDENTIALS',title:'导入节点连接信息',description:'这些节点地址和连接密码可由管理员随时再次查看。'});toast(`已导入 ${d.imported} 个节点`);await refreshAll()}catch(e){toast(e.message,true)}};
$('#close-modal').onclick=()=>$('#modal').classList.add('hidden');$('#copy-secret').onclick=async()=>{await navigator.clipboard.writeText($('#secret').textContent);toast('已复制到剪贴板')};
$('#save-notifications').onclick=async()=>{try{await call('/notifications',{method:'PUT',body:JSON.stringify({telegram:{enabled:$('#telegram-enabled').checked,botToken:value('#telegram-token'),chatId:value('#telegram-chat')}})});toast('通知设置已保存');await loadNotifications()}catch(e){toast(e.message,true)}};$('#test-notifications').onclick=async()=>{try{await call('/notifications/test',{method:'POST',body:'{}'});toast('测试消息已发送')}catch(e){toast(e.message,true)}};
$('#save-certificate-email').onclick=async()=>{try{await call('/deployment',{method:'PUT',body:JSON.stringify({certificateEmail:value('#certificate-email')})});toast('统一证书邮箱已保存');await loadDeployment()}catch(e){toast(e.message,true)}};

async function streamDashboard(){if(!state.csrf)return;try{const response=await fetch(base+'/events',{headers:{'x-csrf-token':state.csrf}});if(response.status===401){showLogin();return}if(!response.ok||!String(response.headers.get('content-type')||'').includes('text/event-stream'))throw Error('event stream unavailable');const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';while(true){const{done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const chunks=buffer.split('\n\n');buffer=chunks.pop();for(const chunk of chunks){const line=chunk.split('\n').find(x=>x.startsWith('data: '));if(line){state.dashboard=JSON.parse(line.slice(6));renderDashboard(state.dashboard);renderTraffic(state.dashboard)}}}}catch{if(!state.csrf)return;$('#live-state').innerHTML='<i></i>重连中';setTimeout(streamDashboard,5000)}}
start();

// 自动切流: the page is drawn by view.js; here are the fetching, the timer and the buttons.
const steering=steeringRefresher({ask:()=>call('/steering',{signal:AbortSignal.timeout(10000)}),onPage:()=>state.page==='steering',signedIn:()=>!!state.csrf,hidden:()=>document.hidden,
  show:(data,liveOnly)=>liveOnly?renderSteeringLive(data):renderSteering(data),status:text=>{$('#steering-refresh').textContent=text},toast,now:()=>Date.now()});
const loadSteering=steering.load;
setInterval(steering.tick,STEERING_REFRESH_MS);
function renderSteering(d){
  write(steeringView(d,Date.now()));
  $$('.steer-target').forEach(box=>box.onchange=async()=>{try{await call(`/agents/${box.dataset.id}`,{method:'PATCH',body:JSON.stringify({steerTarget:box.checked})});await loadSteering()}catch(e){toast(e.message,true);box.checked=!box.checked}});
  $$('.copy-steer-command').forEach(b=>b.onclick=async()=>{try{await navigator.clipboard.writeText(b.dataset.command);toast('命令已复制')}catch{toast('复制失败，请手动选择',true)}});
}
function renderSteeringLive(d){write(steeringLiveView(d,Date.now()))}
async function saveSteering(extra={}){try{renderSteering(await call('/steering',{method:'PUT',body:JSON.stringify(steeringSave(readForm(STEERING_FIELDS),extra))}));toast('切流设置已保存');await refreshAll()}catch(e){toast(e.message,true)}}
$('#save-steering').onclick=()=>saveSteering();
$('#clear-steering-excluded').onclick=()=>saveSteering({clearAutoExcluded:true});
$('#clear-steering-ranges').onclick=()=>saveSteering({clearRangeAuto:true});
