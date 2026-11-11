import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as view from '../web/view.js';

// web/app.js is the page's side of the panel: it fetches, hands the data to view.js, writes what comes
// back into the page and binds what a person can press. Here the real file is started in a page made
// of stand-ins (one element for each id in index.html, with its kind and its classes; a network that
// answers from a table) and driven through the handlers it bound. What is checked is the wiring: that
// the right request leaves for the right press, and that the answer lands where it belongs. What is
// shown for which data is view.js's business and is tested there (test/view.test.js).
const HTML=fs.readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
const APP=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const json=(data,status=200)=>({status,type:'application/json; charset=utf-8',body:JSON.stringify(data)});

const unescaped=text=>text.replace(/&(amp|lt|gt|quot|#39);/g,(all,name)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[name]));
const optionsIn=html=>[...html.matchAll(/<option\b([^>]*)>([^<]*)/g)].map(found=>unescaped(/\bvalue="([^"]*)"/.exec(found[1])?.[1]??found[2]));

function page() {
  const make=({type='',classes=[],dataset={},options=[]}={})=>{
    const held=new Set(classes),element={type,value:'',checked:false,disabled:false,textContent:'',innerHTML:'',placeholder:'',href:'',dataset:{...dataset},style:{},files:[],focused:0,
      classList:{add:(...names)=>names.forEach(name=>held.add(name)),remove:(...names)=>names.forEach(name=>held.delete(name)),contains:name=>held.has(name),toggle(name,on=!held.has(name)){if(on)held.add(name);else held.delete(name);return on}},
      get className(){return [...held].join(' ')},set className(names){held.clear();for(const name of String(names).split(/\s+/).filter(Boolean))held.add(name)},
      querySelector:()=>null,querySelectorAll:()=>[],getAttribute:()=>null,addEventListener(){},insertAdjacentHTML(where,html){element.innerHTML+=html},replaceChildren(){},appendChild(){},focus(){element.focused++},click(){},closest:()=>null};
    if(type!=='select-one')return element;
    // A select, as a page has it: it holds one of its options or nothing, and starts again at the
    // first when its options are written anew.
    let choices=[...options],chosen=choices[0]??'',markup='';
    Object.defineProperties(element,{
      value:{get:()=>chosen,set:value=>{chosen=choices.includes(String(value))?String(value):''}},
      innerHTML:{get:()=>markup,set:html=>{markup=String(html);choices=optionsIn(markup);chosen=choices[0]??''}}});
    element.insertAdjacentHTML=(where,html)=>{markup+=html;choices=choices.concat(optionsIn(html))};
    return element;
  };
  // Everything index.html holds, in order: its tag, id, classes and data-*; a control's kind; a select's options.
  const elements=new Map(),parts=[];
  for(const found of HTML.matchAll(/<([a-z0-9]+)\b([^>]*)>/g)){
    const [,tag,attributes]=found,id=/\bid="([^"]+)"/.exec(attributes)?.[1]||'';
    const about={type:tag==='input'?/\btype="([^"]+)"/.exec(attributes)?.[1]||'text':tag==='select'?'select-one':tag,classes:(/\bclass="([^"]*)"/.exec(attributes)?.[1]||'').split(/\s+/).filter(Boolean),
      dataset:Object.fromEntries([...attributes.matchAll(/\bdata-([a-z-]+)="([^"]*)"/g)].map(([,name,value])=>[name.replace(/-(.)/g,(all,letter)=>letter.toUpperCase()),value])),
      options:tag==='select'?optionsIn(HTML.slice(found.index,HTML.indexOf('</select>',found.index))):[]};
    const element=make(about);
    parts.push({element,about});
    if(id)elements.set(`#${id}`,element);
  }
  // As in a browser: an id the page does not have is not there.
  const el=selector=>elements.get(selector)??null;
  // What app.js finds inside something it wrote: one stand-in for each piece of the markup, holding the
  // id it was written with; inside it, only what the markup has (a field with the value it was written
  // with). The same stand-ins for as long as the markup stays the same, as in a page.
  const written=(container,selector,opening,inside=()=>[])=>{
    const kept={of:null,list:[]};
    container.querySelectorAll=asked=>{
      if(asked!==selector)return [];
      if(kept.of!==container.innerHTML)Object.assign(kept,{of:container.innerHTML,list:container.innerHTML.split(opening).slice(1).map(html=>{
        const found=new Map(),part=inner=>{
          if(!html.includes(inner.replace(/^\./,'')))return null;
          if(!found.has(inner))found.set(inner,Object.assign(make(),{value:unescaped(new RegExp(`class="${inner.slice(1)}" value="([^"]*)"`).exec(html)?.[1]??'')}));
          return found.get(inner);
        };
        return Object.assign(make(),{dataset:{id:unescaped(/data-id="([^"]*)"/.exec(html)[1])},querySelector:part,querySelectorAll:inner=>inside(html,inner)});
      })});
      return kept.list;
    };
  };
  written(el('#node-rows'),'tr','<tr');
  written(el('#agent-grid'),'.agent-card','<article class="node-card agent-card"',(html,inner)=>inner==='[data-route-id]:checked'?[...html.matchAll(/data-route-id="([^"]*)" checked/g)].map(found=>({dataset:{routeId:found[1]}})):[]);
  // The node boxes of the add-machine dialog: there to be ticked.
  const boxes={of:null,list:[]},enrolBoxes=()=>{
    const html=el('#agent-enroll-routes').innerHTML;
    if(boxes.of!==html)Object.assign(boxes,{of:html,list:[...html.matchAll(/data-enroll-route="([^"]*)"/g)].map(found=>Object.assign(make({type:'checkbox'}),{dataset:{enrollRoute:found[1]}}))});
    return boxes.list;
  };
  const all=selector=>selector==='[data-enroll-route]:checked'?enrolBoxes().filter(box=>box.checked):selector.split(',').flatMap(one=>{
    const name=one.trim(),data=/^\[data-([a-z-]+)\]$/.exec(name)?.[1].replace(/-(.)/g,(found,letter)=>letter.toUpperCase());
    return parts.filter(({about})=>name.startsWith('.')?about.classes.includes(name.slice(1)):data?data in about.dataset:false).map(part=>part.element);
  });
  const document={querySelector:selector=>selector.startsWith('#')?el(selector):selector.startsWith('link')?make():null,querySelectorAll:all,createElement:()=>make(),head:{appendChild(){}},documentElement:{dataset:{theme:'light'}},hidden:false};
  return {document,el,all,enrolBoxes,shown:selector=>!el(selector).classList.contains('hidden')};
}

// Start app.js in a page of its own. `answers` is the panel: "METHOD /path" → an answer, or a function
// of the request. What a person would be asked is answered from `ui.says`: yes or no, and what they type.
async function start(answers={}) {
  const {document,el,all,enrolBoxes,shown}=page(),requests=[],intervals=[],timeouts=[],stored=new Map(),says={yes:true,typed:'',asked:[]};
  const fetch=async(url,options={})=>{
    const address=new URL(url,'http://panel.test'),method=options.method||'GET',at=address.pathname.indexOf('/api/');
    const request={method,path:address.pathname.slice(at+4),prefix:address.pathname.slice(0,at+4),body:options.body===undefined?null:JSON.parse(options.body),csrf:options.headers?.['x-csrf-token']??null};
    requests.push(request);
    let answer=answers[`${method} ${request.path}`];
    if(typeof answer==='function')answer=answer(request);
    answer=answer||json({});
    // A body that is read as a stream arrives in two pieces, cut wherever the middle falls.
    const pieces=[answer.body.slice(0,answer.body.length>>1),answer.body.slice(answer.body.length>>1)].map(piece=>new TextEncoder().encode(piece));
    return {status:answer.status,ok:answer.status>=200&&answer.status<300,headers:{get:name=>name.toLowerCase()==='content-type'?answer.type:null},text:async()=>answer.body,json:async()=>JSON.parse(answer.body),
      body:{getReader:()=>({read:async()=>pieces.length?{done:false,value:pieces.shift()}:{done:true}})}};
  };
  const context=vm.createContext({document,fetch,__view:view,location:{href:'http://panel.test/_aegis/',pathname:'/_aegis/',origin:'http://panel.test',reload(){}},
    localStorage:{getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,String(value))},navigator:{clipboard:{writeText:async()=>{}}},
    setTimeout:(fn,ms)=>timeouts.push({fn,ms}),clearTimeout(){},setInterval:(fn,ms)=>intervals.push({fn,ms}),clearInterval(){},
    confirm:question=>{says.asked.push(question);return says.yes},prompt:question=>{says.asked.push(question);return says.typed},AbortSignal,URL,Blob,TextDecoder,console});
  // The file as the browser gets it, but for the two things only a module in a browser has: its imports and its own address.
  let swapped=0;
  const source=APP.replace(/^import \{([^}]*)\} from '\.\/view\.js';$/m,(line,names)=>{swapped++;return `const {${names}}=__view;`}).replace('import.meta.url',()=>{swapped++;return `'http://panel.test/_aegis/app.js?v=1'`});
  assert.equal(swapped,2);
  vm.runInContext(`'use strict';${source}`,context,{filename:'web/app.js'});
  // Everything a press or a load sets going has come to rest when no new request has left for a while.
  const settle=async()=>{for(let quiet=0,seen=-1;quiet<5;){await new Promise(resolve=>setImmediate(resolve));if(requests.length===seen)quiet++;else{quiet=0;seen=requests.length}}};
  await settle();
  const press=async element=>{await element.onclick();await settle()};
  return {el,all,enrolBoxes,shown,requests,intervals,timeouts,settle,stored,document,answers,says,run:code=>vm.runInContext(code,context),
    press:target=>press(typeof target==='string'?el(target):target),
    // The page reached as a person reaches it: by its button in the side bar.
    go:name=>press(all('[data-page]').find(button=>button.dataset.page===name)),
    rows:()=>el('#node-rows').querySelectorAll('tr'),cards:()=>el('#agent-grid').querySelectorAll('.agent-card'),
    since:count=>requests.slice(count).map(request=>`${request.method} ${request.path}`)};
}

const node={id:'r1',name:'Movies',alias:'movies',tags:['4K'],notes:'',upstreams:['https://emby.example.com'],accessMode:'key',allowPrivate:false,tlsVerify:true,showOnHome:false,favorite:false,enabled:true,sortOrder:10,speedLimitMbps:0,monthlyQuotaGB:0,reminderDays:0,accessAlertThreshold:0,
  clientProfile:{enabled:true,userAgent:'Infuse-Direct/8.1.1',client:'Infuse',deviceName:'Infuse',deviceId:'d1'},streamRewrite:{enabled:false,domains:[]},autoSteer:{enabled:false,minRateMbps:0},egressAgentId:'',lineSync:true,lineSyncUpstream:false,syncLines:[]};
const dashboard=running=>({running,totalBytes:0,monthBytes:0,totalRequests:0,playbackRequests:0,active:0,daily:{},machines:[],nodes:[]});
const signedIn=(more={})=>({'GET /session':json({csrf:'token-1'}),'GET /routes':json({routes:[node]}),'GET /dashboard':json(dashboard(1)),'GET /events':{status:200,type:'text/event-stream',body:`event: dashboard\ndata: ${JSON.stringify(dashboard(5))}\n\n`},...more});

test('the panel finds its API beside its own script, resumes a session that is still good, and follows the live feed',async()=>{
  const ui=await start(signedIn());
  assert.deepEqual([...new Set(ui.requests.map(request=>request.prefix))],['/_aegis/api'],'every request goes to the API beside the script');
  assert.deepEqual(ui.since(0),['GET /branding','GET /session','GET /routes','GET /dashboard','GET /events']);
  assert.deepEqual([ui.shown('#app'),ui.shown('#auth')],[true,false]);
  // What was fetched is on the page: the node in the list, and the figures from the feed (not the first answer's).
  assert.ok(ui.el('#node-rows').innerHTML.includes('<strong>Movies</strong>'));
  assert.equal(ui.el('#m-running').textContent,'5 个运行中');
  // Once signed in, every request carries the session's token.
  assert.deepEqual(ui.requests.slice(2).map(request=>request.csrf),['token-1','token-1','token-1']);
});

test('signing in sends the password with one second factor: the code, or the recovery code once its field is the one showing',async()=>{
  const ui=await start({'GET /session':json({error:'unauthorized'},401),'GET /status':json({initialized:true}),'POST /login':json({csrf:'fresh'}),'GET /routes':json({routes:[]}),'GET /dashboard':json(dashboard(0))});
  assert.deepEqual([ui.shown('#auth'),ui.shown('#login'),ui.shown('#app'),ui.shown('#code-field'),ui.shown('#recovery-field')],[true,true,false,true,false]);
  Object.assign(ui.el('#password'),{value:'correct horse battery'});ui.el('#code').value='123456';ui.el('#recovery').value='left over';
  let sent=ui.requests.length;
  await ui.press('#login-btn');
  assert.deepEqual([ui.requests[sent].path,ui.requests[sent].body,ui.shown('#app')],['/login',{password:'correct horse battery',code:'123456'},true]);
  // The switch to a recovery code, and back.
  await ui.el('#recovery-toggle').onclick();
  assert.deepEqual([ui.shown('#code-field'),ui.shown('#recovery-field'),ui.el('#code').value,ui.el('#recovery').focused,ui.el('#recovery-toggle').textContent],[false,true,'',1,'改用动态验证码']);
  ui.el('#recovery').value=' \tAbC-dEf_1234 ';ui.el('#code').value='654321';
  sent=ui.requests.length;
  await ui.press('#login-btn');
  assert.deepEqual(ui.requests[sent].body,{password:'correct horse battery',recovery:'AbC-dEf_1234'},'the recovery code, trimmed, and no code from the hidden field');
  // A wrong password is said where the form is, and the form stays as it was.
  ui.answers['POST /login']=json({error:'invalid credentials'},401);
  await ui.press('#login-btn');
  assert.deepEqual([ui.el('#gate-msg').textContent,ui.shown('#recovery-field'),ui.shown('#code-field')],['invalid credentials',true,false]);
});

test('a session that has ended brings the sign-in form back',async()=>{
  const ui=await start(signedIn({'GET /audit':json({error:'unauthorized'},401)}));
  await assert.rejects(ui.go('audit'),/登录已失效/);
  assert.deepEqual([ui.shown('#app'),ui.shown('#auth'),ui.shown('#login'),ui.el('#gate-msg').textContent],[false,true,true,'登录已失效，请重新登录']);
  // The token went with the session.
  const sent=ui.requests.length;
  await ui.run('call("/status")');
  assert.equal(ui.requests[sent].csrf,null);
});

test('saving the node form sends what its controls hold: a switch as true or false, a new node with the machine to put it on',async()=>{
  const agents=json({agents:[{id:'local',name:'本机',domain:'emby.example.com'},{id:'hk',name:'HK',domain:'hk.example.com',proxyMode:'domain'}]});
  const ui=await start(signedIn({'GET /agents':agents,'POST /routes':json({route:node,publicBaseUrl:'https://emby.example.com',clientPath:'/new/k1/',accessKey:'k1'},201),'PATCH /routes/r1':json({route:node})}));
  // A new node: the form starts from its defaults, and the one other machine is chosen by itself.
  await ui.go('nodes');await ui.press(ui.all('.add-node')[0]);
  assert.deepEqual([ui.shown('#nodes-page'),ui.shown('#dashboard-page')],[true,false]);
  assert.deepEqual([ui.shown('#node-drawer'),ui.el('#form-title').textContent,ui.el('#access-mode').value,ui.el('#tls').value,ui.el('#line-sync-enabled').checked,ui.el('#profile-enabled').checked,ui.el('#deploy-agent').value],[true,'新增 Emby 节点','key','true',true,false,'hk']);
  Object.assign(ui.el('#name'),{value:'Fresh'});ui.el('#alias').value='fresh';ui.el('#upstreams').value='https://a.example.com\nhttps://b.example.com';ui.el('#private').value='true';ui.el('#speed-limit').value='25';
  ui.el('#profile-enabled').checked=true;ui.el('#line-sync-upstream').checked=true;
  let sent=ui.requests.length;
  await ui.press('#save-node');
  const created=ui.requests[sent];
  assert.deepEqual([created.method,created.path],['POST','/routes']);
  assert.deepEqual(created.body,{name:'Fresh',alias:'fresh',accessKey:'',tags:'',notes:'',upstreams:'https://a.example.com\nhttps://b.example.com',accessMode:'key',allowPrivate:true,tlsVerify:true,showOnHome:false,favorite:false,speedLimitMbps:25,monthlyQuotaGB:0,reminderDays:0,accessAlertThreshold:0,
    clientProfile:{enabled:true,userAgent:'',client:'',deviceName:'',deviceId:''},streamRewrite:{enabled:false,domains:''},autoSteer:{enabled:false,minRateMbps:0},egressAgentId:'',lineSync:true,lineSyncUpstream:true,agentId:'hk'});
  assert.deepEqual([ui.shown('#modal'),ui.el('#secret').textContent.includes('https://emby.example.com/new/k1/'),ui.shown('#node-drawer')],[true,true,false],'the new address is shown, and the form is closed');
  // An existing node: the controls show it, and saving it unchanged says nothing about how it is reached.
  await ui.press(ui.rows()[0].querySelector('.edit-node'));
  assert.deepEqual([ui.el('#form-title').textContent,ui.el('#name').value,ui.el('#tags').value,ui.el('#tls').value,ui.el('#profile-enabled').checked,ui.el('#profile-ua').value,ui.el('#line-sync-enabled').checked,ui.el('#line-sync-upstream').checked,ui.el('#access-key').value],
    ['编辑 · Movies','Movies','4K','true',true,'Infuse-Direct/8.1.1',true,false,'']);
  ui.el('#name').value='Renamed';
  sent=ui.requests.length;
  await ui.press('#save-node');
  const changed=ui.requests[sent];
  assert.deepEqual([changed.method,changed.path,changed.body.name,changed.body.clientProfile.enabled,changed.body.lineSync,'accessMode' in changed.body,'accessKey' in changed.body,'agentId' in changed.body],['PATCH','/routes/r1','Renamed',true,true,false,false,false]);
});

test('a node keeps what its form cannot show at once: the machine its traffic leaves from, chosen among options that arrive later',async()=>{
  // The options of that select are written from the machines, which may not be known yet when the form
  // opens; a select holds nothing it has no option for. A node from before notes existed has none.
  const {notes,...old}=node,agents=json({agents:[{id:'local',name:'本机',domain:'emby.example.com'},{id:'hk',name:'HK',domain:'hk.example.com',proxyMode:'domain'}]});
  const ui=await start(signedIn({'GET /routes':json({routes:[{...old,egressAgentId:'hk'}]}),'GET /agents':agents,'PATCH /routes/r1':json({route:node})}));
  await ui.go('nodes');await ui.press(ui.rows()[0].querySelector('.edit-node'));
  assert.deepEqual([ui.el('#steer-egress').value,ui.el('#notes').value,ui.el('#access-mode').value],['hk','','key']);
  const sent=ui.requests.length;
  await ui.press('#save-node');
  assert.deepEqual([ui.requests[sent].method,ui.requests[sent].body.egressAgentId,ui.requests[sent].body.notes],['PATCH','hk','']);
});

test('nothing that cannot be taken back happens without a yes',async()=>{
  const machine={id:'hk',name:'HK',transport:'poll',domain:'hk.example.com',proxyMode:'domain',status:'online',routeIds:[],lastSeen:null,applyState:'active',inSync:true,error:'',canDelete:true,agentVersion:'',domainChange:null};
  const address=key=>json({available:true,publicBaseUrl:'https://emby.example.com',clientPath:`/movies/${key}/`,accessKey:key});
  const ui=await start(signedIn({'GET /agents':json({panelVersion:'1',agents:[machine]}),'GET /routes/r1/credentials':address('old-key'),'POST /routes/r1/rotate-key':address('new-key'),'GET /account':json({username:'admin',totpEnabled:true,recoveryRemaining:3})}));
  await ui.go('nodes');
  const row=()=>ui.rows()[0],quiet=async(press,what)=>{const sent=ui.requests.length;await press();assert.deepEqual(ui.since(sent),[],what)};
  // The address is fetched once and remembered.
  await ui.press(row().querySelector('.addr-copy'));
  await quiet(()=>ui.press(row().querySelector('.addr-copy')),'a second copy asks for nothing');
  // A new key makes every client's address stop working: asked first, and a prompt that is cancelled changes nothing.
  ui.says.yes=false;await quiet(()=>ui.press(row().querySelector('.rotate-node')),'no to the question');
  ui.says.yes=true;ui.says.typed=null;await quiet(()=>ui.press(row().querySelector('.rotate-node')),'the prompt cancelled');
  ui.says.typed='chosen-key-123';
  let sent=ui.requests.length;
  await ui.press(row().querySelector('.rotate-node'));
  assert.deepEqual([ui.since(sent),ui.requests[sent].body,ui.el('#secret').textContent.includes('/movies/new-key/')],[['POST /routes/r1/rotate-key'],{accessKey:'chosen-key-123'},true]);
  // The address that was remembered is the old one: the next copy asks again.
  sent=ui.requests.length;
  await ui.press(row().querySelector('.addr-copy'));
  assert.deepEqual(ui.since(sent),['GET /routes/r1/credentials']);
  // Deleting a node, changing how it is reached, deleting a machine, switching two-step verification off.
  ui.says.yes=false;
  await quiet(()=>ui.press(row().querySelector('.delete-node')),'delete a node');
  await ui.press(row().querySelector('.edit-node'));ui.el('#access-mode').value='alias_only';
  await quiet(()=>ui.press('#save-node'),'open a node to anyone who knows its path');
  await ui.go('agents');
  await quiet(()=>ui.press(ui.cards()[0].querySelector('.delete-agent')),'delete a machine');
  await ui.go('account');
  await quiet(()=>ui.press('#totp-disable'),'switch two-step verification off');
  assert.deepEqual(ui.says.asked.slice(-4).map(question=>[/确认删除“Movies”/,/关闭连接密码后/,/确认从面板删除“HK”/,/关闭两步验证后/].findIndex(words=>words.test(question))),[0,1,2,3],'each of them was asked about, in its own words');
  // And with a yes, each does what it says.
  ui.says.yes=true;
  sent=ui.requests.length;
  await ui.press('#totp-disable');
  await ui.press('#save-node');
  await ui.go('agents');await ui.press(ui.cards()[0].querySelector('.delete-agent'));
  await ui.go('nodes');await ui.press(row().querySelector('.delete-node'));
  const did=ui.since(sent).filter(request=>!request.startsWith('GET '));
  assert.deepEqual(did,['POST /account/totp/disable','PATCH /routes/r1','DELETE /agents/hk','DELETE /routes/r1']);
  assert.equal(ui.requests.find(request=>request.method==='PATCH'&&request.path==='/routes/r1').body.accessMode,'alias_only');
});

test('a new machine is given the nodes that were ticked for it, and no others',async()=>{
  const ui=await start(signedIn({'GET /routes':json({routes:[node,{...node,id:'r2',name:'Shows',alias:'shows'},{...node,id:'r3',name:'Anime',alias:'anime'}]}),'GET /agents':json({agents:[]}),
    'POST /agents/enrollment':json({expiresAt:'2026-11-11T08:10:00Z',command:'curl … | sudo sh',uninstallCommand:''},201)}));
  await ui.go('agents');await ui.press('#add-agent');
  assert.deepEqual([ui.shown('#agent-modal'),ui.enrolBoxes().map(box=>box.dataset.enrollRoute)],[true,['r1','r2','r3']]);
  ui.el('#agent-name').value='HK 2';ui.el('#agent-domain-new').value='hk2.example.com';ui.enrolBoxes()[1].checked=true;
  const sent=ui.requests.length;
  await ui.press('#create-enrollment');
  assert.deepEqual([ui.requests[sent].path,ui.requests[sent].body,ui.el('#agent-command').textContent,ui.shown('#agent-command-wrap'),ui.shown('#agent-enroll-form')],['/agents/enrollment',{name:'HK 2',domain:'hk2.example.com',routeIds:['r2']},'curl … | sudo sh',true,false]);
});

test('the live feed is asked for again when it drops, and brings the sign-in form back when the session is over',async()=>{
  const dropped=await start(signedIn({'GET /events':{status:502,type:'text/html',body:'<html>Bad Gateway</html>'}}));
  assert.deepEqual([dropped.el('#live-state').innerHTML,dropped.timeouts.map(timer=>timer.ms)],['<i></i>重连中',[5000]]);
  dropped.answers['GET /events']=signedIn()['GET /events'];
  const sent=dropped.requests.length;
  await dropped.timeouts[0].fn();await dropped.settle();
  assert.deepEqual([dropped.since(sent),dropped.el('#m-running').textContent,dropped.timeouts.length],[['GET /events'],'5 个运行中',1]);
  const over=await start(signedIn({'GET /events':json({error:'unauthorized'},401)}));
  assert.deepEqual([over.shown('#auth'),over.shown('#app'),over.timeouts.length],[true,false,0]);
});

test('a machine card has two buttons that send two different things: its name and nodes, or its address',async()=>{
  // Sent together, a panel machine that only manages (no address of its own) could never have its nodes
  // changed: the panel refused the address and with it the whole change.
  const machine=(id,more)=>({id,name:id,transport:'poll',domain:`${id}.example.com`,proxyMode:'domain',status:'online',routeIds:['r1'],lastSeen:null,applyState:'active',inSync:true,error:'',canDelete:true,agentVersion:'',domainChange:null,...more});
  const ui=await start(signedIn({'GET /agents':json({panelVersion:'1.0.0',agents:[machine('local',{transport:'loopback',domain:'',routeIds:[]}),machine('hk')]})}));
  await ui.go('agents');
  const [local,hk]=ui.cards();
  assert.deepEqual([local.dataset.id,hk.dataset.id,hk.querySelector('.agent-name').value,hk.querySelector('.agent-domain').value],['local','hk','hk','hk.example.com']);
  hk.querySelector('.agent-name').value=' HK 2 ';
  let sent=ui.requests.length;
  await hk.querySelector('.save-agent').onclick();await ui.settle();
  assert.deepEqual([ui.requests[sent].method,ui.requests[sent].path,ui.requests[sent].body],['PATCH','/agents/hk',{name:'HK 2',routeIds:['r1']}],'the address is no part of a save');
  // The panel machine with no address: its nodes can still be saved.
  sent=ui.requests.length;
  await ui.press(ui.cards()[0].querySelector('.save-agent'));
  assert.deepEqual(ui.requests[sent].body,{name:'local',routeIds:[]});
  // The address button sends the address and nothing else; unchanged, it sends nothing.
  const [,again]=ui.cards();
  sent=ui.requests.length;
  await again.querySelector('.switch-domain').onclick();
  assert.deepEqual(ui.since(sent),[]);
  again.querySelector('.agent-domain').value=' new.example.com ';
  await again.querySelector('.switch-domain').onclick();await ui.settle();
  assert.deepEqual([ui.requests[sent].method,ui.requests[sent].path,ui.requests[sent].body],['PATCH','/agents/hk',{domain:'new.example.com'}]);
});

test('the steering page is drawn whole when it is opened, and only its live tables by the timer',async()=>{
  const steering=(excluded,client)=>json({settings:{mode:'shadow',excludedClients:[excluded],boundMB:64},machines:[],routes:[],entryCommands:[],live:{ranges:[{client,continued:8,trialContinued:0,state:'on'}]}});
  const ui=await start(signedIn({'GET /steering':steering('Infuse','VidHub')}));
  assert.deepEqual(ui.intervals.map(timer=>timer.ms),[5000],'the open page is refreshed on a timer');
  await ui.go('steering');
  assert.deepEqual([ui.el('#steering-excluded').value,ui.el('#steering-mode').value,ui.el('#steering-ranges').innerHTML.includes('VidHub')],['Infuse','shadow',true]);
  assert.match(ui.el('#steering-refresh').textContent,/更新于/);
  // Someone is changing a setting when the timer comes round with newer data.
  ui.el('#steering-excluded').value='Infuse\nRex (not saved yet)';
  ui.answers['GET /steering']=steering('Changed elsewhere','SenPlayer');
  let sent=ui.requests.length;
  await ui.intervals[0].fn();await ui.settle();
  assert.deepEqual([ui.since(sent),ui.el('#steering-excluded').value,ui.el('#steering-ranges').innerHTML.includes('SenPlayer')],[['GET /steering'],'Infuse\nRex (not saved yet)',true],'the live tables are new, the setting being typed is untouched');
  // Nobody is looking: no request is made.
  sent=ui.requests.length;
  ui.document.hidden=true;await ui.intervals[0].fn();ui.document.hidden=false;
  await ui.go('traffic');await ui.intervals[0].fn();await ui.settle();
  assert.deepEqual(ui.since(sent),[]);
  // Saving sends what the controls hold and draws the whole page from the answer.
  await ui.go('steering');
  ui.el('#steering-excluded').value='Rex';ui.el('#steering-bound').value='';ui.el('#steering-bound-auto').checked=true;
  ui.answers['PUT /steering']=steering('Rex','VidHub');
  sent=ui.requests.length;
  await ui.press('#save-steering');
  assert.deepEqual([ui.requests[sent].method,ui.requests[sent].body,ui.el('#steering-excluded').value],['PUT',{mode:'shadow',entryDomain:'',excludedClients:'Rex',boundedClients:'',boundMB:64,boundAuto:true},'Rex']);
});

test('the theme is applied before the page is painted, from what was saved or what the system prefers; the toggle saves under the same key',async()=>{
  const source=fs.readFileSync(new URL('../web/theme.js',import.meta.url),'utf8');
  const applied=(saved,prefersDark,storage=true)=>{
    const document={documentElement:{dataset:{}}};
    vm.runInNewContext(source,{document,window:{matchMedia:true},matchMedia:()=>({matches:prefersDark}),localStorage:{getItem:key=>{if(!storage)throw new Error('storage is blocked');return key==='aegis-theme'?saved:null}}});
    return document.documentElement.dataset.theme;
  };
  assert.deepEqual([applied('dark',false),applied('light',true),applied(null,true),applied(null,false),applied('purple',true),applied('dark',false,false),applied(null,true,false)],['dark','light','dark','light','dark','light','dark']);
  // It must not wait for anything: no module syntax, nothing fetched.
  assert.doesNotMatch(source.replace(/^\s*\/\/.*$/gm,''),/\b(import|export|fetch|await)\b/);
  const ui=await start(signedIn());
  assert.equal(ui.document.documentElement.dataset.theme,'light','app.js leaves the theme as it found it');
  ui.el('#theme-toggle').onclick();
  assert.deepEqual([ui.document.documentElement.dataset.theme,applied(ui.stored.get('aegis-theme'),false)],['dark','dark'],'what the toggle saved is what the next load applies');
});
