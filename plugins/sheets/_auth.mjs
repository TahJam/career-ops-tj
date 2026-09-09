// @ts-check
// Service-account auth for the sheets plugin.
//
// Mints a short-lived access token from the JSON key with a self-signed RS256
// JWT (the "JWT bearer" flow) — ~40 lines of node:crypto instead of pulling in
// googleapis, which would be the heaviest dependency in the project. Mirrors
// plugins/gmail/index.mjs, which does the same exchange against the same host.
//
// HTTP goes through ctx.fetch so the engine's allowedHosts + SSRF guard runs.

import { existsSync, readFileSync } from 'fs';
import { createSign } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOKEN_HOST = 'oauth2.googleapis.com';

export const SCOPE_READ = 'https://www.googleapis.com/auth/spreadsheets.readonly';
export const SCOPE_WRITE = 'https://www.googleapis.com/auth/spreadsheets';

/**
 * Resolve GOOGLE_AUTH_PATH to a key file on disk.
 *
 * Accepts absolute, repo-root-relative, and parent-of-root-relative forms. The
 * last is not hypothetical: the value shipped as "career-ops/auth/..." at one
 * point, which is the path as seen from the directory ABOVE the repo.
 *
 * @param {string} raw
 * @returns {string} absolute path to an existing file
 */
export function resolveKeyPath(raw) {
  const value = String(raw ?? '').trim().replace(/^(['"])(.*)\1$/, '$2');
  if (!value) throw new Error('GOOGLE_AUTH_PATH is empty — point it at your service-account JSON key.');
  const candidates = path.isAbsolute(value)
    ? [value]
    : [path.resolve(ROOT, value), path.resolve(ROOT, '..', value)];
  const hit = candidates.find(c => existsSync(c));
  if (!hit) throw new Error(`GOOGLE_AUTH_PATH "${value}" not found (looked in ${candidates.join(', ')})`);
  return hit;
}

/**
 * Read and shape-check the service-account key.
 * @param {string} keyPath
 */
export function loadServiceAccount(keyPath) {
  let key;
  try { key = JSON.parse(readFileSync(keyPath, 'utf8')); }
  catch (err) { throw new Error(`cannot parse service-account key at ${keyPath}: ${err.message}`); }
  for (const field of ['client_email', 'private_key', 'token_uri']) {
    if (typeof key[field] !== 'string' || !key[field]) {
      throw new Error(`service-account key at ${keyPath} is missing "${field}"`);
    }
  }
  const host = new URL(key.token_uri).hostname;
  // The key names its own token endpoint; pin it to the declared allowedHosts
  // so a swapped key file cannot redirect the credential exchange elsewhere.
  if (host !== TOKEN_HOST) throw new Error(`service-account token_uri host "${host}" is not ${TOKEN_HOST}`);
  return key;
}

const b64url = (input) =>
  Buffer.from(typeof input === 'string' ? input : JSON.stringify(input)).toString('base64url');

/**
 * Mint an access token for one scope. Cached per (client_email, scope) for the
 * life of the process, refreshed 60s before expiry.
 *
 * @param {{ env: Record<string,string>, fetch: Function }} ctx
 * @param {string} scope
 * @returns {Promise<string>}
 */
const tokenCache = new Map();
export async function getAccessToken(ctx, scope = SCOPE_READ) {
  const key = loadServiceAccount(resolveKeyPath(ctx?.env?.GOOGLE_AUTH_PATH));
  const cacheKey = `${key.client_email}|${scope}`;
  const hit = tokenCache.get(cacheKey);
  if (hit && hit.expiresAt - 60_000 > Date.now()) return hit.token;

  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: key.client_email, scope, aud: key.token_uri, iat: now, exp: now + 3600 };
  const signingInput = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(claims)}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(key.private_key, 'base64url');

  const res = await ctx.fetch(key.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${signingInput}.${signature}`,
    }).toString(),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('token exchange returned no access_token');
  tokenCache.set(cacheKey, { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 });
  return data.access_token;
}

/** Test seam: drop cached tokens. */
export function _clearTokenCache() { tokenCache.clear(); }
