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
