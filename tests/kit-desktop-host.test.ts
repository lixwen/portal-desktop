import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PluginRegistry, readPlugin } from '../desktop/main/plugins/registry';
import { LocalApps } from '../desktop/main/app/local-apps';
import { DesktopKitHost } from '../desktop/main/kits/desktop-host';
import { protocolDigest, type DesktopHostRequest, type DesktopTargetPolicy } from '../desktop/main/kits/desktop-host-contract';
import type { DesktopControlPeer } from '../desktop/main/kits/control-server';
const originalPlatform = process.platform;
const roots: string[] = [];
const fault = vi.hoisted(() => ({ target: '' }));
vi.mock('node:fs/promises', async importOriginal => { const actual = await importOriginal<typeof import('node:fs/promises')>(); return { ...actual, rename: async (from: string, to: string) => {
  if (to === fault.target) throw Object.assign(new Error('fixture_write_failure'), { code: 'EIO' }); return actual.rename(from, to);
} }; });
afterEach(async () => { Object.defineProperty(process, 'platform', { value: originalPlatform }); vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kit-desktop-host-')); roots.push(root);
  const source = path.join(root, 'source'); await mkdir(source);
  const manifest = { schemaVersion: 1, apiVersion: 1, minSdkVersion: '1.4.0', id: 'fixture.board', version: '1.0.0', name: 'Fixture', author: 'Fixture', description: 'Fixture', entry: 'index.html', capabilities: ['storage'], contributes: { views: [{ id: 'main', title: 'Main' }] } };
  await writeFile(path.join(source, 'desktop.plugin.json'), JSON.stringify(manifest)); await writeFile(path.join(source, 'index.html'), '<h1>Fixture</h1>');
  const registry = new PluginRegistry(path.join(root, 'plugins'));
  const apps = new LocalApps(path.join(root, 'apps.json'));
  const context = { owner_id: 'owner', heart_id: 'heart', target_id: 'desktop-B', authority: 'local' as const };
  const policy: DesktopTargetPolicy = { context, executor: 'desktop_plugin_host', controllerToken: 'i'.repeat(40), consumerToken: 'p'.repeat(40), generation: 1, policyRevision: 1,
    roots: { fixture: root }, allowedPluginCapabilities: ['storage'], readRoots: ['fixture'], writeRoots: [], networkHosts: [] };
  const peer: DesktopControlPeer = { context, role: 'kit-controller', channelId: 'channel', rpcId: 1 };
  let ready = true;
  const file = path.join(root, 'host.json');
  const options = { policies: [policy], registry, apps, adapter: () => undefined, ledger: async () => { throw new Error('no_ledger'); }, closePlugin() {}, currentEndpoint: () => '', readyTimeoutMs: 40,
    openPlugin: async (id: string, view: string) => { if (ready) { const session = await registry.open(id, view); await registry.markReady(session.token); } } };
  const host = new DesktopKitHost(file, options); await host.load();
  const files = Object.fromEntries(await Promise.all(['desktop.plugin.json', 'index.html'].map(async name => { const bytes = await readFile(path.join(source, name)); return [name, { size_bytes: bytes.length, digest: createHash('sha256').update(bytes).digest('hex'), path: { root_id: 'fixture', relative_path: `source/${name}` } }]; })));
  const request: DesktopHostRequest = { plan: { format_version: 1, operation_id: 'operation1', owner_user_id: 'owner', installation_id: 'installation', component_instance_id: 'board', release_id: 'release1', target_id: 'desktop-B', generation: 1, revision: 1, policy_revision: 1,
    required_features: ['desktop.plugin.sdk.v1'], trust: 'user_computer', permissions: { read_roots: ['fixture'], write_roots: [], network_hosts: [] }, files,
    payload: { executor: 'desktop_plugin_host', plugin_id: manifest.id, manifest: { root_id: 'fixture', relative_path: 'source/desktop.plugin.json' } } }, expected_plan_digest: '',
    provenance: { root_digest: 'a'.repeat(64), kit_id: 'fixture/board', release_id: 'release1', artifact_digest: 'b'.repeat(64), closure_digest: 'c'.repeat(64), expires_at_unix_seconds: 2_000_000_000 } };
  request.expected_plan_digest = protocolDigest(request.plan);
  const prepare = async () => { const preview = await host.dispatch(peer, 'desktop/host/preview', request) as any; request.expected_preview_digest = preview.preview_digest; return host.dispatch(peer, 'desktop/host/prepare', request) as Promise<any>; };
  const call = (method: string, value: any) => host.dispatch(peer, method, { installation_id: 'installation', component_instance_id: 'board', expected_sequence: value.receipt.sequence });
  return { root, source, registry, apps, policy, peer, host, request, prepare, call, file, options, notReady: () => { ready = false; } };
}
it('binds confirmed preview to real original files and observes SDK ready before receipt, then resets Ready after replacement', async () => {
  const f = await fixture();
  const preview = await f.host.dispatch(f.peer, 'desktop/host/preview', f.request) as any;
  expect(preview.detail.added_capabilities).toEqual(['storage']); expect(preview.detail.sdk).toBeTruthy();
  await expect(f.host.dispatch(f.peer, 'desktop/host/prepare', f.request)).rejects.toThrow('preview_confirmation');
  const prepared = await f.prepare(); expect(prepared.receipt.state).toBe('prepared');
  expect((await f.registry.list()).plugins[0].enabled).toBe(false);
  const ready = await f.call('desktop/host/ready', prepared) as any; expect(ready.receipt.state).toBe('ready');
  const restarted = new DesktopKitHost(f.file, f.options); await restarted.load();
  const status = await restarted.dispatch(f.peer, 'desktop/host/status', {}) as any;
  expect(status[0].receipt.state).toBe('prepared'); expect(status[0].registered).toBe(false);
  await expect(restarted.dispatch({ ...f.peer, context: { ...f.peer.context, owner_id: 'foreign' } }, 'desktop/host/status', {})).rejects.toThrow('scope_rejected');
});
it('SDK timeout fails closed and uninstall preserves private data and source tombstone', async () => {
  const f = await fixture(); f.notReady(); const prepared = await f.prepare();
  await expect(f.call('desktop/host/ready', prepared)).rejects.toThrow('ready_timeout');
  expect((await f.registry.list()).plugins[0].enabled).toBe(false);
  const status = await f.host.dispatch(f.peer, 'desktop/host/status', {}) as any;
  const removed = await f.call('desktop/host/uninstall', status[0]) as any; expect(removed.receipt.state).toBe('stopped');
  expect((await f.registry.list()).plugins).toHaveLength(0);
  expect(JSON.parse(await readFile(path.join(f.root, 'plugins/ownership/fixture.board.json'), 'utf8')).managed).toBe(true);
});
it('external references require exact original digest and never enable an owner-disabled plugin', async () => {
  const f = await fixture(), bundle = await readPlugin(f.source);
  await f.registry.install(bundle, { kind: 'local' }); await f.registry.setEnabled(bundle.manifest.id, false);
  f.request.external_reference = true; f.request.expected_plugin_digest = bundle.sha256;
  const prepared = await f.prepare(); await expect(f.call('desktop/host/ready', prepared)).rejects.toThrow('requires_owner_enable');
  await f.call('desktop/host/uninstall', prepared); expect((await f.registry.list()).plugins[0].source.kind).toBe('local'); expect((await f.registry.list()).plugins[0].enabled).toBe(false);
});
it('rejects source drift, undeclared original html and impersonated full endpoint before catalog', async () => {
  const f = await fixture(); const preview = await f.host.dispatch(f.peer, 'desktop/host/preview', f.request) as any;
  f.request.expected_preview_digest = preview.preview_digest; await writeFile(path.join(f.source, 'index.html'), '<h1>Changed</h1>');
  await expect(f.host.dispatch(f.peer, 'desktop/host/prepare', f.request)).rejects.toThrow('file_changed');
  await expect(f.host.dispatch({ ...f.peer, role: 'kit-consumer' }, 'desktop/plugins/catalog', {})).rejects.toThrow('endpoint_unavailable');
});
it('exposes original plugin identity and digest only to the fixed installer scope for explicit reference selection', async () => {
  const f = await fixture(), bundle = await readPlugin(f.source); await f.registry.install(bundle, { kind: 'local' });
  expect(await f.host.dispatch(f.peer, 'desktop/plugins/inspect', { plugin_id: bundle.manifest.id })).toEqual({ plugin_id: bundle.manifest.id, digest: bundle.sha256, enabled: true, source: 'local' });
  await expect(f.host.dispatch(f.peer, 'desktop/plugins/inspect', { plugin_id: bundle.manifest.id, path: f.source })).rejects.toThrow('selection_invalid');
  await expect(f.host.dispatch({ ...f.peer, role: 'kit-consumer' }, 'desktop/plugins/inspect', { plugin_id: bundle.manifest.id })).rejects.toThrow();
});
it('reports only an actual existing App association and invalidates it after removal without claiming OS installation', async () => {
  const f = await fixture(), file = path.join(f.root, 'chosen-app'); await writeFile(file, 'explicitly chosen program'); await f.apps.associate({ id: 'app.local', name: 'Chosen app' }, file);
  const policy = { ...f.policy, executor: 'os_app' as const, context: { ...f.policy.context, target_id: 'desktop-C' } }, peer = { ...f.peer, context: policy.context };
  const host = new DesktopKitHost(path.join(f.root, 'app-host.json'), { ...f.options, policies: [policy] }); await host.load();
  const request = structuredClone(f.request); request.plan.target_id = 'desktop-C'; request.plan.payload = { executor: 'os_app', target: { mode: 'existing_association', association_id: 'app.local' } }; request.plan.required_features = ['apps.association.v1']; request.plan.files = {}; request.expected_plan_digest = protocolDigest(request.plan);
  const preview = await host.dispatch(peer, 'desktop/host/preview', request) as any; expect(preview.detail.version_verified).toBe(false); expect(preview.detail.owns_os_installation).toBe(false); request.expected_preview_digest = preview.preview_digest;
  expect((await host.dispatch(peer, 'desktop/host/prepare', request) as any).receipt.state).toBe('associated');
  await rm(file); const status = await host.dispatch(peer, 'desktop/host/status', {}) as any; expect(status[0].receipt.state).toBe('failed'); expect(status[0].failure).toBe('desktop_app_association_changed');
  expect((await f.apps.list())[0].exists).toBe(false);
});
it('recovers a lost prepare response from its durable journal without duplicate references', async () => {
  const f = await fixture(); const original = f.registry.stageManaged.bind(f.registry);
  f.registry.stageManaged = async (...args) => { await original(...args); throw new Error('simulated_process_loss_after_package_write'); };
  await expect(f.prepare()).rejects.toThrow('simulated_process_loss');
  f.registry.stageManaged = original;
  const recovered = new DesktopKitHost(f.file, f.options); await recovered.load();
  const prepared = await recovered.dispatch(f.peer, 'desktop/host/prepare', f.request) as any;
  expect(prepared.receipt.state).toBe('prepared'); expect(prepared.failure).toBeNull();
  const owner = JSON.parse(await readFile(path.join(f.root, 'plugins/ownership/fixture.board.json'), 'utf8'));
  expect(owner.references).toEqual([{ installationId: 'installation', componentId: 'board' }]);
  expect((await f.registry.list()).plugins).toHaveLength(1);
});
it('preserves user disable separately from installer stop and requires fresh explicit enable', async () => {
  const f = await fixture(); const prepared = await f.prepare(); await f.call('desktop/host/ready', prepared);
  await f.registry.setEnabled('fixture.board', false);
  const status = await f.host.dispatch(f.peer, 'desktop/host/status', {}) as any; expect(status[0].receipt.state).toBe('failed');
  f.request.plan.operation_id = 'explicit-enable'; f.request.plan.revision = 2; f.request.expected_plugin_digest = (await f.registry.list()).plugins[0].sha256; f.request.expected_plan_digest = protocolDigest(f.request.plan);
  const preview = await f.host.dispatch(f.peer, 'desktop/host/preview', f.request) as any; expect(preview.detail.requires_explicit_enable).toBe(true); f.request.expected_preview_digest = preview.preview_digest;
  const next = await f.host.dispatch(f.peer, 'desktop/host/prepare', f.request) as any;
  await expect(f.call('desktop/host/ready', next)).rejects.toThrow('user_disabled_requires_explicit_enable');
  const ready = await f.host.dispatch(f.peer, 'desktop/host/ready', { installation_id: 'installation', component_instance_id: 'board', expected_sequence: next.receipt.sequence, explicit_enable: true }) as any;
  expect(ready.receipt.state).toBe('ready');
});
it('recovers ownership-before-package write failure without replacing the original backup', async () => {
  const f = await fixture(); const v1 = await f.prepare(); await f.call('desktop/host/stop', v1);
  const old = (await f.registry.list()).plugins[0];
  const manifestFile = path.join(f.source, 'desktop.plugin.json'), manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  manifest.version = '2.0.0'; await writeFile(manifestFile, JSON.stringify(manifest));
  const bytes = await readFile(manifestFile); f.request.plan.files['desktop.plugin.json'].digest = createHash('sha256').update(bytes).digest('hex'); f.request.plan.files['desktop.plugin.json'].size_bytes = bytes.length;
  f.request.plan.operation_id = 'operation2'; f.request.plan.revision = 2; f.request.plan.release_id = 'release2'; f.request.provenance.release_id = 'release2';
  f.request.expected_plugin_digest = old.sha256; f.request.expected_plan_digest = protocolDigest(f.request.plan);
  const preview = await f.host.dispatch(f.peer, 'desktop/host/preview', f.request) as any; f.request.expected_preview_digest = preview.preview_digest;
  fault.target = path.join(f.root, 'plugins/packages/fixture.board.json');
  try { await expect(f.host.dispatch(f.peer, 'desktop/host/prepare', f.request)).rejects.toThrow(); }
  finally { fault.target = ''; }
  const backup = await readFile(path.join(f.root, 'plugins/backups/fixture.board.managed.json'), 'utf8');
  expect(JSON.parse(backup).original.manifest.version).toBe('1.0.0');
  const restarted = new DesktopKitHost(f.file, f.options); await restarted.load();
  const prepared = await restarted.dispatch(f.peer, 'desktop/host/prepare', f.request) as any; expect(prepared.failure).toBeNull();
  expect((await f.registry.list()).plugins[0].manifest.version).toBe('2.0.0');
  expect(await readFile(path.join(f.root, 'plugins/backups/fixture.board.managed.json'), 'utf8')).toBe(backup);
});

it('rejects installer-asserted Home authority before preview or original SDK preparation', async () => {
  const f = await fixture(); const policy = { ...f.policy, context: { ...f.policy.context, authority: 'home' as const } };
  const host = new DesktopKitHost(path.join(f.root, 'home-impostor.json'), { ...f.options, policies: [policy] }); await host.load();
  await expect(host.dispatch({ ...f.peer, context: policy.context }, 'desktop/host/preview', f.request)).rejects.toThrow('home_native_authenticated_channel_required');
  expect((await f.registry.list()).plugins).toEqual([]);
});

async function backupWithChangedData() {
  const f = await fixture();
  const originalRequest = structuredClone(f.request);
  const originalManifest = await readFile(path.join(f.source, 'desktop.plugin.json'));
  const originalHtml = await readFile(path.join(f.source, 'index.html'));
  const initialPrepared = await f.prepare();
  const original = (await f.registry.list()).plugins[0];
  const privateFile = path.join(f.root, 'plugins/data/fixture.board.json');
  const partition = path.join(f.root, 'plugins/agent-data/fixture.board', `${'a'.repeat(64)}.json`);
  const untouched = path.join(f.root, 'plugins/data/unrelated.json');
  const privateBytes = '{\n  "original": "private bytes",\n  "version": 1\n}\n';
  const partitionBytes = '{\n  "schemaVersion": 1, "revision": 1, "records": [], "events": [], "requests": [],\n  "preferences": { "guidance": "original partition", "focusId": null }\n}\n';
  await mkdir(path.dirname(privateFile), { recursive: true });
  await mkdir(path.dirname(partition), { recursive: true });
  await writeFile(privateFile, privateBytes); await writeFile(partition, partitionBytes);
  await writeFile(untouched, 'unrelated retained user bytes');
  await f.call('desktop/host/stop', initialPrepared);
  const manifest = JSON.parse(originalManifest.toString()); manifest.version = '2.0.0';
  const bytes = Buffer.from(JSON.stringify(manifest)); await writeFile(path.join(f.source, 'desktop.plugin.json'), bytes);
  const update = structuredClone(originalRequest);
  update.plan.operation_id = 'data-update2'; update.plan.revision = 2; update.plan.release_id = 'release2'; update.provenance.release_id = 'release2';
  update.plan.files['desktop.plugin.json'].digest = createHash('sha256').update(bytes).digest('hex');
  update.plan.files['desktop.plugin.json'].size_bytes = bytes.length;
  update.expected_plugin_digest = original.sha256; update.expected_plan_digest = protocolDigest(update.plan);
  const preview = await f.host.dispatch(f.peer, 'desktop/host/preview', update) as any;
  update.expected_preview_digest = preview.preview_digest;
  await f.host.dispatch(f.peer, 'desktop/host/prepare', update);
  const current = (await f.registry.list()).plugins[0];
  const backupFile = path.join(f.root, 'plugins/backups/fixture.board.managed.json');
  const backupText = await readFile(backupFile, 'utf8'), backup = JSON.parse(backupText);
  expect(backup.files['data/fixture.board.json']).toBe(privateBytes);
  expect(backup.files[`agent-data/fixture.board/${'a'.repeat(64)}.json`]).toBe(partitionBytes);
  const modifiedPrivate = '{"new":"post-update user change"}\n';
  const modifiedPartition = '{"new":"post-update partition"}\n';
  await writeFile(privateFile, modifiedPrivate); await writeFile(partition, modifiedPartition);
  await writeFile(path.join(f.source, 'desktop.plugin.json'), originalManifest);
  await writeFile(path.join(f.source, 'index.html'), originalHtml);
  const restoreRequest = async (revision: number, expectedDigest: string) => {
    const request = structuredClone(originalRequest);
    request.plan.operation_id = `data-restore${revision}`; request.plan.revision = revision;
    request.expected_plugin_digest = expectedDigest; request.expected_plan_digest = protocolDigest(request.plan);
    const preview = await f.host.dispatch(f.peer, 'desktop/host/preview', request) as any;
    request.expected_preview_digest = preview.preview_digest;
    return request;
  };
  const restore = async (request: DesktopHostRequest, restoreData?: boolean) => {
    const status = (await f.host.dispatch(f.peer, 'desktop/host/status', {}) as any)[0];
    return f.host.dispatch(f.peer, 'desktop/host/restore', { installation_id: 'installation', component_instance_id: 'board', expected_sequence: status.receipt.sequence, request, ...(restoreData === undefined ? {} : { restore_data: restoreData }) }) as Promise<any>;
  };
  return { ...f, current, original, privateFile, partition, privateBytes, partitionBytes, modifiedPrivate, modifiedPartition, untouched, backupFile, backupText, restoreRequest, restore };
}
it('restores exact backed-up private and Being bytes only after explicit restore_data consent while retaining source and user guards', async () => {
  const f = await backupWithChangedData();
  const request = await f.restoreRequest(3, f.current.sha256);
  const foreign = structuredClone(request); foreign.provenance.root_digest = 'f'.repeat(64);
  await expect(f.restore(foreign, true)).rejects.toThrow('plugin_origin_or_owner_conflict');
  const stale = structuredClone(request); stale.expected_plugin_digest = 'e'.repeat(64);
  await expect(f.restore(stale, true)).rejects.toThrow('plugin_expected_digest_changed');
  expect(await readFile(f.privateFile, 'utf8')).toBe(f.modifiedPrivate);
  expect((await f.registry.list()).plugins[0].sha256).toBe(f.current.sha256);
  const guarded = await f.restore(request);
  expect(guarded.requires_data_review).toBe(true); expect(guarded.private_data_restored).toBe(false);
  await expect(f.call('desktop/host/ready', guarded)).rejects.toThrow('desktop_host_not_prepared');
  expect(await readFile(f.privateFile, 'utf8')).toBe(f.modifiedPrivate);
  expect(await readFile(f.partition, 'utf8')).toBe(f.modifiedPartition);
  const confirmed = await f.restore(await f.restoreRequest(4, f.original.sha256), true);
  expect(confirmed.requires_data_review).toBe(false); expect(confirmed.private_data_restored).toBe(true);
  expect(await readFile(f.privateFile, 'utf8')).toBe(f.privateBytes);
  expect(await readFile(f.partition, 'utf8')).toBe(f.partitionBytes);
  expect(await readFile(f.untouched, 'utf8')).toBe('unrelated retained user bytes');
  expect(await readFile(f.backupFile, 'utf8')).toBe(f.backupText);
  expect((await f.registry.list()).plugins[0].sha256).toBe(f.original.sha256);
});
it('rejects a changed private backup origin or data digest without overwriting modified user data', async () => {
  const f = await backupWithChangedData();
  const request = await f.restoreRequest(3, f.current.sha256);
  const origin = JSON.parse(f.backupText); origin.ownership.origin.rootDigest = 'f'.repeat(64);
  await writeFile(f.backupFile, JSON.stringify(origin));
  await expect(f.restore(request, true)).rejects.toThrow('plugin_restore_backup_invalid');
  expect(await readFile(f.privateFile, 'utf8')).toBe(f.modifiedPrivate);
  const changed = JSON.parse(f.backupText); changed.files['data/fixture.board.json'] = '{"tampered":true}';
  await writeFile(f.backupFile, JSON.stringify(changed));
  await expect(f.restore(request, true)).rejects.toThrow('plugin_restore_backup_invalid');
  expect(await readFile(f.privateFile, 'utf8')).toBe(f.modifiedPrivate);
  expect(await readFile(f.partition, 'utf8')).toBe(f.modifiedPartition);
  expect(await readFile(f.untouched, 'utf8')).toBe('unrelated retained user bytes');
});
it('retains a new unbacked Being partition and keeps data review required after restoring only known snapshot files', async () => {
  const f = await backupWithChangedData();
  const added = path.join(path.dirname(f.partition), `${'b'.repeat(64)}.json`);
  const addedBytes = '{"postBackup":"another Being partition must be retained"}\n';
  await writeFile(added, addedBytes);
  const result = await f.restore(await f.restoreRequest(3, f.current.sha256), true);
  expect(await readFile(f.privateFile, 'utf8')).toBe(f.privateBytes);
  expect(await readFile(f.partition, 'utf8')).toBe(f.partitionBytes);
  expect(await readFile(added, 'utf8')).toBe(addedBytes);
  expect(result.private_data_restored).toBe(true);
  expect(result.requires_data_review).toBe(true);
  await expect(f.call('desktop/host/ready', result)).rejects.toThrow('desktop_host_not_prepared');
});

it('rejects new managed B/C on Linux before capability publication or host side effects', async () => {
  const f = await fixture(); const before = await readFile(f.file); const open = vi.spyOn(f.options, 'openPlugin');
  Object.defineProperty(process, 'platform', { value: 'linux' }); vi.spyOn(os, 'platform').mockReturnValue('linux');
  for (const method of ['desktop/host/capabilities', 'desktop/host/preview', 'desktop/host/prepare', 'desktop/host/ready', 'desktop/host/register', 'desktop/host/restore']) {
    await expect(f.host.dispatch(f.peer, method, f.request)).rejects.toThrow('unsupported_managed_desktop_platform');
  }
  expect(open).not.toHaveBeenCalled(); expect(await readFile(f.file)).toEqual(before); expect((await f.registry.list()).plugins).toEqual([]);
});

it('keeps Linux historical managed status stop and uninstall available without exposing a B catalog', async () => {
  const f = await fixture(); const prepared = await f.prepare(); const ready = await f.call('desktop/host/ready', prepared) as any;
  const data = path.join(f.root, 'plugins', 'data', 'fixture.board.json'), original = '{  "private": "kept" }\n';
  await mkdir(path.dirname(data), { recursive: true }); await writeFile(data, original, { mode: 0o600 });
  f.policy.beingEndpoint = 'https://heart.fixture.invalid/existing'; f.options.currentEndpoint = () => f.policy.beingEndpoint!;
  Object.defineProperty(process, 'platform', { value: 'linux' }); vi.spyOn(os, 'platform').mockReturnValue('linux');
  expect(await f.host.dispatch({ ...f.peer, role: 'kit-consumer' }, 'desktop/plugins/catalog', {})).toEqual({ tools: [] });
  await expect(f.host.dispatch({ ...f.peer, role: 'kit-consumer' }, 'desktop/plugins/call', {})).rejects.toThrow('unsupported_managed_desktop_platform');
  expect((await f.host.dispatch(f.peer, 'desktop/host/status', {}) as any[])).toHaveLength(1);
  const stopped = await f.call('desktop/host/stop', ready) as any; expect(stopped.receipt.state).toBe('stopped');
  const removed = await f.call('desktop/host/uninstall', stopped) as any; expect(removed.receipt.state).toBe('stopped');
  expect(await readFile(data, 'utf8')).toBe(original); expect((await f.registry.list()).plugins).toEqual([]);
});
