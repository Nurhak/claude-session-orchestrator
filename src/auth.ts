// Request authentication. No caller is trusted by network address: loopback is shared by every
// process on the host and is what a DNS-rebinding browser page arrives from.
import { createHmac, createPublicKey, timingSafeEqual, verify, type KeyObject } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const eq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const bearer = (req: IncomingMessage) => (req.headers.authorization ?? '').replace(/^Bearer /, '');

/** `Authorization: Bearer <token>` matches `token` (an unset token never matches). */
export const tokenOk = (req: IncomingMessage, token: string | undefined) => !!token && eq(bearer(req), token);

/**
 * Per-machine hook token: HMAC-SHA256(EVENTS_TOKEN, machine id). Each machine only holds its own,
 * so a hook sender is bound to one machine and cannot speak for another.
 */
export const machineToken = (eventsToken: string, machine: string) =>
  createHmac('sha256', eventsToken).update(machine).digest('hex');

export const machineTokenOk = (req: IncomingMessage, eventsToken: string | undefined, machine: string) =>
  !!eventsToken && !!machine && eq(bearer(req), machineToken(eventsToken, machine));

// Cloudflare Access JWT (header Cf-Access-Jwt-Assertion), for requests arriving through the tunnel.
let keys: { at: number; byKid: Map<string, KeyObject> } | undefined;

async function accessKey(certsUrl: string, kid: string): Promise<KeyObject | undefined> {
  // Refetch hourly, or on an unknown kid (key rotation) at most once a minute.
  const stale = !keys || Date.now() - keys.at > 3600_000 || (!keys.byKid.has(kid) && Date.now() - keys.at > 60_000);
  if (stale) {
    try {
      const r = await fetch(certsUrl, { signal: AbortSignal.timeout(5000) });
      const { keys: jwks } = await r.json() as { keys: { kid: string; [k: string]: unknown }[] };
      keys = { at: Date.now(), byKid: new Map(jwks.map((k) => [k.kid, createPublicKey({ key: k as never, format: 'jwk' })])) };
    } catch (e) {
      console.error('Cloudflare Access certs fetch failed:', (e as Error).message);
    }
  }
  return keys?.byKid.get(kid);
}

/** Verifies an RS256 Cloudflare Access JWT: signature, audience, issuer, expiry. Fails closed. */
export async function accessJwtOk(req: IncomingMessage, env = process.env): Promise<boolean> {
  const team = env.CF_ACCESS_TEAM_DOMAIN, aud = env.CF_ACCESS_AUD;
  const jwt = req.headers['cf-access-jwt-assertion'];
  if (!team || !aud || typeof jwt !== 'string') return false;
  const [h, p, s] = jwt.split('.');
  if (!h || !p || !s) return false;
  try {
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return false;
    const key = await accessKey(env.CF_ACCESS_CERTS_URL ?? `https://${team}/cdn-cgi/access/certs`, header.kid);
    if (!key || !verify('sha256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))) return false;
    const now = Date.now() / 1000;
    return [claims.aud].flat().includes(aud) && claims.iss === `https://${team}` &&
      typeof claims.exp === 'number' && claims.exp > now && (claims.nbf ?? 0) <= now + 60;
  } catch {
    return false;
  }
}

/** Test hook: forget cached Access keys. */
export const resetAccessKeys = () => { keys = undefined; };
