import { afterEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HomeDesktopProducer, type HomeDesktopPreparation } from '../desktop/main/home/desktop-producer';
import type { HomeChannelContext } from '../desktop/main/home/host-channel';
import { PluginRegistry } from '../desktop/main/plugins/registry';
import { LocalApps } from '../desktop/main/app/local-apps';
import { protocolDigest } from '../desktop/main/kits/desktop-host-contract';
import { homeNativeDeviceScope } from '../desktop/main/kits/host-facts';
const OWNER = '00000000-0000-4000-8000-000000000001', DEVICE = '00000000-0000-4000-8000-000000000002';
const originalPlatform = process.platform;
const roots: string[] = [];
afterEach(async () => { Object.defineProperty(process, 'platform', { value: originalPlatform }); vi.restoreAllMocks(); vi.useRealTimers(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
async function fixture(executor: 'desktop_plugin_host' | 'os_app' = 'desktop_plugin_host', confirm = true, viewOnly = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kit-home-producer-')); roots.push(root); const endpoint = 'https://heart.fixture.invalid/existing';
  const registry = new PluginRegistry(path.join(root, 'registry'), { contextKey: () => endpoint, endpoint: () => endpoint, call: async () => ({}) }), apps = new LocalApps(path.join(root, 'apps.json')); let session = '', reservations: string[] = [], confirmations = 0;
  const context: HomeChannelContext = { channel_id: randomUUID(), owner_id: OWNER, profile_id: 'profile', heart_id: 'heart', heart_origin: 'https://heart.fixture.invalid', heart_slug: 'existing', target_id: executor === 'os_app' ? 'target-C' : 'target-B', generation: 1, fence: 1 };
  const options = { root: path.join(root, 'components'), file: path.join(root, 'state.json'), realm: 'https://home.fixture.invalid/', ownerId: OWNER, profileId: 'profile', executor, targetId: context.target_id, generation: 1, policyRevision: 1, nativeScope: homeNativeDeviceScope(OWNER, DEVICE), endpoint, managementDomain: 'home:' + 'd'.repeat(64), registry, apps, allowedCapabilities: ['agent.read', 'agent.write'] as ('agent.read' | 'agent.write')[],
    openPlugin: async (id: string, view: string) => { const opened = await registry.open(id, view); session = opened.token; await registry.markReady(session); }, closePlugin: () => { if (session) void registry.close(session); },
    confirm: async (_message: string, _detail: string) => { confirmations++; return confirm; }, reservePlugins: async (ids: string[]) => { reservations = [...ids]; }, currentEndpoint: () => endpoint };
  const producer = new HomeDesktopProducer(options); await producer.load(); producer.activate(context);
  const manifest = { schemaVersion: 1, apiVersion: 1, minSdkVersion: '1.4.0', id: 'fixture.home-board', version: '1.0.0', name: 'Home board', author: 'Fixture', description: 'Original SDK fixture', entry: 'index.html', capabilities: ['agent.read', 'agent.write'], contributes: { views: [{ id: 'main', title: 'Board' }], agent: { description: 'A board', instructions: 'Manage selected board', fields: { title: { type: 'string', title: 'Title' } }, required: ['title'] } } };
  if (viewOnly) { (manifest as any).capabilities = []; delete (manifest.contributes as any).agent; }
  const prefix = `home-${sha('operation')}/${sha('component')}/package/`, files: Record<string, string> = executor === 'os_app' ? { 'app.json': '{"purpose":"existing_association"}' } : { 'desktop.plugin.json': JSON.stringify(manifest), 'index.html': '<h1>Home board</h1>' };
  const provenance = { initial_root_digest: 'a'.repeat(64), kit_id: 'publisher/board', artifact_digest: 'b'.repeat(64), closure_digest: 'c'.repeat(64), expires_at_unix_seconds: Math.floor(Date.now() / 1000) + 3600 };
  const preparation: HomeDesktopPreparation = { plan: { format_version: 1, operation_id: 'operation', owner_user_id: OWNER, installation_id: 'installation', component_instance_id: 'component', release_id: 'release', target_id: context.target_id, generation: 1, revision: 1, policy_revision: 1, required_features: ['home.authority-channel.v1', 'runtime.plan.v1'], trust: 'user_computer', permissions: { read_roots: ['home-components'], write_roots: [], network_hosts: [] }, files: Object.fromEntries(Object.entries(files).map(([id, bytes]) => [id, { size_bytes: Buffer.byteLength(bytes), digest: sha(bytes), path: { root_id: 'home-components', relative_path: prefix + id } }])), payload: executor === 'os_app' ? { executor, target: { mode: 'existing_association', association_id: 'chosen-app' } } : { executor, plugin_id: manifest.id, manifest: { root_id: 'home-components', relative_path: prefix + 'desktop.plugin.json' } } }, projection: executor === 'os_app' ? { executor, mode: 'existing_association', expected_association_id: null, association_revision: 1, provenance } : { executor, plugin_id: manifest.id, version: manifest.version, description: manifest.description, selected_tools: viewOnly ? {} : { list: manifest.id + '.list', create: manifest.id + '.create' }, provenance } };
  const execute = (command: Parameters<typeof producer.execute>[0]) => producer.execute(command, context) as Promise<any>;
  const stage = async () => { await execute({ command: 'stage', preparation }); for (const [id, text] of Object.entries(files)) await execute({ command: 'file_chunk', operation_id: 'operation', component_instance_id: 'component', file_id: id, offset: 0, bytes_base64: Buffer.from(text).toString('base64') }); };
  const prepare = async () => { await stage(); return (await execute({ command: 'prepare', operation_id: 'operation', component_instance_id: 'component' })).host; };
  return { root, registry, apps, producer, options, context, preparation, execute, stage, prepare, reservations: () => reservations, confirmations: () => confirmations, session: () => session };
}

function writeDispatch(host: any, id = 'home-call-1') {
  const tool = host.tools.find((t: any) => t.remote_tool.endsWith('.create')), expires = Math.floor(Date.now() / 1000) + 20;
  return { call_id: id, host, binding: { owner_id: OWNER, heart_id: 'heart', installation_id: 'installation', installation_revision: 1, component_id: 'component', release_id: 'release', closure_digest: 'c'.repeat(64), capability_id: 'create', runtime: 'local', target_id: 'target-B', target_generation: 1, remote_tool: tool.remote_tool, effect: tool.effect, accounts: {}, workspace_ref: homeNativeDeviceScope(OWNER, DEVICE), browser_session_ref: null, policy_epoch: 1, schema_digest: protocolDigest(tool.input_schema), expires_at_unix_seconds: expires }, arguments: { requestId: 'sdk-request', data: { title: 'One actual record' } }, expires_at_unix_seconds: expires };
}
it('materializes original SDK files and actual schemas, adapts business result once and consumes each Home call ID durably', async () => {
  const f = await fixture(), host = await f.prepare(); expect(host).toMatchObject({ process_generation: null, observation: { executor: 'desktop_plugin_host', registry_revision: 2 }, receipt: { state: 'ready', process_generation: null } }); expect(host.observation.sdk_instance_id).not.toBe(f.session()); expect(f.reservations()).toEqual(['fixture.home-board']);
  const installed = (await f.registry.list()).plugins[0]; expect(installed.source.kind).toBe('kit'); expect(installed.manifest.id).toBe('fixture.home-board'); await expect(f.registry.agentCommand(f.options.endpoint, '{"plugin":"fixture.home-board","op":"list"}')).rejects.toThrow('requires_admission');
  const dispatch = writeDispatch(host);
  const one = await f.execute({ command: 'dispatch', dispatch }), two = await f.execute({ command: 'dispatch', dispatch }); expect(two).toEqual(one); expect(one.value.content[0].type).toBe('text'); expect(JSON.parse(one.value.content[0].text).record.data.title).toBe('One actual record');
  const snapshot = await f.registry.call(f.session(), 'agent.snapshot') as any; expect(snapshot.records).toHaveLength(1);
  await expect(f.execute({ command: 'dispatch', dispatch: { ...dispatch, arguments: { ...dispatch.arguments, data: { title: 'Changed payload' } } } })).rejects.toThrow('already_consumed');
  await f.registry.close(f.session()); expect(await f.producer.observationsCurrent()).toBe(false); await expect(f.execute({ command: 'dispatch', dispatch: { ...dispatch, call_id: 'new-call' } })).rejects.toThrow('binding_changed');
  const state = JSON.parse(await readFile(f.options.file, 'utf8')); expect(state.calls).toHaveLength(1); expect(state.calls[0].value).toEqual(one.value);
});
it('cancelling native SDK consent creates no Registry package or reserved tool and wrong scope/path cannot stage', async () => {
  const f = await fixture('desktop_plugin_host', false); await f.stage(); await expect(f.execute({ command: 'prepare', operation_id: 'operation', component_instance_id: 'component' })).rejects.toThrow('confirmation_cancelled'); expect((await f.registry.list()).plugins).toEqual([]); expect(f.reservations()).toEqual([]);
  const wrong = structuredClone(f.preparation); wrong.plan.operation_id = 'foreign'; wrong.plan.files['index.html'].path.relative_path = '../escape'; await expect(f.execute({ command: 'stage', preparation: wrong })).rejects.toThrow('path_invalid');
  await expect(f.producer.execute({ command: 'stage', preparation: f.preparation }, { ...f.context, owner_id: 'foreign' })).rejects.toThrow('context_changed');
});
it('reports portable App Root only after actual stable association confirmation; removal invalidates it and never deletes program', async () => {
  const f = await fixture('os_app'); await f.stage(); await expect(f.execute({ command: 'prepare', operation_id: 'operation', component_instance_id: 'component' })).rejects.toThrow('association_not_found');
  const program = path.join(f.root, 'program'); await writeFile(program, 'existing user program'); await f.apps.associate({ id: 'chosen-app', name: 'Explicitly selected app' }, program);
  const metadata = await f.execute({ command: 'app_associations', query: null, offset: 0, limit: 100 }); expect(metadata.page.associations).toEqual([{ id: 'chosen-app', revision: 1, display_name: 'Explicitly selected app', status: 'associated' }]); expect(JSON.stringify(metadata)).not.toContain(program);
  const host = (await f.execute({ command: 'prepare', operation_id: 'operation', component_instance_id: 'component' })).host; expect(host.receipt.state).toBe('associated'); expect(host.tools).toEqual([]); expect(host.process_generation).toBeNull(); expect(host.observation).toMatchObject({ executor: 'os_app', association_id: 'chosen-app', association_revision: 1 });
  await f.apps.remove('chosen-app'); expect(await f.producer.observationsCurrent()).toBe(false); expect(await readFile(program, 'utf8')).toBe('existing user program');
  await f.apps.associate({ id: 'chosen-app', name: 'Explicitly selected app' }, program); expect(await f.producer.observationsCurrent()).toBe(false); expect((await f.apps.observeAssociation('chosen-app')).association_revision).toBeGreaterThan(1); await expect(f.execute({ command: 'prepare', operation_id: 'operation', component_instance_id: 'component' })).rejects.toThrow('association_revision_changed');
});
it('does not accept arbitrary Ready or dispatch after reconnect until genuine observation is refreshed', async () => {
  const f = await fixture(); const host = await f.prepare(); await f.producer.disconnected(f.context); await expect(f.execute({ command: 'stop', host })).rejects.toThrow('channel_fenced');
  const restarted = new HomeDesktopProducer(f.options); await restarted.load(); const replacementContext = { ...f.context, channel_id: randomUUID(), fence: 2 }; restarted.activate(replacementContext); expect(await restarted.observationsCurrent()).toBe(true);
  await expect(restarted.execute({ command: 'dispatch', dispatch: { call_id: 'forged', host, expires_at_unix_seconds: Math.floor(Date.now() / 1000) + 20, binding: {} } }, replacementContext)).rejects.toThrow('binding_changed');
});

it('persists consumed Home call before SDK side effect and keeps lost-result rejection across producer replacement', async () => {
  const f = await fixture(), host = await f.prepare(), dispatch = writeDispatch(host, 'unknown-call');
  const original = f.registry.managedAgentCommand.bind(f.registry);
  f.registry.managedAgentCommand = async (...args) => { await original(...args); throw new Error('simulated_process_loss_after_actual_sdk_write'); };
  await expect(f.execute({ command: 'dispatch', dispatch })).rejects.toThrow('simulated_process_loss');
  f.registry.managedAgentCommand = original;
  await expect(f.execute({ command: 'dispatch', dispatch })).rejects.toThrow('already_consumed');
  expect((await f.registry.call(f.session(), 'agent.snapshot') as any).records).toHaveLength(1);
  const disk = JSON.parse(await readFile(f.options.file, 'utf8')); expect(disk.calls).toHaveLength(1); expect(disk.calls[0]).not.toHaveProperty('value');
  await f.producer.disconnected(f.context); const restarted = new HomeDesktopProducer(f.options); await restarted.load();
  const context = { ...f.context, channel_id: randomUUID(), fence: 2 }; restarted.activate(context);
  const refreshed = await restarted.execute({ command: 'prepare', operation_id: 'operation', component_instance_id: 'component' }, context) as any;
  await expect(restarted.execute({ command: 'dispatch', dispatch: { ...dispatch, host: refreshed.host, arguments: { requestId: 'must-not-write', data: { title: 'No second record' } } } }, context)).rejects.toThrow('already_consumed');
  expect((await f.registry.call(f.session(), 'agent.snapshot') as any).records).toHaveLength(1);
});

it('cleans an exact protected historical SDK plan after expiry and generation replacement without reviving Ready', async () => {
  const f = await fixture(); await f.prepare(); await f.producer.disconnected(f.context);
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(Date.now() + 7200000));
  const options = { ...f.options, generation: 2 }, replaced = new HomeDesktopProducer(options); await replaced.load();
  const context = { ...f.context, channel_id: randomUUID(), generation: 2, fence: 2 }; replaced.activate(context);
  const result = await replaced.execute({ command: 'stop_owned', preparation: f.preparation }, context) as any;
  expect(result).toMatchObject({ result: 'owned_stopped', receipt: { state: 'stopped', generation: 1, plan_digest: protocolDigest(f.preparation.plan) } });
  expect((await f.registry.list()).plugins[0].enabled).toBe(false);
});

it('requires genuine SDK readiness for a view-only plugin while exporting exactly zero tools', async () => {
  const f = await fixture('desktop_plugin_host', true, true), host = await f.prepare();
  expect(host.receipt.state).toBe('ready'); expect(host.tools).toEqual([]); expect(host.process_generation).toBeNull();
  expect(host.observation.sdk_instance_id).toMatch(/^[a-f0-9-]{36}$/); expect(host.observation.registry_revision).toBeGreaterThan(0);
  await f.registry.close(f.session()); expect(await f.producer.observationsCurrent()).toBe(false);
});

it('accepts the authenticated Home activation epoch independently of the local permission-ceiling revision', async () => {
  const f = await fixture();
  // Home starts revoked at epoch 1, and issues its first activation at epoch 2.
  // The native operator permission ceiling remains revision 1.
  f.preparation.plan.policy_revision = 2;
  const host = await f.prepare();
  const stale = writeDispatch(host, 'stale-policy-epoch');
  await expect(f.execute({ command: 'dispatch', dispatch: stale })).rejects.toThrow('binding_changed');
  expect((await f.registry.call(f.session(), 'agent.snapshot') as any).records).toHaveLength(0);
  const current = writeDispatch(host, 'current-policy-epoch'); current.binding.policy_epoch = 2;
  const result = await f.execute({ command: 'dispatch', dispatch: current });
  expect(JSON.parse(result.value.content[0].text).record.data.title).toBe('One actual record');
  expect((await f.registry.call(f.session(), 'agent.snapshot') as any).records).toHaveLength(1);
});


it('requires the exact enrolled owner and stable device scope before the native SDK can write', async () => {
  const f = await fixture(), host = await f.prepare();
  for (const [name, scope] of [
    ['missing', null],
    ['foreign-owner', homeNativeDeviceScope('00000000-0000-4000-8000-000000000003', DEVICE)],
    ['foreign-device', homeNativeDeviceScope(OWNER, '00000000-0000-4000-8000-000000000004')],
  ] as const) {
    const dispatch = writeDispatch(host, name);
    await expect(f.execute({ command: 'dispatch', dispatch: { ...dispatch, binding: { ...dispatch.binding, workspace_ref: scope } } })).rejects.toThrow('binding_changed');
  }
  expect((await f.registry.call(f.session(), 'agent.snapshot') as any).records).toHaveLength(0);
  await f.execute({ command: 'dispatch', dispatch: writeDispatch(host) });
  expect((await f.registry.call(f.session(), 'agent.snapshot') as any).records).toHaveLength(1);
});

it('does not report observation loss midway through its own controlled SDK stop', async () => {
  const f = await fixture(), host = await f.prepare();
  const original = f.registry.setEnabled.bind(f.registry);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  f.registry.setEnabled = async (...args) => { const result = await original(...args); enter(); await released; return result; };
  const stopping = f.execute({ command: 'stop', host });
  await entered;
  let observed: boolean | undefined;
  const polling = f.producer.observationsCurrent().then(value => { observed = value; return value; });
  await new Promise<void>(resolve => setImmediate(resolve));
  const settledDuringTransition = observed !== undefined;
  release();
  await stopping;
  expect(settledDuringTransition).toBe(false);
  expect(await polling).toBe(true);
});

it('requires a fresh native confirmation before reopening a stopped plugin and explains uncertain initialization effects', async () => {
  const f = await fixture(); await f.prepare();
  const original = structuredClone(f.preparation);
  await f.execute({ command: 'stop_owned', preparation: original });
  const next = structuredClone(original), operation = 'recovery-operation';
  next.plan.operation_id = operation; next.plan.revision++; next.plan.policy_revision++;
  const oldPrefix = `home-${sha('operation')}/`, nextPrefix = `home-${sha(operation)}/`;
  for (const file of Object.values(next.plan.files)) file.path.relative_path = file.path.relative_path.replace(oldPrefix, nextPrefix);
  if (next.plan.payload.executor !== 'desktop_plugin_host') throw new Error('fixture plugin required');
  next.plan.payload.manifest.relative_path = next.plan.payload.manifest.relative_path.replace(oldPrefix, nextPrefix);
  const open = vi.spyOn(f.options, 'openPlugin'); let displayed = '';
  f.options.confirm = async (message, detail) => { displayed = message + detail; return false; };
  await f.execute({ command: 'stage', preparation: next });
  for (const [id, file] of Object.entries(original.plan.files)) {
    const bytes = await readFile(path.join(f.options.root, file.path.relative_path));
    await f.execute({ command: 'file_chunk', operation_id: operation, component_instance_id: next.plan.component_instance_id, file_id: id, offset: 0, bytes_base64: bytes.toString('base64') });
  }
  await expect(f.execute({ command: 'prepare', operation_id: operation, component_instance_id: next.plan.component_instance_id })).rejects.toThrow('home_native_confirmation_cancelled');
  expect(open).not.toHaveBeenCalled();
  expect(displayed).toContain('重新打开'); expect(displayed).toContain('初始化会再次运行'); expect(displayed).toContain('请先核实外部结果'); expect(displayed).toContain('不会清除先前不确定的业务结果');
  expect((await f.registry.list()).plugins[0].enabled).toBe(false);
  expect(await f.producer.observationsCurrent()).toBe(true);
});

it.each(['desktop_plugin_host', 'os_app'] as const)('rejects new managed B/C on Linux before staging, initialization or consuming a dispatch (%s)', async executor => {
  const f = await fixture(executor); const before = await readFile(f.options.file); const open = vi.spyOn(f.options, 'openPlugin');
  Object.defineProperty(process, 'platform', { value: 'linux' }); vi.spyOn(os, 'platform').mockReturnValue('linux');
  for (const command of [{ command: 'stage', preparation: f.preparation }, { command: 'prepare', operation_id: 'operation', component_instance_id: 'component' }, { command: 'dispatch', dispatch: {} }, { command: 'file_chunk', operation_id: 'operation', component_instance_id: 'component', file_id: 'fixture', offset: 0, bytes_base64: 'YQ==' }, { command: 'app_associations', query: null, offset: 0, limit: 10 }] as any[]) {
    await expect(f.execute(command)).rejects.toThrow('unsupported_managed_desktop_platform');
  }
  expect(open).not.toHaveBeenCalled(); expect(await readFile(f.options.file)).toEqual(before); expect((await f.registry.list()).plugins).toEqual([]);
});

it('keeps an authenticated historical Home SDK StopOwned and Observe path on Linux without allowing activation', async () => {
  const f = await fixture(); await f.prepare();
  Object.defineProperty(process, 'platform', { value: 'linux' }); vi.spyOn(os, 'platform').mockReturnValue('linux');
  const stopped = await f.execute({ command: 'stop_owned', preparation: f.preparation });
  expect(stopped).toMatchObject({ result: 'owned_stopped', receipt: { state: 'stopped' } });
  const observed = await f.execute({ command: 'observe_owned', preparation: f.preparation });
  expect(observed.observation.state).toBe('stopped');
  expect((await f.registry.list()).plugins[0].enabled).toBe(false);
  await expect(f.execute({ command: 'prepare', operation_id: 'operation', component_instance_id: 'component' })).rejects.toThrow('unsupported_managed_desktop_platform');
});
it('keeps historical Home App cleanup on Linux and preserves the user program and stable association', async () => {
  const f = await fixture('os_app'); const program = path.join(f.root, 'existing-program'); await writeFile(program, 'user-owned original bytes');
  await f.apps.associate({ id: 'chosen-app', name: 'Chosen' }, program); await f.prepare();
  Object.defineProperty(process, 'platform', { value: 'linux' }); vi.spyOn(os, 'platform').mockReturnValue('linux');
  const stopped = await f.execute({ command: 'stop_owned', preparation: f.preparation }); expect(stopped.receipt.state).toBe('stopped');
  expect(await readFile(program, 'utf8')).toBe('user-owned original bytes'); expect((await f.apps.list())[0]).toMatchObject({ id: 'chosen-app', exists: true });
});

it('rejects C0 bytes in original package paths before staging any file', async () => {
  const f = await fixture(); const before = await readFile(f.options.file), invalid = structuredClone(f.preparation);
  Object.values(invalid.plan.files)[0].path.relative_path += '\n';
  await expect(f.execute({ command: 'stage', preparation: invalid })).rejects.toThrow('home_native_path_invalid');
  expect(await readFile(f.options.file)).toEqual(before);
});
