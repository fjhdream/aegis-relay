import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeNodes, encodeNodes } from '../src/node-wire.js';
import { canonicalJson } from '../src/canonical-json.js';

// Every block a node can carry, plus fields that must never travel (tags, notes, panel-only switches)
// and a channel that is not fully set up.
const KEY='A'.repeat(43),CH=Buffer.alloc(32,7).toString('base64url');
const nodes=[
  {id:'n1',alias:'movie',name:'Movie',enabled:true,upstreams:['https://emby.example.net','https://emby2.example.net'],allowPrivate:false,tlsVerify:true,showOnHome:true,accessMode:'key',authVersion:'route-hmac-sha256-v1',routeAuthKey:KEY,keyDigest:'digest-1',channels:[{id:'c1',label:'friend',authVersion:'route-hmac-sha256-v1',routeAuthKey:CH,keyDigest:'digest-c1'},{id:'bad',authVersion:'x'}],clientProfile:{enabled:true,userAgent:'UA',client:'Emby Web',deviceName:'',deviceId:'d1',extra:'x'},streamRewrite:{enabled:true,domains:[' VOD.example.net ','']},speedLimitMbps:'20',monthlyQuotaGB:500,
   steering:{mode:'on',peers:[{id:'local',base:'https://panel.example.com'},{id:'hk',base:'https://hk.example.com'}],params:{minRateMbps:8,anyLine:true}},playbackObservation:true,egress:{id:'jp',base:'https://jp.example.com'},lines:[{name:'香港',base:'https://hk.example.com'}],lineSyncUpstream:true,tags:['a'],notes:'n',favorite:true,sortOrder:3,autoSteer:{enabled:true},egressAgentId:'jp',lineSync:true,createdAt:'2026-01-01T00:00:00.000Z'},
  {id:'n2',alias:'open',enabled:false,upstream:'http://10.0.0.5:8096',allowPrivate:true,tlsVerify:false,accessMode:'alias_only',steering:{mode:'shadow',peers:[],params:{}},lines:[]},
  {id:'n0',alias:'zeta',name:'Zeta',upstreams:['https://z.example.net'],accessMode:'key',authVersion:'route-hmac-sha256-v1',routeAuthKey:KEY,keyDigest:'digest-z',lineSyncUpstream:true}
];

// What the panel signed and what a machine served, for these nodes, before node-wire.js existed. A
// change here changes every machine's snapshot hash, so it is never incidental.
const ENCODED="[{\"access\":{\"algorithm\":\"route-hmac-sha256-v1\",\"digest\":\"digest-z\",\"mode\":\"key\",\"routeAuthKey\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"},\"alias\":\"zeta\",\"allowPrivate\":false,\"clientProfile\":{\"enabled\":false},\"enabled\":true,\"id\":\"n0\",\"monthlyQuotaGB\":0,\"name\":\"Zeta\",\"showOnHome\":false,\"speedLimitMbps\":0,\"streamRewrite\":{\"domains\":[],\"enabled\":false},\"tlsVerify\":true,\"upstreams\":[\"https://z.example.net\"]},{\"access\":{\"algorithm\":\"route-hmac-sha256-v1\",\"channels\":[{\"digest\":\"digest-c1\",\"id\":\"c1\",\"routeAuthKey\":\"BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc\"}],\"digest\":\"digest-1\",\"mode\":\"key\",\"routeAuthKey\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"},\"alias\":\"movie\",\"allowPrivate\":false,\"clientProfile\":{\"client\":\"Emby Web\",\"deviceId\":\"d1\",\"enabled\":true,\"userAgent\":\"UA\"},\"egress\":{\"base\":\"https://jp.example.com\",\"id\":\"jp\"},\"enabled\":true,\"id\":\"n1\",\"lineSyncUpstream\":true,\"lines\":[{\"base\":\"https://hk.example.com\",\"name\":\"香港\"}],\"monthlyQuotaGB\":500,\"name\":\"Movie\",\"playbackObservation\":true,\"showOnHome\":true,\"speedLimitMbps\":20,\"steering\":{\"mode\":\"on\",\"params\":{\"anyLine\":true,\"minRateMbps\":8},\"peers\":[{\"base\":\"https://panel.example.com\",\"id\":\"local\"},{\"base\":\"https://hk.example.com\",\"id\":\"hk\"}]},\"streamRewrite\":{\"domains\":[\"vod.example.net\"],\"enabled\":true},\"tlsVerify\":true,\"upstreams\":[\"https://emby.example.net\",\"https://emby2.example.net\"]},{\"access\":{\"mode\":\"alias_only\"},\"alias\":\"open\",\"allowPrivate\":true,\"clientProfile\":{\"enabled\":false},\"enabled\":false,\"id\":\"n2\",\"lines\":[],\"monthlyQuotaGB\":0,\"name\":\"open\",\"showOnHome\":false,\"speedLimitMbps\":0,\"steering\":{\"mode\":\"shadow\",\"params\":{\"minRateMbps\":0},\"peers\":[]},\"streamRewrite\":{\"domains\":[],\"enabled\":false},\"tlsVerify\":false,\"upstreams\":[\"http://10.0.0.5:8096\"]}]";
const DECODED="[{\"accessMode\":\"key\",\"alias\":\"zeta\",\"allowPrivate\":false,\"authVersion\":\"route-hmac-sha256-v1\",\"clientProfile\":{\"enabled\":false},\"enabled\":true,\"id\":\"n0\",\"keyDigest\":\"digest-z\",\"monthlyQuotaGB\":0,\"name\":\"Zeta\",\"routeAuthKey\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\",\"showOnHome\":false,\"speedLimitMbps\":0,\"streamRewrite\":{\"domains\":[],\"enabled\":false},\"tlsVerify\":true,\"upstreams\":[\"https://z.example.net\"]},{\"accessMode\":\"key\",\"alias\":\"movie\",\"allowPrivate\":false,\"authVersion\":\"route-hmac-sha256-v1\",\"channels\":[{\"authVersion\":\"route-hmac-sha256-v1\",\"id\":\"c1\",\"keyDigest\":\"digest-c1\",\"routeAuthKey\":\"BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc\"}],\"clientProfile\":{\"client\":\"Emby Web\",\"deviceId\":\"d1\",\"enabled\":true,\"userAgent\":\"UA\"},\"egress\":{\"base\":\"https://jp.example.com\",\"id\":\"jp\"},\"enabled\":true,\"id\":\"n1\",\"keyDigest\":\"digest-1\",\"lineSyncUpstream\":true,\"lines\":[{\"base\":\"https://hk.example.com\",\"name\":\"香港\"}],\"monthlyQuotaGB\":500,\"name\":\"Movie\",\"playbackObservation\":true,\"routeAuthKey\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\",\"showOnHome\":true,\"speedLimitMbps\":20,\"steering\":{\"mode\":\"on\",\"params\":{\"anyLine\":true,\"minRateMbps\":8},\"peers\":[{\"base\":\"https://panel.example.com\",\"id\":\"local\"},{\"base\":\"https://hk.example.com\",\"id\":\"hk\"}]},\"streamRewrite\":{\"domains\":[\"vod.example.net\"],\"enabled\":true},\"tlsVerify\":true,\"upstreams\":[\"https://emby.example.net\",\"https://emby2.example.net\"]},{\"accessMode\":\"alias_only\",\"alias\":\"open\",\"allowPrivate\":true,\"clientProfile\":{\"enabled\":false},\"enabled\":false,\"id\":\"n2\",\"lines\":[],\"monthlyQuotaGB\":0,\"name\":\"open\",\"showOnHome\":false,\"speedLimitMbps\":0,\"steering\":{\"mode\":\"shadow\",\"params\":{\"minRateMbps\":0},\"peers\":[]},\"streamRewrite\":{\"domains\":[],\"enabled\":false},\"tlsVerify\":false,\"upstreams\":[\"http://10.0.0.5:8096\"]}]";

test('the wire format is byte-for-byte what it was before the codec existed',()=>{
  const encoded=encodeNodes(nodes);
  assert.equal(canonicalJson(encoded),ENCODED);
  assert.equal(canonicalJson(decodeNodes(encoded)),DECODED);
  assert.equal(canonicalJson(encodeNodes(decodeNodes(encoded))),ENCODED,'a decoded node encodes back to the same bytes');
});

test('a malformed known block rejects the whole snapshot; an unknown block is ignored',()=>{
  const encoded=()=>structuredClone(encodeNodes(nodes)),movie=list=>list.find(node=>node.alias==='movie');
  const bad=[
    [list=>{movie(list).steering.peers[0].base='http://panel.example.com'},/invalid steering peer/],
    [list=>{movie(list).egress.base='https://jp.example.com/path'},/invalid egress machine/],
    [list=>{movie(list).lines[0].base='javascript:alert(1)'},/invalid line/],
    [list=>{movie(list).upstreams=['ftp://emby.example.net']},/invalid route upstream/],
    [list=>{movie(list).upstreams=['https://emby.example.net/?x=1']},/invalid route upstream/],
    [list=>{movie(list).upstreams=[]},/requires at least one upstream/],
    [list=>{movie(list).access.routeAuthKey='short'},/incomplete route authentication/],
    [list=>{movie(list).access.channels[0].routeAuthKey='short'},/invalid channel/],
    [list=>{delete movie(list).access},/no access block/],
    [list=>{movie(list).alias='Bad Alias'},/invalid node alias/],
    [list=>{list[0].alias='movie'},/duplicate node alias/],
    [list=>{list.push(...Array.from({length:100},(_,i)=>({...list[2],id:`m${i}`,alias:`m${i}`})))},/invalid route count/]
  ];
  for(const [corrupt,message] of bad){const list=encoded();corrupt(list);assert.throws(()=>decodeNodes(list),message,String(message));}
  const newer=encoded();
  movie(newer).futureBlock={x:1};movie(newer).steering.params.futureParam=2;
  const route=decodeNodes(newer).find(item=>item.alias==='movie');
  assert.equal('futureBlock' in route,false);assert.deepEqual(route.steering.params,{minRateMbps:8,anyLine:true});
});

test('the panel will not sign what a machine would refuse',()=>{
  const one=extra=>[{id:'p1',alias:'plain',upstreams:['https://emby.example.net'],accessMode:'alias_only',...extra}];
  assert.equal(encodeNodes(one()).length,1);
  assert.throws(()=>encodeNodes(one({upstreams:['https://user:pass@emby.example.net']})),/invalid route upstream/);
  assert.throws(()=>encodeNodes(one({alias:'UPPER'})),/invalid node alias/);
  assert.throws(()=>encodeNodes(one({steering:{mode:'on',peers:[{id:'',base:'https://hk.example.com'}]}})),/invalid steering peer/);
  assert.throws(()=>encodeNodes(Array.from({length:101},(_,i)=>one({id:`p${i}`,alias:`p${i}`})[0])),/invalid route count/);
  assert.throws(()=>encodeNodes(one({accessMode:'key',authMigrationRequired:true})),/access-key rotation/);
});
