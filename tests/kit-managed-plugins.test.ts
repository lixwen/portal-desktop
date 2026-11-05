import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PluginRegistry, readPlugin } from '../desktop/main/plugins/registry';
import { ManagedDesktopPlugins } from '../desktop/main/kits/managed-plugins';
import type { ExecutionBinding, NativeRegistration, NativeTool, McpNativeResult } from '../desktop/main/kits/native-controller';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kit-managed-desktop-')); roots.push(root);
  const source = path.join(root, 'source'); await mkdir(source);
  const manifest = { schemaVersion: 1, apiVersion: 1, minSdkVersion: '1.4.0', id: 'fixture.board', version: '1.0.0', name: 'Fixture', author: 'Fixture', description: 'Fixture', entry: 'index.html', capabilities: ['agent.read', 'agent.write'], contributes: { views: [{ id: 'main', title: 'Main' }], agent: { description: 'Fixture', instructions: 'Only fixture data', fields: { title: { type: 'string', title: 'Title' } }, required: ['title'] } } };
  await writeFile(path.join(source, 'desktop.plugin.json'), JSON.stringify(manifest)); await writeFile(path.join(source, 'index.html'), '<h1>Fixture</h1>');
  const endpoint = 'https://heart.fixture.invalid/heart';
  const registry = new PluginRegistry(path.join(root, 'plugins'), { contextKey: () => endpoint, endpoint: () => endpoint, call: async () => ({}) });
  const bundle = await readPlugin(source); await registry.install(bundle, { kind: 'local' });
  const calls: { source: NativeTool; args: Record<string, unknown> }[] = [], completed: (McpNativeResult | null)[] = [];
  let failedCompletion = false, denied = false;
  const controller = {
    register: async () => ({}),
    begin: async (source: NativeTool, _session: string, _rpc: number, args: Record<string, unknown>) => {
      if (denied) throw new Error('denied'); calls.push({ source, args }); return { state: 'dispatch' as const, record_id: 'record' };
    },
    complete: async (_record: string, result: McpNativeResult | null) => { if (failedCompletion) throw new Error('disconnected'); completed.push(result); }, close() {},
  };
  const scope = { owner_id: 'owner', heart_id: 'heart', target_id: 'target', authority: 'local' as const };
  const file = path.join(root, 'bindings.json');
  const adapter = new ManagedDesktopPlugins(registry, controller, scope, file);
  const observed = await adapter.observed(manifest.id), native = observed.find(v => v.native_name.endsWith('.create'))!;
  const binding: ExecutionBinding = { owner_id: scope.owner_id, heart_id: scope.heart_id, target_id: scope.target_id, runtime: 'local', installation_id: 'installation', installation_revision: 1, component_id: 'board', release_id: 'release', closure_digest: 'a'.repeat(64), capability_id: 'create', target_generation: 1, remote_tool: native.remote_tool, effect: { kind: 'write', operation_scope: 'records' }, accounts: {}, workspace_ref: null, browser_session_ref: null, policy_epoch: 1, schema_digest: 'b'.repeat(64), expires_at_unix_seconds: 2_000_000_000 };
  // Controller is a boundary double here. Real Rust validates digest and alias.
  const registration: NativeRegistration = { expected_revision: 0, installation_id: 'installation', resources: [{ ...scope, installation_id: 'installation', component_id: 'board', native_resource_ref: native.resource_ref, enabled: true, entries: { [native.native_name]: binding }, retired_names: [] }], records: [{ tool: { name: 'kit_fixture_alias', description: 'Fixture', inputSchema: native.input_schema }, binding }] };
  return { root, registry, bundle, manifest, endpoint, calls, completed, adapter, registration, file, controller, scope, deny: () => { denied = true; }, loseCompletion: () => { failedCompletion = true; } };
}
it('registers observed native source, persists fixed alias and routes admitted call through original partitioned Registry', async () => {
  const f = await fixture(); await f.adapter.register(f.registration, [{ id: f.manifest.id, expectedDigest: f.bundle.sha256 }]);
  await expect(f.registry.agentCommand(f.endpoint, JSON.stringify({ plugin: f.manifest.id, op: 'list' }))).rejects.toThrow('managed_plugin_requires_admission');
  const adapter = new ManagedDesktopPlugins(f.registry, f.controller, { ...f.scope }, f.file); await adapter.load();
  const result = await adapter.call('kit_fixture_alias', { requestId: 'create-one', data: { title: 'Private' } }, { endpoint: f.endpoint, sessionId: 'trusted-session', rpcId: 1 });
  expect(result.isError).toBeUndefined(); expect(JSON.parse(result.content[0].text).record.data.title).toBe('Private');
  expect(f.completed).toHaveLength(1); expect(f.calls[0].source.source_digest).toBe(f.bundle.sha256);
  const files = await import('node:fs/promises').then(fs => fs.readdir(path.join(f.root, 'plugins/agent-data', f.manifest.id)));
  expect(files).toHaveLength(1); expect(await readFile(path.join(f.root, 'plugins/agent-data', f.manifest.id, files[0]), 'utf8')).toContain('Private');
});
it('denied admission has no business side effect, disabled source cannot dispatch and unknown alias never falls back', async () => {
  const f = await fixture(); await f.adapter.register(f.registration, [{ id: f.manifest.id, expectedDigest: f.bundle.sha256 }]);
  f.deny(); await expect(f.adapter.call('kit_fixture_alias', { requestId: 'create', data: { title: 'Never' } }, { endpoint: f.endpoint, sessionId: 'session', rpcId: 1 })).rejects.toThrow('denied');
  expect(f.calls).toHaveLength(0);
  await expect(f.adapter.call('fixture.board.create', {}, { endpoint: f.endpoint, sessionId: 'session', rpcId: 2 })).rejects.toThrow('binding_unavailable');
  await f.registry.setEnabled(f.manifest.id, false);
  await expect(f.adapter.call('kit_fixture_alias', {}, { endpoint: f.endpoint, sessionId: 'session', rpcId: 3 })).rejects.toThrow('source_changed');
});
it('lost durable completion reports unknown after one mutation and never automatically repeats it', async () => {
  const f = await fixture(); await f.adapter.register(f.registration, [{ id: f.manifest.id, expectedDigest: f.bundle.sha256 }]);
  f.loseCompletion(); await expect(f.adapter.call('kit_fixture_alias', { requestId: 'create', data: { title: 'Committed' } }, { endpoint: f.endpoint, sessionId: 'session', rpcId: 1 })).rejects.toThrow('managed_desktop_result_unknown');
  expect(f.calls).toHaveLength(1); expect(f.completed).toHaveLength(0);
});
it('original UI disable and reenable cannot resurrect an old registration with identical source bytes', async () => {
  const f = await fixture(); await f.adapter.register(f.registration, [{ id: f.manifest.id, expectedDigest: f.bundle.sha256 }]);
  await f.registry.setEnabled(f.manifest.id, false); await f.registry.setEnabled(f.manifest.id, true);
  await expect(f.adapter.call('kit_fixture_alias', { requestId: 'stale-alias', data: { title: 'Must not run' } }, { endpoint: f.endpoint, sessionId: 'session', rpcId: 'rpc_new' })).rejects.toThrow('registration_revoked');
  expect(f.calls).toHaveLength(0);
});
