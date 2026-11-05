import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { HomeClient } from '../desktop/main/home/client';
// Actual local HTTP and callback sockets; SafeStorage is an explicit fixture.
const storage = { isEncryptionAvailable: () => true, encryptString: (v: string) => Buffer.from(`fixture-only:${v}`), decryptString: (v: Buffer) => { const t = v.toString(); if (!t.startsWith('fixture-only:')) throw new Error('bad fixture cipher'); return t.slice(13); } };
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
async function directory() { const p = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kit-home-oauth-'))); cleanup.push(() => rm(p, { recursive: true, force: true })); return p; }
async function callback(url: string, headers: Record<string, string> = {}) {
 return new Promise<number>((resolve, reject) => { const req = httpRequest(url, { headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); }); req.on('error', reject); req.end(); });
}
async function fixture(options: { denied?: boolean; pause?: Promise<void>; expires?: number; features?: unknown } = {}) {
 let authorization: URL; const requests: { path: string; method?: string; cookie?: string; origin?: string; authorization?: string; body: string }[] = [];
 const server = createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://localhost'); let body = ''; for await (const c of req) body += c;
  requests.push({ path: url.pathname, method: req.method, cookie: req.headers.cookie, origin: req.headers.origin, authorization: req.headers.authorization, body });
  const reply = (v: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
  if (url.pathname === '/home/native/client-config/being-desktop') return reply({ client_id: 'being-desktop', redirect_uris: ['http://127.0.0.1:47831/oauth/callback'], authorization_endpoint: `${base}/oauth2/auth`, token_endpoint: '/home/native/oauth/token', revocation_endpoint: '/home/native/oauth/revoke', audience: 'urn:being:home', ...(options.features === undefined ? {} : { features: options.features }) });
  if (url.pathname === '/home/native/oauth/token') {
   await options.pause;
   if (options.denied) return reply({ error: 'invalid_grant', error_description: 'DO_NOT_EXPOSE_SECRET' }, 400);
   const form = new URLSearchParams(body); expect(req.headers.cookie).toBeUndefined(); expect(req.headers.origin).toBeUndefined(); expect(form.get('client_id')).toBe('being-desktop');
   if (form.get('grant_type') === 'authorization_code') {
    expect(form.get('code')).toBe('fixture-code'); expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(authorization.searchParams.get('code_challenge')); expect(form.get('redirect_uri')).toBe('http://127.0.0.1:47831/oauth/callback');
   }
   return reply({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'Bearer', expires_in: options.expires ?? 3600 });
  }
  if (url.pathname === '/home/native/oauth/revoke') return reply({});
  if (url.pathname === '/home/v1/me/computer/desktop-ticket') return reply({ connect_url: '/home/desktop/connect?ticket=' + 'a'.repeat(64) });
  if (url.pathname === '/home/v1/me') { expect(req.headers.authorization).toBe('Bearer fixture-access'); return reply({ user: { id: 'fixture-owner' } }); }
  return reply({}, 404);
 });
 await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
 const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
 cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
 const dir = await directory();
 let onOpen: ((url: URL) => Promise<void>) | undefined;
 const client = new HomeClient(dir, storage, async value => { authorization = new URL(value); await onOpen?.(authorization); });
 await client.configure({ baseUrl: `${base}/home/`, clientId: 'being-desktop' });
 const complete = async (url: URL) => { const target = new URL('http://127.0.0.1:47831/oauth/callback'); target.searchParams.set('state', url.searchParams.get('state')!); target.searchParams.set('code', 'fixture-code'); expect(await callback(target.href)).toBe(200); };
 onOpen = complete;
 return { client, dir, base, requests, complete, opened: (fn: (url: URL) => Promise<void>) => { onOpen = fn; } };
}
describe.sequential('Home native OAuth security boundary', () => {
 it('uses real PKCE/callback socket and independent native HTTP, durably binds encrypted session to authority', async () => {
  const f = await fixture(); await f.client.login(); expect(f.client.state().signedIn).toBe(true);
  const secretState = f.client.state(); expect(JSON.stringify(secretState)).not.toMatch(/fixture-access|fixture-refresh/);
  expect(await f.client.request('/v1/me')).toEqual({ user: { id: 'fixture-owner' } });
  expect(f.requests.every(r => !r.cookie && !r.origin)).toBe(true);
  const reloaded = new HomeClient(f.dir, storage, async () => {}); await reloaded.load(); expect(reloaded.state().signedIn).toBe(true);
  await reloaded.withAccessToken(async s => { expect(s.accessToken).toBe('fixture-access'); expect(s.baseUrl).toBe(`${f.base}/home/`); });
  let invalidated = 0; const unsubscribe = reloaded.onSessionInvalidated(() => { invalidated++; });
  await reloaded.logout(); expect(invalidated).toBe(1); unsubscribe(); expect(reloaded.state().signedIn).toBe(false);
  const third = new HomeClient(f.dir, storage, async () => {}); await third.load(); expect(third.state().signedIn).toBe(false);
  expect(f.requests.filter(r => r.path.endsWith('/revoke')).length).toBe(2);
 });
 it('opens only the same-Home exact desktop ticket route without rejecting its required one-use query', async () => {
  const f = await fixture(); await f.client.login(); let opened = '';
  f.opened(async url => { opened = url.href; }); await f.client.openComputer();
  expect(opened).toBe(`${f.base}/home/desktop/connect?ticket=${'a'.repeat(64)}`); await f.client.logout();
 });
 it('rejects foreign Host, Origin, wrong state and absolute callback without consuming the legitimate flow', async () => {
  const f = await fixture(); f.opened(async url => {
   const target = new URL('http://127.0.0.1:47831/oauth/callback'); target.searchParams.set('state', url.searchParams.get('state')!); target.searchParams.set('code', 'fixture-code');
   expect(await callback(target.href, { Host: 'rebind.invalid:47831' })).toBe(400);
   expect(await callback(target.href, { Origin: 'https://foreign.invalid' })).toBe(400);
   expect(await callback(target.href.replace(url.searchParams.get('state')!, 'wrong-state'))).toBe(400);
   expect(f.requests.filter(r => r.path.endsWith('/token')).length).toBe(0);
   await f.complete(url);
  }); await f.client.login(); expect(f.client.state().signedIn).toBe(true); await f.client.logout();
 });
 it('rejects authority retargeting of an otherwise valid encrypted session', async () => {
  const f = await fixture(); await f.client.login(); const file = path.join(f.dir, 'home-session.json'); const saved = JSON.parse(await readFile(file, 'utf8')); saved.config.baseUrl = 'https://foreign.invalid/home/'; await writeFile(file, JSON.stringify(saved), { mode: 0o600 });
  const reloaded = new HomeClient(f.dir, storage, async () => {}); await reloaded.load(); expect(reloaded.state().signedIn).toBe(false); expect(reloaded.state().warning).toBeTruthy();
  expect(f.requests.filter(r => r.authorization).length).toBe(0); await f.client.logout();
 });
 it('rejects readable or symlinked session files without touching their targets', async () => {
  const f = await fixture(); await f.client.login(); const file = path.join(f.dir, 'home-session.json'); await chmod(file, 0o644);
  const reloaded = new HomeClient(f.dir, storage, async () => {}); await reloaded.load(); expect(reloaded.state().signedIn).toBe(false);
  const original = await readFile(file); const target = path.join(f.dir, 'not-a-session'); await writeFile(target, original, { mode: 0o600 }); await rm(file); await symlink(target, file);
  await reloaded.load(); expect(reloaded.state().signedIn).toBe(false); expect(await readFile(target)).toEqual(original); await f.client.logout(); expect(await readFile(target)).toEqual(original);
 });
 it('does not leak bearer credentials through absolute, escaped or path-prefix traversal requests', async () => {
  const f = await fixture(); await f.client.login(); const before = f.requests.length;
  for (const relative of ['https://foreign.invalid/', '//foreign.invalid/', '/../v1/me', '/%2e%2e/v1/me', '/\\foreign.invalid', '/v1/me#fragment']) await expect(f.client.request(relative)).rejects.toThrow();
  for (const header of ['Cookie', 'Origin', 'Authorization', 'Proxy-Authorization']) await expect(f.client.raw('/v1/me', { headers: { [header]: 'fixture-only' } })).rejects.toThrow('invalid_native_home_header');
  expect(f.requests.length).toBe(before); await f.client.logout();
 });
 it('cancellation racing token exchange revokes unseen issued credentials and cannot persist a session', async () => {
  let release!: () => void; const pause = new Promise<void>(resolve => { release = resolve; }); const f = await fixture({ pause });
  const pending = f.client.login(); const rejection = expect(pending).rejects.toThrow();
  for (let i = 0; i < 100 && !f.requests.some(r => r.path.endsWith('/token')); i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(f.requests.some(r => r.path.endsWith('/token'))).toBe(true); f.client.cancelLogin(); release(); await rejection;
  expect(f.client.state().signedIn).toBe(false); expect(f.requests.filter(r => r.path.endsWith('/revoke')).length).toBe(2);
  expect(JSON.parse(await readFile(path.join(f.dir, 'home-session.json'), 'utf8')).credential).toBeUndefined();
 });
 it('sanitizes upstream OAuth error descriptions and rejects plaintext legacy credentials', async () => {
  const f = await fixture({ denied: true }); await expect(f.client.login()).rejects.toThrow('invalid_grant'); expect(f.client.state().signedIn).toBe(false);
  const file = path.join(f.dir, 'home-session.json'); await writeFile(file, JSON.stringify({ config: f.client.state(), credential: storage.encryptString(JSON.stringify({ access_token: 'old-credential', expires_at: Date.now() + 99999 })).toString('base64') }), { mode: 0o600 });
  const reloaded = new HomeClient(f.dir, storage, async () => {}); await reloaded.load(); expect(reloaded.state().signedIn).toBe(false); expect(JSON.stringify(reloaded.state())).not.toContain('old-credential');
 });
});

describe('main-only native Home software negotiation', () => {
 it('uses exact configured prefix/client discovery and treats omitted features as old Home', async () => {
  const old = await fixture(); expect(await old.client.nativeFeatures()).toEqual([]);
  const current = await fixture({ features: ['kit.host-device-display-name.v1'] });
  expect(await current.client.nativeFeatures()).toEqual(['kit.host-device-display-name.v1']);
  const copy = await current.client.nativeFeatures(); (copy as string[]).push('caller-mutated');
  expect(await current.client.nativeFeatures()).toEqual(['kit.host-device-display-name.v1']);
  expect(current.requests.map(r => r.path)).toEqual(['/home/native/client-config/being-desktop']);
  expect(current.requests.every(r => !r.authorization && !r.cookie && !r.origin)).toBe(true);
 });
 it('rejects malformed feature claims without authenticating or sending a host registration', async () => {
  for (const features of [true, [1], ['bad\nfeature'], ['x'.repeat(129)], Array(65).fill('known')]) {
   const f = await fixture({ features }); await expect(f.client.nativeFeatures()).rejects.toThrow('invalid_home_native_features');
   expect(f.requests).toHaveLength(1);
  }
 });
});
