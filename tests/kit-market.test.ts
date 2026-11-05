import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { NativeKitMarkets } from '../desktop/main/kits/market-native';
import { parseKitInstallLink } from '../desktop/shared/kit-install-link';
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const releaseId = '638db5e1-b2f2-4b12-952f-0aff3e85bb90';
async function fixture(desktop = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kit-market-boundary-')); roots.push(root);
  const trace = path.join(root, 'trace.jsonl'), executable = path.join(root, 'installer');
  const script = `#!/usr/bin/env node\nconst fs=require('fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(a)+'\\n');let value;if(a[0]==='--capabilities')value={format_version:1,control_protocol:'kit-control-hmac-v1',features:${JSON.stringify(['market.pinned-source.v1','host.spawn-proof.v1', ...(desktop ? ['desktop.original-sdk.v1'] : [])])}};else if(a[2]==='fetch')value={kit_id:'fixture/pkg',version:'1.0.0',bundle:${JSON.stringify(path.join(root, 'private-bundle.json'))},profiles:['basic']};else if(a[2]==='plan')value={digest:'a'.repeat(64),can_commit:true,plan:{id:'operation',permissions:{board:{read_roots:['store']}},install:{components:[]},desktop:[],projections:[],skills:[{}]}};else if(a[2]==='list')value={};else value={committed:true};process.stdout.write(JSON.stringify(value));\n`;
  await writeFile(executable, script, { mode: 0o700 });
  const file = path.join(root, 'kit-markets.json'); await writeFile(file, JSON.stringify({ format_version: 1, installer: { file: executable, sha256: createHash('sha256').update(script).digest('hex') }, markets: [{ id: 'private', label: 'Private independent Root', state: root }] }), { mode: 0o600 });
  let context = 'profile-owner-heart-A', allowed = false, confirms = 0;
  const service = new NativeKitMarkets(file, () => context, async () => { confirms++; return allowed; });
  const calls = async () => (await readFile(trace, 'utf8')).trim().split('\n').map(s => JSON.parse(s) as string[]);
  return { service, calls, allow: () => { allowed = true; }, change: () => { context = 'foreign-heart-B'; }, confirms: () => confirms, file, executable };
}
it('release links only select already configured market and exact UUID, rejecting extra authority or credentials', () => {
  expect(parseKitInstallLink(`portal-kit://install?market=private&release=${releaseId}`)).toEqual({ marketId: 'private', releaseId });
  for (const input of [`portal-kit://user:token@install?market=private&release=${releaseId}`, `portal-kit://install?market=private&release=${releaseId}&root=attacker`, `portal-kit://install?market=private&market=other&release=${releaseId}`, `portal-kit://install?market=private&release=${releaseId}#token`, 'https://market.test/release', 'portal-kit://install/path?market=x&release=x']) expect(parseKitInstallLink(input)).toBeNull();
});
it('does no commit before native confirmation, cancellation retains ticket, and confirm uses the frozen native digest', async () => {
  const f = await fixture(), preview = await f.service.previewMarketRelease({ marketId: 'private', releaseId });
  expect('ticket' in preview).toBe(true); if (!('ticket' in preview)) return;
  expect((await f.calls()).some(args => args[2] === 'commit')).toBe(false);
  expect(await f.service.confirmMarketRelease(preview.ticket)).toEqual({ installed: false });
  expect((await f.calls()).some(args => args[2] === 'commit')).toBe(false);
  f.allow(); expect((await f.service.confirmMarketRelease(preview.ticket)).installed).toBe(true);
  expect((await f.calls()).filter(args => args[2] === 'commit')).toEqual([['--state', path.dirname(f.file), 'commit', '--operation', 'operation', '--digest', 'a'.repeat(64)]]);
  await expect(f.service.confirmMarketRelease(preview.ticket)).rejects.toThrow('preview_expired'); expect(f.confirms()).toBe(2);
});
it('rejects extra renderer Root/path/confirmation fields and foreign market before fetch, and invalidates old Heart ticket', async () => {
  const f = await fixture();
  for (const extra of [{ root: {} }, { bundle: '/tmp/arbitrary' }, { token: 'fake' }, { confirmed: true }]) await expect(f.service.previewMarketRelease({ marketId: 'private', releaseId, ...extra } as any)).rejects.toThrow('selection_invalid');
  await expect(f.service.previewMarketRelease({ marketId: 'foreign', releaseId })).rejects.toThrow('market_not_configured');
  expect((await f.calls()).every(args => args[0] === '--capabilities')).toBe(true);
  const preview = await f.service.previewMarketRelease({ marketId: 'private', releaseId }); if (!('ticket' in preview)) throw new Error('fixture plan missing'); f.change(); f.allow();
  await expect(f.service.confirmMarketRelease(preview.ticket)).rejects.toThrow('preview_expired'); expect(f.confirms()).toBe(0);
});
it('refuses a replaced installer before executing any changed binary', async () => {
  const f = await fixture(); await writeFile(f.executable, '#!/bin/sh\nexit 77\n', { mode: 0o700 });
  await expect(f.service.kitMarkets()).rejects.toThrow('installer_changed');
});
it('recovery is scoped to one configured store and requires native confirmation without committing a pending preview', async () => {
  const f = await fixture(); expect(await f.service.recoverMarket('private')).toBe(false); expect((await f.calls()).some(args => args[2] === 'recover')).toBe(false);
  f.allow(); expect(await f.service.recoverMarket('private')).toBe(true);
  expect((await f.calls()).filter(args => args[2] === 'recover')).toEqual([['--state', path.dirname(f.file), 'recover']]);
  expect((await f.calls()).some(args => args[2] === 'commit')).toBe(false);
  await expect(f.service.recoverMarket('foreign')).rejects.toThrow('market_not_configured');
});

it('keeps Linux market and pure content preview available with an A-only installer', async () => {
  const f = await fixture(false); vi.spyOn(os, 'platform').mockReturnValue('linux');
  expect(await f.service.kitMarkets()).toHaveLength(1);
  const preview = await f.service.previewMarketRelease({ marketId: 'private', releaseId }); expect('ticket' in preview).toBe(true);
  expect((await f.calls()).some(args => args[2] === 'commit')).toBe(false);
});
