import crypto from 'node:crypto';
import { b64u, timingEqual, tokenDigest } from './security.js';

export const ROUTE_AUTH_VERSION = 'route-hmac-sha256-v1';
export const LEGACY_ROUTE_AUTH_VERSION = 'master-hmac-sha256-v1';

export function newRouteAuthKey() {
  return b64u(crypto.randomBytes(32));
}

export function isRouteAuthKey(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.length === 32 && decoded.toString('base64url') === value;
  } catch {
    return false;
  }
}

export function routeTokenDigest(token, routeAuthKey) {
  if (!isRouteAuthKey(routeAuthKey)) throw new Error('invalid routeAuthKey');
  return b64u(crypto.createHmac('sha256', Buffer.from(routeAuthKey, 'base64url')).update(String(token)).digest());
}

// The connection channels a key-mode node accepts: one labeled key per distributed user. A node
// created before channels existed carries a single key on the route itself — surface it as one
// implicit "default" channel so old nodes keep working unchanged.
export function routeChannels(route) {
  const list = [];
  // The node's primary key is always the "default" channel — this keeps every existing single-key
  // node working unchanged. Extra distribution channels (one labeled key per user) are additive.
  if (route?.keyDigest) list.push({ id: 'default', label: route.channelLabel || '默认', keyDigest: route.keyDigest, routeAuthKey: route.routeAuthKey, authVersion: route.authVersion, accessKey: route.accessKey });
  if (Array.isArray(route?.channels)) for (const ch of route.channels) if (ch?.keyDigest) list.push(ch);
  return list;
}
// matchRouteChannel runs on every proxied request and tries every channel. Decoding each stored key
// and digest from base64url (and re-encoding to validate it) cost more there than the HMAC itself, yet
// an encoded value always decodes to the same bytes, so the result is remembered. Only stored config
// values are ever looked up, never anything a client sends.
const DECODED_MAX = 16_384;
const decoded = new Map();
function decode32(value) {
  let bytes = decoded.get(value);
  if (bytes === undefined) {
    const raw = typeof value === 'string' ? Buffer.from(value, 'base64url') : null;
    bytes = raw?.length === 32 && raw.toString('base64url') === value ? raw : null;
    if (decoded.size >= DECODED_MAX) decoded.clear();
    decoded.set(value, bytes);
  }
  return bytes;
}
function channelAccepts(channel, suppliedToken, legacyMasterKey) {
  if (!channel?.keyDigest) return false;
  const routeKey = channel.authVersion === ROUTE_AUTH_VERSION ? decode32(channel.routeAuthKey) : null;
  if (routeKey) {
    const digest = crypto.createHmac('sha256', routeKey).update(String(suppliedToken)).digest(), expected = decode32(channel.keyDigest);
    return expected ? crypto.timingSafeEqual(digest, expected) : timingEqual(b64u(digest), channel.keyDigest);
  }
  if ((!channel.authVersion || channel.authVersion === LEGACY_ROUTE_AUTH_VERSION) && legacyMasterKey) {
    return timingEqual(tokenDigest(String(suppliedToken), legacyMasterKey), channel.keyDigest);
  }
  return false;
}
// Return the channel a supplied key unlocks (so access can be attributed to that user), or null.
// Every channel is checked so timing does not reveal which one matched.
export function matchRouteChannel(route, suppliedToken, legacyMasterKey = null) {
  let matched = null;
  for (const channel of routeChannels(route)) if (channelAccepts(channel, suppliedToken, legacyMasterKey)) matched = channel;
  return matched;
}
export function verifyRouteToken(route, suppliedToken, legacyMasterKey = null) {
  return !!matchRouteChannel(route, suppliedToken, legacyMasterKey);
}
