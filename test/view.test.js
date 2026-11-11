import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as view from '../web/view.js';

// web/view.js is the half of the panel's UI that decides what is shown. It is imported here as the
// page imports it and called with plain data: there is no page, no network and no browser in this file.

test('view.js decides from the data it is given: it does not reach for the page, the network or the clock',()=>{
  // Running in Node already shows there is no page to reach for (a use of `document` would throw when
  // called); these are the things Node would let through.
  const source=fs.readFileSync(new URL('../web/view.js',import.meta.url),'utf8').replace(/^\s*\/\/.*$/gm,'');
  assert.deepEqual(source.match(/\b(document|window|location|localStorage|navigator|fetch|setTimeout|setInterval|Date\.now|Math\.random)\b|new Date\(\)/g),null);
});

test('text that came from outside is escaped wherever it is put into markup',()=>{
  assert.equal(view.escapeHtml(`<a href="x" title='y'>&</a>`),'&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  assert.deepEqual([view.escapeHtml(null),view.escapeHtml(undefined),view.escapeHtml(0),view.escapeHtml(false)],['','','0','false']);
});

test('sizes are shown in the unit that keeps them short',()=>{
  assert.deepEqual([0,1,1023,1024,1536,10*1024,1024**2*9.96,1024**3,1024**4*2.5,1024**5*3,'abc',undefined,null,-5].map(n=>view.bytes(n)),
    ['0 B','1 B','1023 B','1.0 KB','1.5 KB','10 KB','10.0 MB','1.0 GB','2.5 TB','3072 TB','0 B','0 B','0 B','-5 B']);
});

test('the traffic chart covers the days up to today, in UTC, oldest first',()=>{
  const now=Date.parse('2026-03-02T23:30:00+08:00'),days=view.recentDays({'2026-03-02':7,'2026-03-01':'5','2026-02-28':3,'2026-02-17':99},now);
  assert.deepEqual([days.length,days[0],days.at(-3),days.at(-2),days.at(-1)],[14,{key:'2026-02-17',label:'2/17',bytes:99},{key:'2026-02-28',label:'2/28',bytes:3},{key:'2026-03-01',label:'3/1',bytes:5},{key:'2026-03-02',label:'3/2',bytes:7}]);
  assert.deepEqual(view.recentDays(undefined,now,2),[{key:'2026-03-01',label:'3/1',bytes:0},{key:'2026-03-02',label:'3/2',bytes:0}]);
});

test('what an operator copies for a client is the whole address, with the key only when there is one',()=>{
  const keyed=view.credentialText({publicBaseUrl:'https://emby.example.com/',clientPath:'/movies/key123/',accessKey:'key123'},'https://panel.example.com');
  assert.deepEqual(keyed.split('\n').filter(Boolean),['客户端服务器地址（复制这一整行）','https://emby.example.com/movies/key123/','地址保护码（已经包含在上面的地址中，无需单独填写）','key123','在 Emby 客户端添加服务器时，只需粘贴完整服务器地址。']);
  // A panel that knows no public address of its own goes by the one it is being viewed at.
  const open=view.credentialText({clientPath:'/shows/',accessKey:''},'https://panel.example.com');
  assert.deepEqual(open.split('\n').filter(Boolean),['客户端服务器地址（复制这一整行）','https://panel.example.com/shows/','此节点没有启用连接密码，知道地址的人都可以访问。']);
});

test('a node is found by its name, its path or one of its tags',()=>{
  const node={name:'Movies 4K',alias:'films',tags:['Asia','hdr']};
  assert.deepEqual(['','movies','4k','film','asia','hdr','s 4','shows'].map(q=>view.routeMatches(node,q)),[true,true,true,true,true,true,true,false]);
  assert.equal(view.routeMatches({name:'N',alias:'a'},'n'),true,'a node without tags');
});

test('the two-step verification code is drawn as squares on a quiet border',()=>{
  const svg=view.qrSvg({size:2,rows:['10','01']});
  assert.match(svg,/^<svg viewBox="0 0 50 50" width="50" height="50" role="img" aria-label="两步验证二维码"><rect width="50" height="50" fill="#fff"\/><path d="M20 20h5v5h-5zM25 25h5v5h-5z" fill="#000"\/><\/svg>$/);
});

test('every page has a title, and the client presets start with the one that sends nothing of its own',()=>{
  const pages=[...new Set([...fs.readFileSync(new URL('../web/index.html',import.meta.url),'utf8').matchAll(/data-page="([a-z]+)"/g)].map(match=>match[1]))];
  assert.deepEqual(Object.keys(view.TITLES).sort(),pages.sort());
  assert.deepEqual([view.UA_PRESETS[0].clear,view.UA_PRESETS.slice(1).every(preset=>preset.userAgent&&preset.client&&preset.deviceName&&!preset.clear)],[true,true]);
});

// ---------------------------------------------------------------------------------------------------
// Nodes.
const HTML=fs.readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
// The control with an id in the page: its tag and, for an input, its type.
const control=id=>{const found=new RegExp(`<(input|select|textarea)\\b[^>]*\\bid="${id.slice(1)}"[^>]*>`).exec(HTML);return found?{tag:found[1],type:/\btype="([a-z]+)"/.exec(found[0])?.[1]||''}:null};
const node=(extra={})=>({id:'r1',name:'Movies',alias:'movies',tags:[],notes:'',upstreams:['https://emby.example.com'],accessMode:'key',allowPrivate:false,tlsVerify:true,showOnHome:false,favorite:false,enabled:true,sortOrder:10,
  speedLimitMbps:0,monthlyQuotaGB:0,reminderDays:0,accessAlertThreshold:0,clientProfile:{enabled:false,userAgent:'',client:'',deviceName:'',deviceId:''},streamRewrite:{enabled:false,domains:[]},autoSteer:{enabled:false,minRateMbps:0},egressAgentId:'',lineSync:true,lineSyncUpstream:false,syncLines:[],...extra});
const rowsOf=html=>html.split('<tr data-id="').slice(1);

test('the node list shows each node with what it does, and escapes every name, path and tag',()=>{
  const routes=[node({id:'r1',name:'<b>Movies</b>',alias:'a"b',tags:['4K','<i>'],favorite:true,reminderDays:30,speedLimitMbps:80,upstreams:['a','b'],clientProfile:{enabled:true,client:'In<fuse'},streamRewrite:{enabled:true}}),
    node({id:'r2',name:'Shows',alias:'shows',accessMode:'alias_only',enabled:false})];
  const list=view.nodeListView({routes,dashboard:{nodes:[{id:'r1',suspicious:true,distinctDevices:9},{id:'r2',suspicious:false}]},search:''});
  assert.equal(list['#node-count'].html,'共 <b>2</b> 个节点');
  assert.equal(list['#node-empty'].html,'');
  const [first,second]=rowsOf(list['#node-rows'].html);
  assert.ok(first.startsWith('r1">')&&second.startsWith('r2">'));
  assert.doesNotMatch(first,/<b>Movies<\/b>|<i>|In<fuse|a"b/);
  for(const text of ['&lt;b&gt;Movies&lt;/b&gt;','/a&quot;b/••••••/','<span class="tag">4K</span>','<span class="tag">&lt;i&gt;</span>','<span class="pill on">运行中</span>','<span class="pill lock">密钥</span>','<span class="pill disguise">伪装：In&lt;fuse</span>','<span class="pill split">分离推流</span>',
    '不同设备 9 超过阈值','2 上游 · 分离推流<br>80 Mbps','class="star on" title="置顶">★','>停用</button>','reminder-node','draggable="true"'])assert.ok(first.includes(text),text);
  for(const text of ['/shows/</span>','<span class="pill off">已停用</span>','<span class="pill off">公开</span>','1 上游<br>不限速','class="star " title="置顶">☆','>启用</button>','rotate-node" disabled'])assert.ok(second.includes(text),text);
  assert.doesNotMatch(second,/reminder-node|疑似被分发|伪装|shows\/••••••/);
  // The address is never part of the list: it is asked for when the operator wants to see it.
  assert.equal(list['#node-rows'].html.split(view.ADDR_MASK).length-1,2);
});

test('a search narrows the list, says how many match, and takes the drag handles away',()=>{
  const routes=[node({id:'r1',name:'Movies'}),node({id:'r2',name:'Shows',alias:'shows',tags:['Asia']})];
  const found=view.nodeListView({routes,dashboard:null,search:'  ASIA '});
  assert.deepEqual([found['#node-count'].html,rowsOf(found['#node-rows'].html).length,found['#node-empty'].html],['共 <b>2</b> 个节点 · 匹配 <b>1</b>',1,'']);
  assert.ok(found['#node-rows'].html.includes('title="搜索时无法拖动排序" >')&&!found['#node-rows'].html.includes('draggable'));
  const none=view.nodeListView({routes,dashboard:null,search:'zzz'});
  assert.deepEqual([none['#node-rows'].html,/没有匹配的节点/.test(none['#node-empty'].html)],['',true]);
  const empty=view.nodeListView({routes:[],dashboard:null,search:'x'});
  assert.deepEqual([empty['#node-count'].html,empty['#node-rows'].html,/创建第一个 Emby 节点/.test(empty['#node-empty'].html)],['','',true]);
});

test('a connection test is summed up by how long the upstream took to answer',()=>{
  const route={name:'Movies'},of=main=>view.testOutcome(route,{main});
  assert.deepEqual(of([{online:true,status:200,latencyMs:120,embyVersion:'4.9'}]),{className:'good',label:'120 ms',failed:false,message:'Movies 在线 · 120 ms · HTTP 200 · Emby 4.9'});
  assert.deepEqual([of([{online:true,latencyMs:299}]).className,of([{online:true,latencyMs:300}]).className,of([{online:true,latencyMs:799}]).className,of([{online:true,latencyMs:800}]).className],['good','warn','warn','bad']);
  assert.deepEqual(of([{online:true,latencyMs:'n/a'}]),{className:'bad',label:'在线',failed:false,message:'Movies 在线 · — · HTTP —'});
  assert.deepEqual(of([{online:false,latencyMs:5,error:'ETIMEDOUT'}]),{className:'bad',label:'失败',failed:true,message:'Movies 连接失败 · ETIMEDOUT'});
  // Only the first upstream counts; no answer at all is a failure.
  assert.deepEqual([of([{online:false},{online:true,latencyMs:1}]).failed,of([]).message,view.testOutcome(route,{}).label],[true,'Movies 连接失败','失败']);
});

test('a node\'s address is its public base and its path; one whose key was never kept has none',()=>{
  assert.equal(view.clientAddress({available:true,publicBaseUrl:'https://emby.example.com/',clientPath:'/movies/k/'},'https://panel.example.com'),'https://emby.example.com/movies/k/');
  assert.equal(view.clientAddress({available:true,clientPath:'/movies/'},'https://panel.example.com'),'https://panel.example.com/movies/');
  assert.throws(()=>view.clientAddress({available:false},'https://panel.example.com'),/未保存可恢复的地址/);
});

test('dragging moves one item before or after another, and only what moved is saved again',()=>{
  const list=['a','b','c','d'].map((id,i)=>({id,sortOrder:(i+1)*10})),ids=items=>items&&items.map(item=>item.id).join('');
  assert.deepEqual([ids(view.moved(list,'a','c',true)),ids(view.moved(list,'a','c',false)),ids(view.moved(list,'d','a',false)),ids(view.moved(list,'b','b',true)),ids(view.moved(list,'a','gone',true)),view.moved(list,'gone','a',true)],
    ['bcad','bacd','dabc','acdb','bcda',null]);
  assert.equal(ids(list),'abcd','the list it was given is left as it was');
  assert.deepEqual(view.orderChanges(list),[]);
  assert.deepEqual(view.orderChanges(view.moved(list,'a','b',true)).map(change=>[change.item.id,change.order]),[['b',10],['a',20]]);
  // Items that never had an order, or had one out of step, are all numbered in tens.
  assert.deepEqual(view.orderChanges([{id:'x'},{id:'y',sortOrder:'20'},{id:'z',sortOrder:25}]).map(change=>[change.item.id,change.order]),[['x',10],['z',30]]);
});

test('every row of the node form names a control of its kind in the page',()=>{
  const wanted={text:['input','select','textarea'],list:['input','textarea'],number:['input'],choice:['select'],check:['input']};
  for(const field of view.ROUTE_FIELDS){
    const found=control(field.id);
    assert.ok(found,`${field.id} is in the page`);
    assert.ok(wanted[field.kind].includes(found.tag),`${field.id} (${field.kind}) is a ${found.tag}`);
    assert.equal(found.type==='checkbox',field.kind==='check',`${field.id} (${field.kind})`);
  }
  assert.equal(new Set(view.ROUTE_FIELDS.map(field=>field.id)).size,view.ROUTE_FIELDS.length);
});

test('a new node starts keyed, verified and with line sync on; everything else is empty or off',()=>{
  const blank=view.blankRouteForm();
  assert.deepEqual(Object.fromEntries(Object.entries(blank).filter(([,value])=>value!==''&&value!==false&&value!=='false')),{'#access-mode':'key','#tls':'true','#line-sync-enabled':true});
  assert.deepEqual(view.formToRoute(blank),{name:'',alias:'',accessKey:'',tags:'',notes:'',upstreams:'',accessMode:'key',allowPrivate:false,tlsVerify:true,showOnHome:false,favorite:false,speedLimitMbps:0,monthlyQuotaGB:0,reminderDays:0,accessAlertThreshold:0,
    clientProfile:{enabled:false,userAgent:'',client:'',deviceName:'',deviceId:''},streamRewrite:{enabled:false,domains:''},autoSteer:{enabled:false,minRateMbps:0},egressAgentId:'',lineSync:true,lineSyncUpstream:false});
});

test('a node is shown in the form as it is, and saving the form unchanged sends the same node back',()=>{
  const full=node({name:'A&B',alias:'movies',tags:['4K','hdr'],notes:'two\nlines',upstreams:['https://a.example.com','https://b.example.com:8096'],accessMode:'alias_only',allowPrivate:true,tlsVerify:false,showOnHome:true,favorite:true,
    speedLimitMbps:80,monthlyQuotaGB:500,reminderDays:30,accessAlertThreshold:5,clientProfile:{enabled:true,userAgent:'Infuse-Direct/8.1.1',client:'Infuse',deviceName:'Apple TV',deviceId:'d-1'},
    streamRewrite:{enabled:true,domains:['s.example.com','c.example.com']},autoSteer:{enabled:true,minRateMbps:12},egressAgentId:'agent-hk',lineSync:false,lineSyncUpstream:true});
  const form=view.routeToForm(full);
  assert.deepEqual(form,{'#name':'A&B','#alias':'movies','#access-key':'','#tags':'4K, hdr','#notes':'two\nlines','#upstreams':'https://a.example.com\nhttps://b.example.com:8096','#access-mode':'alias_only','#private':'true','#tls':'false','#show-home':'true','#favorite':'true',
    '#speed-limit':80,'#monthly-quota':500,'#reminder-days':30,'#access-threshold':5,'#profile-enabled':true,'#profile-ua':'Infuse-Direct/8.1.1','#profile-client':'Infuse','#profile-device':'Apple TV','#profile-device-id':'d-1',
    '#stream-rewrite-enabled':true,'#stream-rewrite-domains':'s.example.com\nc.example.com','#steer-enabled':true,'#steer-min-rate':12,'#steer-egress':'agent-hk','#line-sync-enabled':false,'#line-sync-upstream':true});
  // A control hands back text: what was a number is one again, and the lists go as they were typed.
  const typed=Object.fromEntries(Object.entries(form).map(([id,value])=>[id,typeof value==='boolean'?value:String(value)])),sent=view.formToRoute(typed);
  const {id,enabled,sortOrder,syncLines,...editable}=full;
  assert.deepEqual(sent,{...editable,accessKey:'',tags:'4K, hdr',upstreams:'https://a.example.com\nhttps://b.example.com:8096',streamRewrite:{enabled:true,domains:'s.example.com\nc.example.com'}});
  assert.deepEqual(Object.keys(sent),['name','alias','accessKey','tags','notes','upstreams','accessMode','allowPrivate','tlsVerify','showOnHome','favorite','speedLimitMbps','monthlyQuotaGB','reminderDays','accessAlertThreshold','clientProfile','streamRewrite','autoSteer','egressAgentId','lineSync','lineSyncUpstream']);
  // A node from before some settings existed: nothing is shown as "undefined", and the newer switches take their defaults.
  const old=view.routeToForm({name:'Old',alias:'old',tags:[],upstreams:['https://x.example.com'],accessMode:'key',allowPrivate:false,tlsVerify:true,showOnHome:false,favorite:false,clientProfile:{}});
  assert.deepEqual([old['#access-threshold'],old['#steer-min-rate'],old['#steer-egress'],old['#stream-rewrite-domains'],old['#stream-rewrite-enabled'],old['#steer-enabled'],old['#line-sync-enabled'],old['#line-sync-upstream'],old['#profile-enabled']],[0,'','','',false,false,true,false,false]);
  assert.deepEqual([view.formToRoute({...typed,'#speed-limit':'','#steer-min-rate':''}).speedLimitMbps,view.formToRoute({...typed,'#steer-min-rate':''}).autoSteer.minRateMbps,view.formToRoute({...typed,'#private':'false'}).allowPrivate],[0,0,false]);
});

test('saving the form creates a node on the chosen machine, or changes one; changing how a node is reached takes a yes',()=>{
  const form=view.routeToForm(node({accessMode:'key'})),before=node({accessMode:'key'});
  const created=view.routeSave({...form,'#access-key':'my-key-123'},{editing:false,before:undefined,deployTo:'agent-hk'});
  assert.deepEqual([created.create,created.question,created.body.agentId,created.body.accessKey,created.body.accessMode,Object.keys(created.body).at(-1)],[true,'','agent-hk','my-key-123','key','agentId']);
  // Unchanged access: neither the mode nor the key is sent, so a save cannot change either by accident.
  const kept=view.routeSave({...form,'#access-key':'typed-by-mistake','#name':'Renamed'},{editing:true,before,deployTo:''});
  assert.deepEqual([kept.create,kept.changed,kept.question,'accessMode' in kept.body,'accessKey' in kept.body,'agentId' in kept.body,kept.body.name],[false,false,'',false,false,false,'Renamed']);
  const opened=view.routeSave({...form,'#access-mode':'alias_only'},{editing:true,before,deployTo:''});
  assert.deepEqual([opened.changed,/关闭连接密码后，只要知道短路径的人都能访问/.test(opened.question),opened.body.accessMode],[true,true,'alias_only']);
  const locked=view.routeSave({...form,'#access-key':'new-key-1234'},{editing:true,before:node({accessMode:'alias_only'}),deployTo:''});
  assert.deepEqual([locked.changed,/开启连接密码后，客户端地址会变成带密码的新地址/.test(locked.question),locked.body.accessKey],[true,true,'new-key-1234']);
  // The node went away while its form was open: nothing to compare with, so nothing about access is sent.
  const orphan=view.routeSave({...form,'#access-mode':'alias_only'},{editing:true,before:undefined,deployTo:''});
  assert.deepEqual([orphan.changed,orphan.question,'accessMode' in orphan.body],[false,'',false]);
});

test('the form says whether it makes a node or changes one, and where a key can still be changed',()=>{
  assert.deepEqual(view.routeFormView(null),{'#form-title':{text:'新增 Emby 节点'},'#access-mode':{disabled:false},'#access-key':{disabled:false},'#save-node':{text:'创建节点'}});
  const keyed=view.routeFormView(node({name:'<Movies>'}));
  assert.deepEqual([keyed['#form-title'].text,keyed['#save-node'].text,keyed['#access-key'].placeholder],['编辑 · <Movies>','保存修改','如需更换密码请用列表中的“密码”按钮']);
  assert.equal(view.routeFormView(node({accessMode:'alias_only'}))['#access-key'].placeholder,'留空则安全随机生成');
});

test('a client preset fills the identity fields and leaves the device id alone; the first one clears them',()=>{
  assert.equal(view.presetChips().split('<button').length-1,view.UA_PRESETS.length);
  assert.ok(view.presetChips().startsWith('<button type="button" class="preset-chip" data-i="0">透传（默认）</button>'));
  const infuse=view.UA_PRESETS.find(preset=>preset.name==='Infuse');
  assert.deepEqual(view.presetValues(infuse),{'#profile-enabled':true,'#profile-ua':'Infuse-Direct/8.1.1','#profile-client':'Infuse','#profile-device':'Infuse'});
  assert.deepEqual(view.presetValues(view.UA_PRESETS[0]),{'#profile-enabled':false,'#profile-ua':'','#profile-client':'','#profile-device':''});
  assert.deepEqual([view.presetIs(infuse,'Infuse-Direct/8.1.1'),view.presetIs(infuse,'Infuse-Direct/8.1.2'),view.presetIs(infuse,''),view.presetIs(view.UA_PRESETS[0],''),view.presetIs({name:'x',userAgent:''},'')],[true,false,false,false,false]);
});

test('the node editor previews the lines a client syncs, with the key hidden and names escaped',()=>{
  const both={on:true,upstream:true};
  const keyed=view.linePreviewView({alias:'movie',accessMode:'key',syncLines:[{name:'<香港>',base:'https://hk.example.com'},{name:'IP 机',base:'http://203.0.113.9:8080'}]},both),html=keyed['#line-sync-preview'].html;
  assert.match(html,/这 2 条线路/);assert.match(html,/https:\/\/hk\.example\.com\/movie\/••••••/);assert.match(html,/&lt;香港&gt;/);assert.doesNotMatch(html,/<香港>/);
  assert.match(html,/http:\/\/203\.0\.113\.9:8080\/movie\/••••••/);
  const open=view.linePreviewView({alias:'open',accessMode:'alias_only',syncLines:[{name:'A',base:'https://a.example.com'}]},both);
  assert.ok(open['#line-sync-preview'].html.includes('https://a.example.com/open</div>'),'a node without a key has nothing to hide');
  assert.match(view.linePreviewView({alias:'open',accessMode:'alias_only',syncLines:[]},both)['#line-sync-preview'].html,/还没有可同步的线路/);
  assert.equal(keyed['#line-sync-upstream-hint'].hidden,false,'the upstream warning shows while that switch is on');
  const off=view.linePreviewView(null,{on:false,upstream:false});
  assert.match(off['#line-sync-preview'].html,/保存后/);
  assert.deepEqual([off['#line-sync-options'].hidden,off['#line-sync-upstream-hint'].hidden],[true,true],'hidden while the switches are off');
});

test('distribution channels need a saved node with a key; each gets its own link, and the default one cannot be deleted',()=>{
  const unsaved=view.channelsGate(null),open=view.channelsGate(node({accessMode:'alias_only'})),keyed=view.channelsGate(node());
  assert.deepEqual([unsaved.open,unsaved.changes['#channels-hint'].text,unsaved.changes['#add-channel'].disabled,unsaved.changes['#channel-label'].disabled,unsaved.changes['#channels-list'].html],[false,'保存节点后，可在此为不同用户添加分发通道。',true,true,'']);
  assert.deepEqual([open.open,/公开别名模式/.test(open.changes['#channels-hint'].text),open.changes['#add-channel'].disabled],[false,true,true]);
  assert.deepEqual([keyed.open,keyed.changes['#channels-hint'].text,keyed.changes['#add-channel'].disabled,keyed.changes['#channel-label'].disabled,'#channels-list' in keyed.changes],[true,'',false,false,false]);
  const rows=view.channelRows({publicBaseUrl:'https://emby.example.com/',channels:[{id:'default',label:'',isDefault:true,clientPath:'/movies/k1/'},{id:'c"1',label:'<Friend>',isDefault:false,clientPath:'/movies/k2/'}]},'https://panel.example.com').split('<div class="channel-row"').slice(1);
  assert.equal(rows.length,2);
  assert.ok(rows[0].includes('<strong>默认</strong> <span class="pill off">默认 / 自己</span>')&&rows[0].includes('data-url="https://emby.example.com/movies/k1/"')&&!rows[0].includes('del-chan'));
  assert.ok(rows[1].includes('data-cid="c&quot;1"')&&rows[1].includes('<strong>&lt;Friend&gt;</strong>')&&rows[1].includes('del-chan')&&!rows[1].includes('<Friend>'));
  assert.ok(view.channelRows({channels:[{id:'default',isDefault:true,clientPath:'/m/'}]},'https://panel.example.com').includes('https://panel.example.com/m/'));
  assert.equal(view.channelRows({},'https://panel.example.com'),'');
});

test('upstream traffic can leave from a machine with an HTTPS domain of its own; a new node can be put on any other machine',()=>{
  const agents=[{id:'local',name:'本机',domain:'emby.example.com'},{id:'hk',name:'HK <1>',domain:'hk.example.com',proxyMode:'domain'},{id:'ip',name:'IP',domain:'203.0.113.9',proxyMode:'ip'},{id:'new',name:'',domain:''}];
  const egress=view.egressOptions(agents,'');
  assert.deepEqual([...egress.matchAll(/<option value="([^"]*)">/g)].map(match=>match[1]),['','local','hk']);
  assert.ok(egress.includes('HK &lt;1&gt;（hk.example.com）'));
  // The machine a node already leaves from stays on the list, whatever became of it.
  assert.deepEqual([...view.egressOptions(agents,'ip').matchAll(/<option value="([^"]*)">/g)].map(match=>match[1]),['','local','hk','ip']);
  assert.ok(view.egressOptions(agents,'new').includes('<option value="new">new（无域名）</option>'));
  assert.equal(view.egressOptions(undefined,''),'<option value="">不使用：每台机器自己连上游</option>');
  const deploy=view.deployOptions(agents);
  assert.deepEqual([[...deploy.html.matchAll(/<option value="([^"]*)">([^<]*)</g)].map(match=>`${match[1]}=${match[2]}`),deploy.chosen],[['hk=HK &lt;1&gt; · hk.example.com','ip=IP · 203.0.113.9','new=new'],null]);
  assert.deepEqual([view.deployOptions([agents[0],agents[1]]).chosen,view.deployOptions([agents[0]]).chosen,view.deployOptions(undefined).html,view.deployOptions([{id:'x',proxyMode:'ip'}]).html],['hk',null,'','<option value="x">x · IP 反代</option>']);
  assert.ok(view.DEPLOY_HERE.includes('面板本机'));
});

test('every element view.js writes to is in the page',()=>{
  const ids=new Set([...HTML.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]));
  const named=[...new Set([...fs.readFileSync(new URL('../web/view.js',import.meta.url),'utf8').matchAll(/'#([A-Za-z][\w-]*)'/g)].map(match=>match[1]))];
  assert.ok(named.length>30);
  assert.deepEqual(named.filter(id=>!ids.has(id)),[]);
});

// ---------------------------------------------------------------------------------------------------
// Machines.
const machine=(extra={})=>({id:'hk',name:'HK',transport:'poll',domain:'hk.example.com',proxyMode:'domain',status:'online',routeIds:['r1'],lastSeen:'2026-11-11T08:00:00Z',applyState:'active',inSync:true,error:'',canDelete:true,agentVersion:'1.2.0',domainChange:null,...extra});
const cardsOf=(agents,routes=[node()],panelVersion='1.2.0')=>view.agentsView({agents,routes,panelVersion})['#agent-grid'].html.split('<article class="node-card agent-card"').slice(1);
const cardOf=(agent,routes,panelVersion)=>cardsOf([agent],routes,panelVersion)[0];

test('a machine card says how the machine is doing, and escapes everything it was told',()=>{
  const card=cardOf(machine({id:'a"b',name:'<HK>',domain:'h<k.example.com',error:'EISDIR <x>'}));
  assert.ok(card.startsWith(' data-id="a&quot;b" data-status="online">'));
  for(const text of ['<h3><input class="agent-name" value="&lt;HK&gt;" maxlength="80"','<span class="node-path">安全轮询</span>','<span class="pill on">配置已同步</span>','<span class="pill on">在线</span>','<span class="pill info">HTTPS 域名</span>','<span class="pill info">代理运行中</span>',
    '<small>当前生效域名</small><strong>h&lt;k.example.com</strong>','<small>已选节点</small><strong>1 个</strong>','v1.2.0 <span style="color:var(--green)">· 最新</span>',`<small>最近回执</small><strong>${view.localTime('2026-11-11T08:00:00Z')}</strong>`,
    '<input class="agent-domain" value="h&lt;k.example.com" placeholder="留空＝用本机 IP 反代" >','<button type="button" class="btn ghost switch-domain" >切换代理域名</button>','<button class="btn primary save-agent">保存名称与节点</button>','delete-agent','draggable="true"',
    '<div class="node-test show"><span class="bad">●</span>&nbsp;EISDIR &lt;x&gt;</div>'])assert.ok(card.includes(text),text);
  assert.doesNotMatch(card,/<HK>|h<k|<x>|<label>机器名称|move-up|move-down|待升级/);
  // What the panel does not know it does not make up.
  const fresh=cardOf(machine({status:'stale',applyState:'waiting',inSync:false,lastSeen:null,domain:'',agentVersion:'',canDelete:false}),[node()],'');
  for(const text of ['<span class="pill warn">等待同步</span>','<span class="pill warn">连接延迟</span>','<span class="pill warn">已注册 · 等待配置</span>','<strong>尚未设置</strong>','<strong>未知</strong>','<strong>尚未连接</strong>'])assert.ok(fresh.includes(text),text);
  assert.doesNotMatch(fresh,/delete-agent|node-test/);
  assert.deepEqual(['offline','revoked','something new'].map(status=>/<div class="tag-row"><span class="pill warn">([^<]+)</.exec(cardOf(machine({status})))[1]),['失联','已撤销','失联']);
  assert.ok(cardOf(machine({applyState:'error'})).includes('<span class="pill warn">新配置未生效</span>'));
});

test('the panel machine and a machine on its IP are shown for what they are',()=>{
  const local=cardOf(machine({id:'local',transport:'loopback',agentVersion:'',canDelete:false,domain:'emby.example.com'}));
  for(const text of ['<span class="node-path">本机环回</span>','placeholder="emby.example.com"','必须与面板域名不同','v1.2.0 <span style="color:var(--green)">· 最新</span>'])assert.ok(local.includes(text),text);
  assert.doesNotMatch(local,/HTTPS 域名|IP 反代<\/span>|delete-agent/);
  const ip=cardOf(machine({proxyMode:'ip',domain:'203.0.113.9'}));
  for(const text of ['<span class="pill ">IP 反代</span>','<strong>IP 反代 · 203.0.113.9</strong>','<input class="agent-domain" value="" placeholder="留空＝用本机 IP 反代" >','留空则以本机公网 IP 明文 HTTP 反代'])assert.ok(ip.includes(text),text);
  assert.ok(cardOf(machine({proxyMode:'ip',domain:''})).includes('<strong>IP 反代</strong>'));
});

test('a change of address under way locks the address field, never the node selection; one that failed says why',()=>{
  const working=cardOf(machine({domainChange:{state:'applying',mode:'domain',desiredDomain:'new.example.com',message:'正在申请证书 <1>'}}));
  for(const text of ['<span class="pill warn">正在配置域名</span>','<input class="agent-domain" value="new.example.com" placeholder="留空＝用本机 IP 反代" disabled>','<button type="button" class="btn ghost switch-domain" disabled>','<button class="btn primary save-agent">',
    '<div class="node-test show"><span class="warn">●</span>&nbsp;正在申请证书 &lt;1&gt; · 目标 new.example.com</div>'])assert.ok(working.includes(text),text);
  const toIp=cardOf(machine({domainChange:{state:'pending',mode:'ip',desiredDomain:'',message:'等待机器切换'}}));
  for(const text of ['<span class="pill warn">正在切换 IP 反代</span>','<input class="agent-domain" value="" placeholder="留空＝用本机 IP 反代" disabled>','等待机器切换 · 目标 IP 反代</div>'])assert.ok(toIp.includes(text),text);
  const failed=cardOf(machine({error:'not shown beside a change',domainChange:{state:'failed',mode:'domain',desiredDomain:'bad.example.com',message:'certbot: "bad"'}}));
  for(const text of ['<input class="agent-domain" value="bad.example.com" placeholder="留空＝用本机 IP 反代" >','<span class="bad">●</span>&nbsp;certbot: &quot;bad&quot; · 目标 bad.example.com</div>','<span class="pill info">代理运行中</span>'])assert.ok(failed.includes(text),text);
  assert.doesNotMatch(failed,/not shown beside a change|disabled/);
  // A change that named the address already served has no target worth repeating.
  assert.ok(cardOf(machine({domainChange:{state:'active',mode:'domain',desiredDomain:'hk.example.com',message:'已切换'}})).includes('<span class="good">●</span>&nbsp;已切换</div>'));
});

test('a machine behind the panel\'s version is told how to catch up',()=>{
  const old=cardOf(machine({agentVersion:'1.1.0<'}));
  for(const text of ['<span class="pill warn" title="该机器仍在运行旧版本代理程序">待升级 1.1.0&lt;</span>','v1.1.0&lt; <span style="color:var(--amber)">· 待升级</span>','代理程序 1.1.0&lt; 落后于面板 1.2.0，在该机器执行：<code>sudo aegis-relay-agent update</code>'])assert.ok(old.includes(text),text);
  assert.doesNotMatch(cardOf(machine()),/待升级|aegis-relay-agent update/);
  // A panel that does not say its version cannot call anything old.
  assert.doesNotMatch(cardOf(machine({agentVersion:'1.1.0'}),[node()],''),/待升级|最新|aegis-relay-agent update/);
});

test('a card lists every node, ticks the ones the machine carries, and offers a search only for a long list',()=>{
  const routes=Array.from({length:9},(_,i)=>node({id:`r${i+1}`,name:i?`Node ${i+1}`:'A<B',alias:`n${i+1}`})),card=cardOf(machine({routeIds:['r1','r3']}),routes);
  for(const text of ['<span class="routes-count">已选 2 / 9</span>','<button type="button" class="route-bulk route-all">全选</button><button type="button" class="route-bulk route-none">全不选</button><input class="agent-route-search" placeholder="搜索节点">',
    '<label class="checked" data-search="a&lt;b n1"><input type="checkbox" data-route-id="r1" checked><span><b>A&lt;B</b><small>/n1/</small></span></label>','<label class="" data-search="node 2 n2"><input type="checkbox" data-route-id="r2" ><span>'])assert.ok(card.includes(text),text);
  assert.equal(card.split('data-route-id=').length-1,9);
  const few=cardOf(machine(),routes.slice(0,8));
  assert.ok(few.includes('route-bulk route-all')&&!few.includes('agent-route-search'));
  const none=cardOf(machine({routeIds:[]}),[]);
  assert.ok(none.includes('<div class="agent-route-list"><small>请先创建 Emby 节点</small></div>')&&none.includes('已选 0 / 0')&&!none.includes('route-bulk'));
  assert.equal(view.routesChosen(3,9),'已选 3 / 9');
});

test('with no machine yet the page offers to add the first one',()=>{
  const html=view.agentsView({agents:[],routes:[],panelVersion:'1.2.0'})['#agent-grid'].html;
  assert.ok(html.startsWith('<article class="panel empty-state">')&&html.includes('<h3>添加第一台代理机器</h3>')&&html.includes('<button class="btn primary open-agent">添加机器</button>'));
  assert.equal(cardsOf([machine({id:'a'}),machine({id:'b'})]).length,2);
});

test('saving a card sends its name and nodes and never its address; a remote machine is then watched',()=>{
  const remote=view.agentSave(machine(),{name:'  HK 2 ',routeIds:['r1','r2']});
  assert.deepEqual(remote,{body:{name:'HK 2',routeIds:['r1','r2']},message:'已保存，正在下发到该机器…',watch:true});
  assert.deepEqual(Object.keys(remote.body),['name','routeIds'],'the address is not part of a save');
  assert.deepEqual(view.agentSave(machine({id:'local'}),{name:'本机',routeIds:[]}),{body:{name:'本机',routeIds:[]},message:'代理机器配置已保存',watch:false});
  assert.deepEqual([view.agentSave(machine(),{name:'   ',routeIds:['r1']}),view.agentSave(machine(),{name:'',routeIds:[]})],[{error:'机器名称不能为空'},{error:'机器名称不能为空'}]);
  // Watched for: a machine that is there and has not applied its configuration. The panel machine applies at once.
  assert.deepEqual([[machine({inSync:false})],[machine({inSync:false,status:'offline'})],[machine({id:'local',inSync:false})],[machine()],[],[machine(),machine({id:'b',inSync:false,status:'stale'})]].map(view.awaitingSync),[true,false,false,false,false,true]);
});

test('the address button sends only the address, and nothing when it is the one already served',()=>{
  assert.deepEqual(view.domainSwitch(machine(),' new.example.com '),{unchanged:false,body:{domain:'new.example.com'},message:'域名切换已提交，正在申请证书'});
  assert.deepEqual(view.domainSwitch(machine(),''),{unchanged:false,body:{domain:''},message:'已提交：切换为 IP 反代（HTTP）'});
  assert.deepEqual(view.domainSwitch(machine(),'hk.example.com'),{unchanged:true,message:'代理域名没有变化，无需切换'});
  // A machine on its IP serves on no domain: leaving the field empty changes nothing, a name does.
  const ip=machine({proxyMode:'ip',domain:'203.0.113.9'});
  assert.deepEqual([view.domainSwitch(ip,'  ').unchanged,view.domainSwitch(ip,'203.0.113.9').body,view.domainSwitch(machine({domain:''}),'').unchanged],[true,{domain:'203.0.113.9'},true]);
  const changing=state=>machine({domainChange:{state,message:state==='failed'?'certbot said no':''}});
  assert.deepEqual([view.switchProgress([machine(),changing('pending')]),view.switchProgress([changing('applying'),changing('failed')]),view.switchProgress([changing('failed')]),view.switchProgress([machine({domainChange:{state:'failed'}})]),view.switchProgress([changing('active')]),view.switchProgress([])],
    [{working:true,failure:''},{working:true,failure:'certbot said no'},{working:false,failure:'certbot said no'},{working:false,failure:'切换失败'},{working:false,failure:''},{working:false,failure:''}]);
});

test('adding a machine starts from an empty form listing the nodes, and ends with a command that expires',()=>{
  const form=view.enrollFormView([node({id:'r1',name:'A<B',alias:'ab'}),node({id:'r2',name:'Shows',alias:'shows'})]);
  assert.deepEqual([form['#agent-name'],form['#agent-domain-new'],form['#agent-command-wrap'],form['#agent-enroll-form']],[{value:''},{value:''},{hidden:true},{hidden:false}]);
  assert.equal(form['#agent-enroll-routes'].html,'<label><input type="checkbox" data-enroll-route="r1"><span><b>A&lt;B</b><small>/ab/</small></span></label><label><input type="checkbox" data-enroll-route="r2"><span><b>Shows</b><small>/shows/</small></span></label>');
  assert.equal(view.enrollFormView([])['#agent-enroll-routes'].html,'<small>暂时不部署节点，注册后仍可选择。</small>');
  const made=view.enrollmentView({command:'curl … | sudo sh -s -- --name \'HK <2>\'',expiresAt:'2026-11-11T08:10:00Z'});
  assert.deepEqual(made,{'#agent-command':{text:'curl … | sudo sh -s -- --name \'HK <2>\''},'#agent-command-expiry':{text:`有效期至 ${new Date('2026-11-11T08:10:00Z').toLocaleTimeString()}`},'#agent-enroll-form':{hidden:true},'#agent-command-wrap':{hidden:false}});
});

// ---------------------------------------------------------------------------------------------------
// Automatic steering.
const NOW=Date.parse('2026-11-11T08:00:00Z');
// The steering page as the refresher sees it: what was asked for, drawn, said under the title and said aloud.
function steeringPage(ask){
  const seen={shown:[],status:'',toasts:[]},where={page:'steering',csrf:'test',hidden:false};
  const refresher=view.steeringRefresher({ask,onPage:()=>where.page==='steering',signedIn:()=>!!where.csrf,hidden:()=>where.hidden,show:(data,liveOnly)=>seen.shown.push({data,liveOnly}),status:text=>{seen.status=text},toast:(message,error)=>seen.toasts.push([message,error]),now:()=>NOW});
  return {refresher,seen,where};
}

test('cache-aware advice remains explicitly observational and escapes client names',()=>{
  const data={machines:[{id:'a',name:'ZGO'}],routes:[],live:{playback:[{session:'abc123',client:'<VidHub>',routeId:'n1',state:'possible_stall',lastProgressAt:NOW,machines:[{id:'a',samples:3,rateBps:1e6,bitrate:20e6,margin:0.4,advice:'would_switch'}]}]}};
  const html=view.steeringLiveView(data,NOW)['#steering-playback'].html;
  assert.match(html,/建议试切（未执行）/);assert.match(html,/疑似停滞/);assert.match(html,/最近 3 段/);
  assert.match(html,/&lt;VidHub&gt;/);assert.doesNotMatch(html,/<VidHub>/);
  assert.match(html,/<strong>ZGO<\/strong> · 建议试切（未执行）<br><small class="muted">传输 8\.0 Mbps · 影片 20\.0 Mbps · 最近 3 段 · 码率余量 0\.40×<\/small>/);
  data.live.playback=[];
  assert.match(view.steeringLiveView(data,NOW)['#steering-playback'].html,/已有缓存的播放可能暂时没有新取流请求/);
});

test('steering refreshes live data without overwriting unsaved settings or overlapping requests',async()=>{
  let resolve,calls=0;
  const {refresher,seen,where}=steeringPage(()=>{calls++;return new Promise(r=>{resolve=r})});
  assert.equal(view.STEERING_REFRESH_MS,5000,'the open steering page needs a periodic refresh');
  // What the timer has drawn cannot touch a setting: the live tables name none of the settings' controls.
  const data={settings:{boundedClients:['VidHub'],boundMB:64},machines:[],routes:[],live:{ranges:[{client:'VidHub',continued:8,trialContinued:0,state:'on'}]}};
  const whole=view.steeringView(data,NOW),live=view.steeringLiveView(data,NOW),settings=view.STEERING_FIELDS.map(field=>field.id);
  assert.deepEqual([settings.filter(id=>id in live),settings.filter(id=>!(id in whole))],[[],[]]);
  assert.deepEqual([whole['#steering-bounded'],whole['#steering-bound'],whole['#steering-bound-auto']],[{value:'VidHub'},{value:64},{checked:false}]);
  assert.match(live['#steering-ranges'].html,/8 次/);
  // One request at a time, and the timer asks for the live tables only.
  const pending=refresher.tick();await refresher.tick();assert.equal(calls,1);
  resolve(data);await pending;
  assert.deepEqual([seen.shown,seen.toasts],[[{data,liveOnly:true}],[]]);
  assert.match(seen.status,/^每 5 秒刷新 · 更新于 /);
  for(const [field,value] of [['hidden',true],['page','dashboard'],['csrf','']]){
    Object.assign(where,{hidden:false,page:'steering',csrf:'test',[field]:value});
    await refresher.tick();assert.equal(calls,1,field);
  }
  // Opening the page asks for all of it.
  Object.assign(where,{hidden:false,page:'steering',csrf:'test'});
  const opened=refresher.load();resolve(data);await opened;
  assert.deepEqual([calls,seen.shown.at(-1).liveOnly],[2,false]);
});

test('steering refresh keeps the last snapshot on failure and recovers on the next poll',async()=>{
  let fail=true;
  const {refresher,seen}=steeringPage(async()=>{if(fail)throw Error('offline');return {live:{ranges:[]}}});
  await refresher.tick();
  assert.deepEqual([seen.shown,seen.toasts],[[],[]],'nothing is redrawn, and the timer does not interrupt with a message');
  assert.match(seen.status,/刷新失败/);
  // Asked for by the person, the failure is said aloud.
  await refresher.load();
  assert.deepEqual(seen.toasts,[['offline',true]]);
  fail=false;await refresher.tick();assert.match(seen.status,/更新于/);assert.equal(seen.shown.length,1);
});

test('a steering response arriving after navigation does not change the hidden page',async()=>{
  for(const leave of [where=>{where.page='dashboard'},where=>{where.csrf=''}]){
    let resolve;
    const {refresher,seen,where}=steeringPage(()=>new Promise(r=>{resolve=r}));
    const pending=refresher.tick();leave(where);resolve({live:{ranges:[]}});await pending;
    assert.deepEqual([seen.shown,seen.status],[[],'']);
  }
  // Nor does a failure that arrives after the person has gone elsewhere.
  let reject;
  const {refresher,seen,where}=steeringPage(()=>new Promise((_,r)=>{reject=r}));
  const pending=refresher.load();where.page='dashboard';reject(Error('offline'));await pending;
  assert.deepEqual([seen.status,seen.toasts],['',[]]);
});

test('playback UI labels stale measurements as history and shows the last stream request',()=>{
  const data={settings:{},machines:[],routes:[],live:{sessions:[{session:'abc123',client:'VidHub',routeId:'n1',lastSeen:NOW,scores:{old:{verdict:'ok',rateBps:12e6,at:1000,stale:true},fresh:{verdict:'ok',rateBps:1e6,at:999000,stale:false},unknown:{verdict:'unknown',rateBps:0,at:1000,stale:true}}},{session:'cached',client:'VidHub',lastSeen:NOW-120000,scores:{}}]}};
  const html=view.steeringView(data,NOW)['#steering-sessions'].html;
  assert.match(html,/历史测速已过期/);assert.match(html,/历史速率/);assert.match(html,/最近取流/);
  assert.match(html,/近 1 分钟有取流/);assert.match(html,/近期未取流/);
  assert.match(html,/unknown · 测速样本不足/);assert.doesNotMatch(html,/unknown · 历史测速已过期/);
  assert.match(html,/fresh · 正常 · 8\.0 Mbps/);
  assert.doesNotMatch(html,/old · 正常 · 96\.0 Mbps/);
  // "Recent" is told against the moment the page is drawn at, to the minute.
  const at=lastSeen=>view.steeringLiveView({live:{sessions:[{session:'s',lastSeen,scores:{}}]}},NOW)['#steering-sessions'].html.includes('近 1 分钟有取流');
  assert.deepEqual([at(NOW-60000),at(NOW-60001)],[true,false]);
});

test('the steering page shows the settings as saved, who can take part, and what each machine must run',()=>{
  const d={settings:{mode:'shadow',entryDomain:'entry.example.com',excludedClients:['Infuse','a<b'],boundedClients:['VidHub'],boundMB:48,boundAuto:true,autoExcluded:{SenPlayer:1},autoBounded:{Fileball:1},autoUnbounded:{'Emby Web':1}},certificateEmail:'ops@example.com',
    machines:[{id:'local',name:'<本机>',local:true,domain:'emby.example.com',issues:[],steerTarget:true},{id:'ip"1',name:'IP',local:false,domain:'',issues:['没有 HTTPS <域名>','已关闭'],steerTarget:false}],
    entryCommands:[{name:'A<1>',auto:true,state:'failed',attempt:3,message:'证书 <未签发>',command:'sudo aegis-relay entry "x"'},{name:'B',auto:true,state:'active',message:'已生效',command:'c2'},{name:'C',auto:true,state:'nonsense',command:'c3'},{name:'Old',auto:false,command:'sudo run <me>'}],
    routes:[{id:'r1',name:'<Movies>',alias:'movies',enabled:true,issues:[],entryGaps:['IP','Gone'],egressAgentId:'local',egressActive:true},{id:'r2',name:'',alias:'shows',enabled:false,issues:['未开启自动切流']},{id:'r3',name:'Anime',alias:'anime',enabled:true,issues:['只有一台机器','未开启自动切流'],egressAgentId:'x',egressActive:false,egressIssues:['出口 <不在线>']}],live:{}};
  const page=view.steeringView(d,NOW);
  assert.deepEqual([page['#steering-mode'],page['#steering-entry'],page['#steering-excluded'],page['#steering-bounded'],page['#steering-bound'],page['#steering-bound-auto'],page['#steering-mode-state']],
    [{value:'shadow'},{value:'entry.example.com'},{value:'Infuse\na<b'},{value:'VidHub'},{value:48},{checked:true},{text:'只测不切',className:'pill info'}]);
  assert.deepEqual([page['#steering-auto-excluded'].text,page['#steering-auto-ranges'].text],['自动排除（跳转后经常没有到达目标机器）：SenPlayer','自动加入分段：Fileball；历史停用（可清空后重试）：Emby Web']);
  assert.match(page['#steering-status'].html,/<strong>1 \/ 2<\/strong>.*<small>正在切流的节点<\/small><strong>1<\/strong>.*<strong>entry\.example\.com<\/strong>/);
  const machines=page['#steering-machines'].html;
  for(const text of ['<strong>&lt;本机&gt;</strong><br><small class="muted">面板本机</small>','<span class="pill on">可参与</span>','data-id="local" checked>','<span class="pill warn">没有 HTTPS &lt;域名&gt;</span> <span class="pill warn">已关闭</span>','data-id="ip&quot;1" >','<td>—</td>'])assert.ok(machines.includes(text),text);
  const commands=page['#steering-commands'].html;
  for(const text of ['<strong>A&lt;1&gt;</strong><span class="pill warn">暂未成功，稍后自动重试（第 3 次）</span><small class="muted">证书 &lt;未签发&gt;</small>','<strong>B</strong><span class="pill on">已生效</span></div>','<strong>C</strong><span class="pill ">等待机器执行</span>',
    '<pre>sudo aegis-relay entry &quot;x&quot;</pre><button class="btn ghost copy-steer-command" data-command="sudo aegis-relay entry &quot;x&quot;">复制命令</button>','<pre>sudo run &lt;me&gt;</pre><small class="muted">这台机器的探针版本较旧，需要手动执行一次；升级后会自动配置。</small>'])assert.ok(commands.includes(text),text);
  const routes=page['#steering-routes'].html.split('<tr>').slice(1);
  assert.ok(routes[0].includes('&lt;Movies&gt;')&&routes[0].includes('<span class="pill on">只测不切</span> <span class="pill warn">IP、Gone 没有部署该节点，对外仍用直连地址</span> <span class="pill info">统一出口：&lt;本机&gt;</span>'));
  assert.ok(routes[1].includes('<strong>shows</strong>')&&routes[1].includes('<span class="pill off">关闭</span></td><td>—</td>'),'a node that is simply switched off has no problem to report');
  assert.ok(routes[2].includes('<span class="pill warn">只有一台机器</span> <span class="pill warn">未开启自动切流</span> <span class="pill danger">统一出口未生效：出口 &lt;不在线&gt;</span>'));
  // Nothing set up yet: the defaults, and what to do first.
  const blank=view.steeringView({},NOW);
  assert.deepEqual([blank['#steering-mode'],blank['#steering-bound'],blank['#steering-mode-state'],blank['#steering-auto-excluded'].text,blank['#steering-auto-ranges'].text],[{value:'off'},{value:64},{text:'关闭',className:'pill '},'','']);
  assert.ok(blank['#steering-machines'].html.includes('还没有机器')&&blank['#steering-routes'].html.includes('还没有节点')&&blank['#steering-commands'].html.includes('填写入口域名并保存后'));
  assert.ok(view.steeringView({settings:{entryDomain:'e.example.com'}},NOW)['#steering-commands'].html.includes('请先在「部署向导」保存统一证书邮箱。'));
  assert.ok(view.steeringView({settings:{entryDomain:'e.example.com',mode:'on'},certificateEmail:'a@b.c'},NOW)['#steering-commands'].html.includes('还没有可参与切流的机器。'));
});

test('the live steering tables say what was decided, how it turned out, and for which clients',()=>{
  const d={machines:[{id:'a',name:'<A>'},{id:'b',name:'B'}],routes:[{id:'r1',name:'Movies',alias:'movies'},{id:'r2',name:'',alias:'shows'}],live:{
    events:[{at:NOW,routeId:'r1',from:'a',to:'b',mode:'on',reason:'better_line',fromRateBps:400000,toRateBps:2400000,client:'Infuse'},{at:0,routeId:'gone',from:'b',to:'',mode:'shadow',reason:'custom <reason>',fromRateBps:0,toRateBps:0,client:''}],
    effects:{on:{total:20,better:13,worse:3,upstream:2,notLanded:1,unmeasured:1,medianGain:3.2,pairs:[{from:'a',to:'b',total:12,better:9,worse:2,medianGain:2.5},{from:'b',to:'x',total:8,better:4,worse:1,medianGain:0}]},shadow:{total:9,persisted:6,recovered:2,unmeasured:1}},networks:17,
    ranges:[{client:'a<b',continued:12,trialContinued:3,state:'on'},{client:'T',continued:0,trialContinued:1,state:'trial'},{client:'O',continued:0,trialContinued:0,state:'off'},{client:'?',continued:1,trialContinued:1,state:'other'}],
    clients:[{client:'Sen<Player>',total:8,landed:1,autoExcluded:true},{client:'Infuse',total:30,landed:29,autoExcluded:false}]}};
  const live=view.steeringLiveView(d,NOW),events=live['#steering-events'].html.split('<tr>').slice(1);
  assert.ok(events[0].includes(`<td>${view.clockTime(NOW)}</td><td>Movies</td><td>&lt;A&gt; → B</td><td>切到更快的线路</td><td>3.2 Mbps → 19.2 Mbps</td><td>Infuse</td>`),events[0]);
  assert.ok(events[1].includes('<td>—</td><td>gone</td><td>B → 收到请求的机器 <span class="pill info">本应切换</span></td><td>custom &lt;reason&gt;</td><td>—</td><td>—</td>'),events[1]);
  const effects=live['#steering-effects'].html;
  for(const text of ['真实切换（最近 20 次）</small><strong>65% 卡顿解除</strong>','仍卡顿 3 · 源站慢 2 · 没跟随跳转 1 · 未测到 1 · 中位提速 3.2×','本应切换（最近 9 次）</small><strong>67% 持续卡顿</strong>','3 分钟内自行恢复 2 · 未测到 1','<strong>17</strong>'])assert.ok(effects.includes(text),text);
  assert.equal(live['#steering-effect-pairs'].html,'<tr><td>&lt;A&gt; → B</td><td>12</td><td>9</td><td>2</td><td>2.5×</td></tr><tr><td>B → x</td><td>8</td><td>4</td><td>1</td><td>—</td></tr>');
  assert.deepEqual([...live['#steering-ranges'].html.matchAll(/<td>([^<]*)<\/td><td>(\d+) 次<\/td><td>(\d+) 次<\/td><td>(?:<span class="pill (\w+)">)?/g)].map(match=>match.slice(1,5)),[['a&lt;b','12','3','on'],['T','0','1','info'],['O','0','0','off'],['?','1','1',undefined]]);
  assert.equal(live['#steering-clients'].html,'<tr><td>Sen&lt;Player&gt;</td><td>8</td><td>1</td><td><span class="pill danger">已自动排除</span></td></tr><tr><td>Infuse</td><td>30</td><td>29</td><td><span class="pill on">正常</span></td></tr>');
  // Nothing yet: every table says so instead of standing empty, and no rate is made up.
  const empty=view.steeringLiveView({},NOW);
  for(const [id,text] of [['#steering-playback','等待新的播放进度'],['#steering-events','暂无切流决策'],['#steering-sessions','最近 10 分钟没有取流会话'],['#steering-effect-pairs','还没有真实切换'],['#steering-ranges','还没有已确认的分段接续'],['#steering-clients','还没有跳转记录']])assert.ok(empty[id].html.includes(text),id);
  assert.ok(empty['#steering-effects'].html.includes('<strong>— 卡顿解除</strong>')&&empty['#steering-effects'].html.includes('中位提速 —'));
  assert.deepEqual([view.mbps(0),view.mbps(1e6),view.clockTime(0)],['—','8.0 Mbps','—']);
});

test('saving the steering settings sends them as typed; an empty segment size means the usual one',()=>{
  const typed={'#steering-mode':'on','#steering-entry':' entry.example.com','#steering-excluded':'Infuse\nRex','#steering-bounded':'','#steering-bound':'32','#steering-bound-auto':true};
  assert.deepEqual(view.steeringSave(typed),{mode:'on',entryDomain:' entry.example.com',excludedClients:'Infuse\nRex',boundedClients:'',boundMB:32,boundAuto:true});
  assert.deepEqual([view.steeringSave({...typed,'#steering-bound':''}).boundMB,view.steeringSave(typed,{clearAutoExcluded:true}).clearAutoExcluded,Object.keys(view.steeringSave(typed,{clearRangeAuto:true})).at(-1)],[64,true,'clearRangeAuto']);
  for(const field of view.STEERING_FIELDS)assert.ok(control(field.id),field.id);
});

// ---------------------------------------------------------------------------------------------------
// Dashboard, traffic and access.
test('the dashboard sums up nodes, traffic and machines, and charts the last two weeks',()=>{
  const day=ago=>new Date(NOW-ago*86400000).toISOString().slice(0,10),GB=1024**3;
  const data={running:2,totalBytes:100*GB,monthBytes:40*GB,totalRequests:1234567,playbackRequests:4321,active:7,daily:{[day(0)]:2*GB,[day(1)]:8*GB,[day(6)]:GB,[day(7)]:16*GB,[day(20)]:999*GB},
    machines:[{id:'local',name:'<本机>',domain:'emby.example.com',transport:'loopback',status:'online',proxyHealthy:true,inSync:true,telemetry:{totalBytes:25*GB,monthBytes:10*GB,totalRequests:1000,playbackRequests:10,active:3},lastTelemetryAt:'2026-11-11T07:59:00Z'},
      {id:'hk',name:'HK',domain:'',transport:'poll',status:'online',proxyHealthy:false,inSync:false,telemetry:null,lastTelemetryAt:null},{id:'gone',name:'Gone',domain:'',transport:'',status:'offline',proxyHealthy:false,inSync:false,telemetry:{totalBytes:0,monthBytes:0,totalRequests:0,playbackRequests:0},lastTelemetryAt:null}],
    nodes:[{id:'r1',bytesOut:5*GB,active:2}]};
  const routes=[node({id:'r1',name:'<Movies>',alias:'m"1'}),node({id:'r2',name:'Shows',alias:'shows',enabled:false}),...Array.from({length:6},(_,i)=>node({id:`x${i}`,name:`N${i}`,alias:`n${i}`}))];
  const page=view.dashboardView({data,routes,now:NOW});
  assert.deepEqual(['#m-nodes','#m-running','#m-traffic','#m-month-traffic','#m-requests','#m-active','#m-agents','#m-agent-state'].map(id=>page[id].text),[8,'2 个运行中','100 GB','本月 40 GB',(1234567).toLocaleString(),'7 个活动连接','1 / 3','2 台需关注']);
  const days=page['#traffic-chart'].html.split('<div class="traffic-day').slice(1);
  assert.equal(days.length,14);
  assert.ok(days.at(-1).startsWith(`" title="${day(0)} · 2.0 GB"><div class="traffic-track"><i style="height:12.5%"></i><b class="traffic-value" style="bottom:calc(12.5% + 6px)">2.0 GB</b>`),days.at(-1));
  assert.ok(days.at(-8).includes('height:100%')&&days.at(-3).startsWith(' empty"')&&!days.at(-3).includes('traffic-value'),'the tallest day fills the chart; a day without traffic has no bar');
  assert.equal(page['#traffic-insights'].html,`<div><small>今日流量</small><strong>2.0 GB</strong></div><div><small>近 7 天</small><strong>11 GB</strong></div><div><small>单日峰值</small><strong>16 GB</strong><em>${new Date(NOW-7*86400000).getUTCMonth()+1}/${new Date(NOW-7*86400000).getUTCDate()}</em></div><div><small>播放请求</small><strong>${(4321).toLocaleString()}</strong></div>`);
  const machines=page['#dashboard-machines'].html.split('<div class="machine-tile"').slice(1);
  for(const text of ['data-status="online"','<i class="machine-dot "></i>&lt;本机&gt;</strong><small>emby.example.com</small>','<span class="pill on">在线</span><span class="pill info">已同步</span>','<small>累计流量</small><strong>25 GB</strong>','<i style="width:25%"></i>',`占全网流量 25.0% · 最近上报 ${view.localTime('2026-11-11T07:59:00Z')}`])assert.ok(machines[0].includes(text),text);
  for(const text of ['<i class="machine-dot off"></i>HK</strong><small>poll</small>','<span class="pill warn">在线</span><span class="pill warn">待同步</span>','<div class="telemetry-missing">等待该 Agent 升级后上报流量</div>'])assert.ok(machines[1].includes(text),text);
  for(const text of ['<small>尚未设置域名</small>','<span class="pill warn">失联</span>','占全网流量 0.0% · 最近上报 —'])assert.ok(machines[2].includes(text),text);
  // The six first nodes, with what the panel machine carried for each.
  const rows=page['#dashboard-nodes'].html.split('<div class="mini-row">').slice(1);
  assert.equal(rows.length,6);
  assert.ok(rows[0].includes('<i class="status-dot "></i>&lt;Movies&gt;</strong><small>/m&quot;1/ · 主代理机 5.0 GB</small></div><span class="pill">2 活动</span>')&&rows[1].includes('<i class="status-dot off"></i>Shows</strong><small>/shows/ · 主代理机 0 B</small></div><span class="pill">0 活动</span>'));
  // A panel with nothing yet.
  const empty=view.dashboardView({data:{running:0,daily:{}},routes:[],now:NOW});
  assert.deepEqual([empty['#m-agents'].text,empty['#m-agent-state'].text,empty['#m-requests'].text,empty['#m-active'].text,/还没有代理机器/.test(empty['#dashboard-machines'].html),/还没有节点/.test(empty['#dashboard-nodes'].html),empty['#traffic-chart'].html.split('traffic-day empty').length-1],['0 / 0','暂无代理机器','0','0 个活动连接',true,true,14]);
});

test('traffic is listed per node against its monthly quota',()=>{
  const GB=1024**3,routes=[node({id:'r1',name:'<Movies>',alias:'movies'}),node({id:'r2',name:'Shows',alias:'shows'}),node({id:'r3',name:'New',alias:'new'})];
  const rows=view.trafficView({routes,data:{nodes:[{id:'r1',requests:12345,playbackRequests:678,bytesOut:9*GB,monthBytes:480*GB,quotaBytes:500*GB,speedLimitMbps:80,errors:2},{id:'r2',requests:1,playbackRequests:0,bytesOut:GB,monthBytes:30*GB,quotaBytes:0,speedLimitMbps:0,errors:0}]}})['#traffic-table'].html.split('<tr>').slice(1);
  assert.equal(rows[0],`<td><strong>&lt;Movies&gt;</strong><br><small class="muted">/movies/</small></td><td>${(12345).toLocaleString()}</td><td>678</td><td>9.0 GB</td><td>480 GB / 500 GB<div class="progress"><i class="danger" style="width:96%"></i></div></td><td>80 Mbps</td><td>2</td></tr>`);
  assert.ok(rows[1].includes('<td>30 GB / 不限额<div class="progress"><i class="" style="width:0%"></i></div></td><td>不限速</td><td>0</td>'));
  assert.ok(rows[2].includes('<td>0</td><td>0</td><td>0 B</td><td>0 B / 不限额'),'a node the panel has no figures for yet');
  const bar=(month,quota)=>/<i class="(\w*)" style="width:([\d.]+)%">/.exec(view.trafficView({routes:[routes[0]],data:{nodes:[{id:'r1',monthBytes:month,quotaBytes:quota}]}})['#traffic-table'].html).slice(1);
  assert.deepEqual([bar(50,100),bar(51,100),bar(85,100),bar(86,100),bar(300,100)],[['','50'],['warn','51'],['warn','85'],['danger','86'],['danger','100']]);
});

test('access is shown node by node and channel by channel, only for nodes that still exist',()=>{
  const routes=[node({id:'r1'}),node({id:'r2'})];
  const d={nodes:[{id:'r1',name:'<Movies>',alias:'movies',suspicious:true,distinctDevices:9,channels:[
      {label:'Friend <A>',suspicious:true,distinctDevices:8,distinctIps:5,viewers:[{ip:'2001:db8::1',deviceName:'Apple <TV>',client:'Infuse',ua:`UA<${'x'.repeat(60)}`,machine:'HK <1>',hits:42,lastSeen:String(NOW)},{ip:'203.0.113.5',deviceName:'',client:'',ua:'',machine:'',hits:0,lastSeen:0}]},
      {label:'Empty',suspicious:false,distinctDevices:0,distinctIps:0,viewers:[]}]},
    {id:'r2',name:'Shows',alias:'shows',suspicious:false,distinctDevices:0,channels:[]},{id:'deleted',name:'Gone',alias:'gone',suspicious:false,distinctDevices:1,channels:[]}]};
  const html=view.accessView(d,routes)['#access-list'].html,nodes=html.split('<details class="panel access-node').slice(1);
  assert.equal(nodes.length,2,'a node that was deleted is left out');
  for(const text of [' suspicious">','&lt;Movies&gt; <small class="muted">/movies/</small>','<span class="node-status bad">⚠ 疑似多人共享</span><span class="pill off">通道 2</span><span class="pill off">设备合计 9</span>','<details class="chan-detail suspicious"><summary><span class="chan-name">Friend &lt;A&gt;</span><span class="pill warn">设备 8</span><span class="pill off" title="动态 IP 仅供参考">IP 5</span><span class="pill danger">⚠ 疑似转分发</span>',
    `<tr><td><code>2001:db8::1</code></td><td>Apple &lt;TV&gt;<br><small class="muted">Infuse</small></td><td><small class="muted">UA&lt;${'x'.repeat(47)}</small></td><td>HK &lt;1&gt;</td><td>42</td><td>${new Date(NOW).toLocaleString()}</td></tr>`,
    '<tr><td><code>203.0.113.5</code></td><td>—</td><td><small class="muted"></small></td><td>—</td><td>0</td><td>—</td></tr>','<details class="chan-detail "><summary><span class="chan-name">Empty</span><span class="pill info">设备 0</span>','<p class="muted">该通道暂无观看记录。</p>'])assert.ok(nodes[0].includes(text),text);
  assert.ok(nodes[1].includes('<span class="node-status ok">✓ 安全</span><span class="pill off">通道 0</span>')&&nodes[1].includes('<div class="access-node-body"><p class="muted">暂无访问记录。</p></div>'));
  for(const nothing of [{nodes:[]},{},{nodes:[d.nodes[2]]}])assert.match(view.accessView(nothing,routes)['#access-list'].html,/暂无访问记录/);
  assert.match(view.ACCESS_LOADING['#access-list'].html,/正在汇总访问记录/);
  assert.equal(view.accessFailed('storage <down>')['#access-list'].html,'<article class="panel empty-state"><h3>加载失败</h3><p>storage &lt;down&gt;</p></article>');
});
