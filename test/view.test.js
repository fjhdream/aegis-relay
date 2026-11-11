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
