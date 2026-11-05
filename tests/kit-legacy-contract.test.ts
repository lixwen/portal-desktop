import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { captureInPlaceApp, captureInPlacePlugin, legacyExecutor, planExternalPluginReference } from '../desktop/main/kits/legacy-contract';
import { PluginRegistry, readPlugin } from '../desktop/main/plugins/registry';
import { LocalApps } from '../desktop/main/app/local-apps';

const temporary: string[] = [];
afterEach(async () => { for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kit-legacy-contract-')); temporary.push(root);
  const source = path.join(root, 'source'); await mkdir(source);
  const manifest = { schemaVersion: 1, apiVersion: 1, minSdkVersion: '1.5.0', id: 'example.guide', name: 'Guide',
    description: 'Compatibility fixture', author: 'Fixture', version: '1.0.0', entry: 'index.html', capabilities: ['storage'],
    contributes: { views: [{ id: 'main', title: 'Guide' }], commands: [{ id: 'open', title: 'Open', view: 'main' }] } };
  await writeFile(path.join(source, 'desktop.plugin.json'), JSON.stringify(manifest));
  await writeFile(path.join(source, 'index.html'), '<h1>Fixture</h1>');
  const registry = new PluginRegistry(path.join(root, 'plugins'));
  const bundle = await readPlugin(source);
  await registry.install(bundle, { kind: 'grove', id: 'legacy-guide' });
  return { root, source, manifest, registry };
}

it('maps historical kind and string/object plugin tags to their actual executor', () => {
  expect(legacyExecutor({ kind: 'kit' })).toBe('portal_mcp');
  expect(legacyExecutor({ kind: 'plugin' })).toBe('desktop_plugin_host');
  expect(legacyExecutor({ kind: 'app', tags: ['PLUGIN'] })).toBe('desktop_plugin_host');
  expect(legacyExecutor({ kind: 'app', tags: [{ name: 'plugin' }] })).toBe('desktop_plugin_host');
  expect(legacyExecutor({ kind: 'app', tags: ['other'] })).toBe('os_app');
  expect(() => legacyExecutor({ kind: 'unknown' })).toThrow('unsupported_legacy_kind');
});

it('preserves actual installed SDK, layout, data, disabled state and original source without writing', async () => {
  const { root, registry } = await fixture();
  await registry.setPlacement('example.guide', 'main', 'window');
  const session = await registry.open('example.guide', 'main');
  await registry.call(session.token, 'storage.patch', { preserved: 'private value' });
  await registry.setEnabled('example.guide', false);
  const packageFile = path.join(root, 'plugins/packages/example.guide.json');
  const dataFile = path.join(root, 'plugins/data/example.guide.json');
  const before = await Promise.all([readFile(packageFile), readFile(dataFile)]);
  const installed = (await registry.list()).plugins[0];
  const snapshot = captureInPlacePlugin(installed, { profileId: 'profile-one', beingEndpoint: 'https://fixture.invalid/being-one' });
  expect(snapshot.original).toEqual(installed);
  expect(snapshot.original.placements).toEqual({ main: 'window' });
  expect(snapshot.original.manifest.minSdkVersion).toBe('1.5.0');
  expect(snapshot.privateData).toBe('data/example.guide.json');
  expect(snapshot.state).toBe('disabled');
  const plan = planExternalPluginReference(snapshot, { pluginId: installed.manifest.id, source: installed.source,
    sha256: installed.sha256, originalSourceConfirmed: true });
  expect(plan).toMatchObject({ ownsInstallation: false, enableOnReference: false, state: 'disabled', unlink: 'keep_installation_and_data' });
  expect(await Promise.all([readFile(packageFile), readFile(dataFile)])).toEqual(before);
  await expect(registry.call(session.token, 'storage.load')).rejects.toThrow();
  snapshot.original.placements!.main = 'page';
  expect((await registry.list()).plugins[0].placements).toEqual({ main: 'window' });
});

it('keeps private data per plugin and collaboration data partitioned by Being endpoint', async () => {
  const { registry } = await fixture();
  const installed = (await registry.list()).plugins[0];
  const one = captureInPlacePlugin(installed, { profileId: 'profile', beingEndpoint: 'https://fixture.invalid/one' });
  const two = captureInPlacePlugin(installed, { profileId: 'profile', beingEndpoint: 'https://fixture.invalid/two' });
  expect(one.privateData).toBe(two.privateData);
  expect(one.collaborationData).not.toBe(two.collaborationData);
  expect(JSON.stringify(one)).not.toContain('https://fixture.invalid');
});

it('requires source confirmation and rejects same ID from another source or changed content', async () => {
  const { registry } = await fixture();
  const installed = (await registry.list()).plugins[0];
  const snapshot = captureInPlacePlugin(installed, { profileId: 'profile' });
  const evidence = { pluginId: installed.manifest.id, source: installed.source, sha256: installed.sha256, originalSourceConfirmed: true };
  expect(() => planExternalPluginReference(snapshot, { ...evidence, originalSourceConfirmed: false })).toThrow('legacy_source_confirmation_required');
  expect(() => planExternalPluginReference(snapshot, { ...evidence, source: { kind: 'local' } })).toThrow('legacy_source_conflict');
  expect(() => planExternalPluginReference(snapshot, { ...evidence, sha256: 'a'.repeat(64) })).toThrow('legacy_source_conflict');
  expect(() => captureInPlacePlugin({ ...installed, manifest: { ...installed.manifest, minSdkVersion: '9.0.0' as never } }, { profileId: 'profile' })).toThrow();
  expect(() => captureInPlacePlugin({ ...installed, placements: { main: 'invalid' as never } }, { profileId: 'profile' })).toThrow('invalid_legacy_placement');
});

it('keeps chosen App association and missing state without inferring installation or deleting program', async () => {
  const { root } = await fixture();
  const program = path.join(root, 'program'); await writeFile(program, 'program data');
  const apps = new LocalApps(path.join(root, 'local-apps.json'));
  await apps.associate({ id: 'old-app-id', name: 'Same visible name' }, program);
  const app = (await apps.list())[0];
  const snapshot = captureInPlaceApp(app, { profileId: 'profile' });
  expect(snapshot).toMatchObject({ executor: 'os_app', state: 'associated', unlink: 'keep_program_and_data', original: { id: 'old-app-id', path: program } });
  expect(snapshot).not.toHaveProperty('version'); expect(snapshot).not.toHaveProperty('installed');
  await apps.remove('old-app-id'); expect(await readFile(program, 'utf8')).toBe('program data');
  await apps.associate({ id: 'old-app-id', name: 'Same visible name' }, program);
  await rm(program);
  const missing = captureInPlaceApp((await apps.list())[0], { profileId: 'profile' });
  expect(missing.state).toBe('missing'); expect(missing.original.path).toBe(program);
});

it('retains origin after removal and rejects unknown source or changed local content taking retained data', async () => {
  const { root, registry, source } = await fixture();
  const installed = (await registry.list()).plugins[0];
  const session = await registry.open(installed.manifest.id, 'main');
  await registry.call(session.token, 'storage.patch', { secret: 'retained' });
  await registry.remove(installed.manifest.id);
  const bundle = await readPlugin(source);
  await expect(registry.install(bundle, { kind: 'grove', id: 'other-source' })).rejects.toThrow('legacy_source_conflict');
  expect(await readFile(path.join(root, 'plugins/data/example.guide.json'), 'utf8')).toContain('retained');
  await registry.install(bundle, installed.source);
  await registry.remove(installed.manifest.id);
  await expect(registry.install(bundle, { kind: 'local' })).rejects.toThrow('legacy_source_conflict');
});

it('keeps multiple external references and disabled state; managed legacy commands fail closed after unlink and restart', async () => {
  const { root, registry } = await fixture();
  const installed = (await registry.list()).plugins[0];
  await registry.setEnabled(installed.manifest.id, false);
  expect(await registry.referenceInstallation(installed.manifest.id, 'install-one', 'component', installed)).toMatchObject({ ownsInstallation: false, enabled: false });
  await registry.referenceInstallation(installed.manifest.id, 'install-two', 'component', installed);
  await registry.unlinkInstallation(installed.manifest.id, 'install-one', 'component');
  await expect(registry.remove(installed.manifest.id)).rejects.toThrow('仍被 Kit 引用');
  await registry.unlinkInstallation(installed.manifest.id, 'install-two', 'component');
  expect((await registry.list()).plugins[0].enabled).toBe(false);
  const reloaded = new PluginRegistry(path.join(root, 'plugins'));
  await expect(reloaded.agentCommand('https://fixture.invalid/being', JSON.stringify({ plugin: installed.manifest.id, op: 'describe' }))).rejects.toThrow();
  expect((await reloaded.list()).plugins).toHaveLength(1);
});

it('backs up reviewed update and restores package/layout/disabled state while retaining current private data', async () => {
  const { root, registry, source, manifest } = await fixture();
  await registry.setPlacement(manifest.id, 'main', 'window');
  const session = await registry.open(manifest.id, 'main');
  await registry.call(session.token, 'storage.patch', { kept: 'value' });
  await registry.setEnabled(manifest.id, false);
  const old = (await registry.list()).plugins[0];
  await writeFile(path.join(source, 'desktop.plugin.json'), JSON.stringify({ ...manifest, version: '2.0.0' }));
  const next = await readPlugin(source);
  await expect(registry.update(next, { kind: 'grove', id: 'wrong' }, old.sha256)).rejects.toThrow('legacy_source_conflict');
  expect((await registry.list()).plugins[0].sha256).toBe(old.sha256);
  await registry.update(next, old.source, old.sha256);
  expect((await registry.list()).plugins[0]).toMatchObject({ enabled: false, placements: { main: 'window' }, manifest: { version: '2.0.0' } });
  await registry.restoreUpdate(manifest.id);
  expect((await registry.list()).plugins[0]).toEqual(old);
  expect(await readFile(path.join(root, 'plugins/data/example.guide.json'), 'utf8')).toContain('value');
});

it('parent Kit unlink preserves app associations and program data; missing paths and explicit reselection use only stable ID', async () => {
  const { root } = await fixture();
  const file = path.join(root, 'program'); await writeFile(file, 'data');
  const apps = new LocalApps(path.join(root, 'apps.json'));
  await apps.associate({ id: 'old-id', name: 'Name' }, file);
  expect(await apps.referenceInstallation('old-id', 'kit-one', 'app')).toEqual({ appId: 'old-id', state: 'associated', versionVerified: false });
  await apps.unlinkInstallation('kit-one', 'app');
  expect((await apps.list())[0].path).toBe(file);
  expect(await readFile(file, 'utf8')).toBe('data');
  await rm(file);
  expect(await apps.referenceInstallation('old-id', 'kit-two', 'app')).toMatchObject({ state: 'missing' });
  await expect(apps.referenceInstallation('new-id', 'kit-two', 'app')).rejects.toThrow('app_association_not_found');
  const replacement = path.join(root, 'replacement'); await writeFile(replacement, 'new data');
  await apps.associate({ id: 'old-id', name: 'Name' }, replacement);
  expect(await apps.list()).toEqual([{ id: 'old-id', name: 'Name', path: replacement, exists: true, associationRevision: 2 }]);
  await apps.remove('old-id');
  expect(await readFile(replacement, 'utf8')).toBe('new data');
});

it('keeps Home management authority after unlink/remove and refuses Local or foreign Home adoption of the same physical source', async () => {
  const { registry, source, root } = await fixture(), bundle = await readPlugin(source), installed = (await registry.list()).plugins[0];
  const home = { rootDigest: 'a'.repeat(64), kitId: 'publisher/example', releaseId: 'release', artifactDigest: 'b'.repeat(64), managementDomain: 'home:' + 'c'.repeat(64) };
  await registry.stageManaged(bundle, home, 'home-install', 'component', installed.sha256, true);
  await expect(registry.managedPreview(bundle, { ...home, managementDomain: undefined }, 'local-install', installed.sha256, true)).rejects.toThrow('management_authority_conflict');
  await expect(registry.managedPreview(bundle, { ...home, managementDomain: 'home:' + 'd'.repeat(64) }, 'foreign-install', installed.sha256, true)).rejects.toThrow('management_authority_conflict');
  await expect(registry.referenceInstallation(bundle.manifest.id, 'local-install', 'component', installed)).rejects.toThrow('management_authority_conflict');
  await registry.removeManaged(bundle.manifest.id, 'home-install', 'component', installed.sha256); await registry.remove(bundle.manifest.id);
  const owner = JSON.parse(await readFile(path.join(root, 'plugins/ownership/example.guide.json'), 'utf8')); expect(owner.managementDomain).toBe(home.managementDomain); expect(owner.managed).toBe(true);
  await expect(registry.managedPreview(bundle, { ...home, managementDomain: undefined }, 'local-install')).rejects.toThrow('management_authority_conflict');
});
it('observes real ready SDK sessions with separate UUIDs and revokes readiness on Registry changes or window close', async () => {
  const { registry } = await fixture(), installed = (await registry.list()).plugins[0];
  const session = await registry.open(installed.manifest.id, 'main'); expect(await registry.readyObservation(installed.manifest.id, installed.sha256)).toBeUndefined();
  await registry.markReady(session.token); const observed = await registry.readyObservation(installed.manifest.id, installed.sha256); expect(observed?.sdk_instance_id).toMatch(/^[a-f0-9-]{36}$/); expect(observed?.sdk_instance_id).not.toBe(session.token); expect(observed?.registry_revision).toBeGreaterThan(0);
  await registry.setPlacement(installed.manifest.id, 'main', 'window'); expect(await registry.readyObservation(installed.manifest.id, installed.sha256)).toBeUndefined();
  await registry.close(session.token); const replacement = await registry.open(installed.manifest.id, 'main'); await registry.markReady(replacement.token);
  const latest = await registry.readyObservation(installed.manifest.id, installed.sha256); expect(latest!.registry_revision).toBeGreaterThan(observed!.registry_revision); expect(latest!.sdk_instance_id).not.toBe(observed!.sdk_instance_id);
  await registry.close(replacement.token); expect(await registry.readyObservation(installed.manifest.id, installed.sha256)).toBeUndefined();
});
