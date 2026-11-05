import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NativeHomeKitHost } from '../desktop/main/home/kit-host';
import type { HomeClient } from '../desktop/main/home/client';
import { DesktopHostFacts, desktopCapabilities } from '../desktop/main/kits/host-facts';
import { durablePrivateJson } from '../desktop/main/kits/durable-file';
import { parseConnection } from '../desktop/main/chat/connection';
import type { Settings } from '../desktop/shared/types';
const roots: string[] = [], hosts: NativeHomeKitHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.stop(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function until(test: () => Promise<boolean>) { const deadline = Date.now() + 3000; while (!await test()) { if (Date.now() > deadline) throw new Error('condition_timeout'); await new Promise(r => setTimeout(r, 10)); } }
async function fixture(options: { confirm?: () => Promise<boolean>; features?: string[] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kit-home-host-')); roots.push(root);
  const observed = { ...desktopCapabilities('desktop_plugin_host'), executor: 'portal_mcp', features: ['home.authority-channel.v1', 'runtime.plan.v1', 'native_entry.admission.v1', 'host.spawn-proof.v1'], external: {} };
  const file = path.join(root, 'fixture-host'), marker = path.join(root, 'spawn.json');
  // A unit boundary executable, never represented as actual Portal acceptance.
  const script = `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);if(a.includes('--kit-runtime-capabilities')){console.log(JSON.stringify({format_version:1,executor:'portal_mcp',control_protocol:'kit-control-hmac-v1',features:${JSON.stringify(options.features || observed.features)}}));}else if(a.includes('--kit-configured-host-facts')){console.log(JSON.stringify(${JSON.stringify(observed)}));}else{fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({args:a,env:process.env}));setInterval(()=>{},1000);}\n`;
  await writeFile(file, script, { mode: 0o700 });
  const hash = createHash('sha256').update(script).digest('hex');
  await durablePrivateJson(path.join(root, 'kit-home-host.json'), { format_version: 1, policy_revision: 1, runtimes: { fixture: { file, sha256: hash } }, development_portal: { file, sha256: hash } });
  const me = { user: { id: 'owner', status: 'active' }, username: 'fixture-user', being: { id: 'profile', owner_user_id: 'owner' } };
  const requests: { url: string; body: any }[] = []; let invalidated = () => {};
  const home = { state: () => ({ baseUrl: 'https://home.fixture.invalid/prefix/', clientId: 'native', signedIn: true }),
    onSessionInvalidated: (callback: () => void) => { invalidated = callback; return () => {}; },
    nativeFeatures: async () => [],
    withAccessToken: async (callback: any) => callback({ baseUrl: 'https://home.fixture.invalid/prefix/', clientId: 'native', accessToken: 'private-home-access' }),
    request: async (url: string, _method?: string, body?: any) => { requests.push({ url, body }); if (url === '/v1/me') return me; if (url.endsWith('/registrations')) return { target_id: 'server-owned-target', revision: 1, generation: 7, lease_expires_at: new Date(Date.now() + 60000).toISOString() }; return {}; },
  } as unknown as HomeClient;
  const settings = { permissionMode: 'full-access', kitsEnabled: true, allowExec: true, portalBinary: file } as Settings;
  const host = new NativeHomeKitHost({ directory: root, resources: root, packaged: false, home, facts: new DesktopHostFacts(path.join(root, 'identity.json')), settings: () => settings, connection: () => parseConnection('https://heart.fixture.invalid/existing/?token=private-heart'), confirm: options.confirm || (async () => true) }); hosts.push(host);
  return { root, marker, host, requests, settings, invalidated: () => invalidated() };
}
it('requires supported managed Home software before confirmation or component process launch', async () => {
  let confirmed = false; const f = await fixture({ features: ['runtime.plan.v1'], confirm: async () => { confirmed = true; return true; } });
  await expect(f.host.start()).rejects.toThrow('home_host_feature_unsupported'); expect(confirmed).toBe(false);
  expect(f.requests.filter(r => r.url !== '/v1/me')).toEqual([]); await expect(stat(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('cancellation does not import Heart, enroll target, materialize token or start code', async () => {
  const f = await fixture({ confirm: async () => false }); expect((await f.host.start()).phase).toBe('stopped');
  expect(f.requests.filter(r => r.url !== '/v1/me')).toEqual([]); await expect(stat(f.marker)).rejects.toMatchObject({ code: 'ENOENT' }); await expect(stat(path.join(f.root, 'kit-home'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('uses server-owned enrollment and a separate private access file, then stops and deletes it on session invalidation', async () => {
  const f = await fixture(); const state = await f.host.start(); expect(state).toMatchObject({ phase: 'running', targetId: 'server-owned-target', generation: 7 });
  await until(async () => stat(f.marker).then(() => true, () => false));
  const child = JSON.parse(await readFile(f.marker, 'utf8')); expect(JSON.stringify(child.env)).not.toContain('private-home-access'); expect(JSON.stringify(child.env)).not.toContain('private-heart'); expect(JSON.stringify(child.args)).not.toContain('private-heart');
  const [identity] = await readdir(path.join(f.root, 'kit-home')); const directory = path.join(f.root, 'kit-home', identity), token = path.join(directory, 'home-access.json');
  expect(JSON.parse(await readFile(token, 'utf8'))).toEqual({ format_version: 1, home_url: 'https://home.fixture.invalid/prefix/', owner_id: 'owner', access_token: 'private-home-access' }); expect((await stat(token)).mode & 0o777).toBe(0o600);
  const config = await readFile(path.join(directory, 'portal.toml'), 'utf8'); expect(config).toContain('target_id="server-owned-target"'); expect(config).toContain('generation=7'); expect(config).not.toContain('private-home-access'); expect(config).not.toContain('home_control_token');
  f.invalidated(); await until(async () => f.host.state().phase === 'stopped'); await expect(stat(token)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('rejects a settings switch during native confirmation before importing or enrolling', async () => {
  let mutate = () => {}; const f = await fixture({ confirm: async () => { mutate(); return true; } }); mutate = () => { f.settings.permissionMode = 'read-only'; };
  await expect(f.host.start()).rejects.toThrow('home_host_context_changed'); expect(f.requests.filter(r => r.url !== '/v1/me')).toEqual([]); await expect(stat(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
});
