import test from 'node:test';
import assert from 'node:assert/strict';
import { isRouteAuthKey, matchRouteChannel, newRouteAuthKey, ROUTE_AUTH_VERSION, routeChannels, routeTokenDigest, verifyRouteToken } from '../src/route-auth.js';

test('multiple distribution channels each unlock the node and are attributed to their own key', () => {
  const primary=newRouteAuthKey(), userKey=newRouteAuthKey();
  const route={ authVersion:ROUTE_AUTH_VERSION, routeAuthKey:primary, keyDigest:routeTokenDigest('owner-key',primary),
    channels:[{ id:'ch-xm', label:'小明', authVersion:ROUTE_AUTH_VERSION, routeAuthKey:userKey, keyDigest:routeTokenDigest('xiaoming-key',userKey) }] };
  // both the default (owner) key and the extra channel key are accepted
  assert.equal(verifyRouteToken(route,'owner-key'),true);
  assert.equal(verifyRouteToken(route,'xiaoming-key'),true);
  assert.equal(verifyRouteToken(route,'wrong-key'),false);
  // and each is attributed to the right channel id
  assert.equal(matchRouteChannel(route,'owner-key').id,'default');
  assert.equal(matchRouteChannel(route,'xiaoming-key').id,'ch-xm');
  assert.equal(matchRouteChannel(route,'nope'),null);
  // legacy single-key node still surfaces as one default channel
  assert.equal(routeChannels({keyDigest:routeTokenDigest('k',primary),routeAuthKey:primary,authVersion:ROUTE_AUTH_VERSION})[0].id,'default');
});

test('route authentication keys are independent 256-bit secrets', () => {
  const first=newRouteAuthKey(),second=newRouteAuthKey();
  assert.equal(isRouteAuthKey(first),true);
  assert.equal(Buffer.from(first,'base64url').length,32);
  assert.notEqual(first,second);
  assert.equal(routeTokenDigest('client-key',first),routeTokenDigest('client-key',first));
  assert.notEqual(routeTokenDigest('client-key',first),routeTokenDigest('client-key',second));
  assert.equal(verifyRouteToken({authVersion:ROUTE_AUTH_VERSION,routeAuthKey:first,keyDigest:routeTokenDigest('client-key',first)},'client-key'),true);
});

test('malformed route authentication keys are rejected', () => {
  assert.equal(isRouteAuthKey('short'),false);
  assert.throws(()=>routeTokenDigest('client-key','short'),/invalid routeAuthKey/);
});

test('every channel of a full node is matched to its own key and nothing else', () => {
  const primary=newRouteAuthKey(),channels=Array.from({length:32},(_,i)=>{const k=newRouteAuthKey();return {id:`ch-${i}`,authVersion:ROUTE_AUTH_VERSION,routeAuthKey:k,keyDigest:routeTokenDigest(`user-${i}`,k)}});
  const route={authVersion:ROUTE_AUTH_VERSION,routeAuthKey:primary,keyDigest:routeTokenDigest('owner',primary),channels};
  for(let round=0;round<2;round++){ // the second round runs entirely on remembered key bytes
    assert.equal(matchRouteChannel(route,'owner').id,'default');
    for(let i=0;i<32;i++)assert.equal(matchRouteChannel(route,`user-${i}`).id,`ch-${i}`);
    assert.equal(matchRouteChannel(route,'user-32'),null);
    assert.equal(matchRouteChannel(route,''),null);
  }
});

test('a malformed key or a non-canonical digest never unlocks a channel', () => {
  const key=newRouteAuthKey(),digest=routeTokenDigest('client',key);
  assert.equal(verifyRouteToken({authVersion:ROUTE_AUTH_VERSION,routeAuthKey:'short',keyDigest:digest},'client'),false);
  assert.equal(verifyRouteToken({authVersion:ROUTE_AUTH_VERSION,routeAuthKey:`${key}A`,keyDigest:digest},'client'),false);
  // The last base64url character carries two padding bits; a sloppy decoder maps several spellings to
  // the same bytes. The stored digest must match exactly as it always did, not merely decode alike.
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const lookalike=[...alphabet].map(ch=>digest.slice(0,-1)+ch).find(v=>v!==digest&&Buffer.from(v,'base64url').equals(Buffer.from(digest,'base64url')));
  assert.ok(lookalike,'a non-canonical spelling of the digest exists');
  assert.equal(verifyRouteToken({authVersion:ROUTE_AUTH_VERSION,routeAuthKey:key,keyDigest:lookalike},'client'),false);
  assert.equal(verifyRouteToken({authVersion:ROUTE_AUTH_VERSION,routeAuthKey:key,keyDigest:digest},'client'),true);
});
