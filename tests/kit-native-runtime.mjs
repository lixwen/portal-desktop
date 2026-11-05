// Registry -> real Rust Portal durable admission -> Registry mutation. No Heart.
import { build } from 'esbuild';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const binary = process.env.KIT_PORTAL_BINARY;
if (!binary || !path.isAbsolute(binary)) throw new Error('Set KIT_PORTAL_BINARY to the absolute managed-runtime Portal binary.');
const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-native-gate-'));
let processHandle, controller;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
try {
  const moduleFile = path.join(root, 'modules.mjs');
  await build({ stdin: { contents: `export {PluginRegistry,readPlugin} from './desktop/main/plugins/registry.ts'; export {NativeKitController} from './desktop/main/kits/native-controller.ts'; export {ManagedDesktopPlugins} from './desktop/main/kits/managed-plugins.ts';`, resolveDir: process.cwd(), sourcefile: 'native-test.ts' }, bundle: true, platform: 'node', format: 'esm', outfile: moduleFile });
  const { PluginRegistry, readPlugin, NativeKitController, ManagedDesktopPlugins } = await import(pathToFileURL(moduleFile).href);
  const source = path.join(root, 'source'); await mkdir(source); await mkdir(path.join(root, 'workspace')); await mkdir(path.join(root, 'kits'));
  const manifest = { schemaVersion: 1, apiVersion: 1, minSdkVersion: '1.4.0', id: 'fixture.board', version: '1.0.0', name: 'Fixture', author: 'Fixture', description: 'Real native gate fixture', entry: 'index.html', capabilities: ['agent.read', 'agent.write'], contributes: { views: [{ id: 'main', title: 'Main' }], agent: { description: 'Fixture', instructions: 'Only this fixture data', fields: { title: { type: 'string', title: 'Title' } }, required: ['title'] } } };
  await writeFile(path.join(source, 'desktop.plugin.json'), JSON.stringify(manifest)); await writeFile(path.join(source, 'index.html'), '<h1>Fixture</h1>');
  const endpoint = 'https://fixture.invalid/heart';
  const registry = new PluginRegistry(path.join(root, 'plugins'), { contextKey: () => endpoint, endpoint: () => endpoint, call: async () => ({}) });
  const bundle = await readPlugin(source); await registry.install(bundle, { kind: 'local' });
  const portServer = createServer(); await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve)); const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
  const config = path.join(root, 'portal.toml');
  await writeFile(config, `name="desktop-native-test"\nbind="127.0.0.1:${port}"\nworkspace=${JSON.stringify(path.join(root, 'workspace'))}\nkits_dir=${JSON.stringify(path.join(root, 'kits'))}\nportal_mcp_token="${'h'.repeat(40)}"\n[subagent]\nenabled=false\nauto_install=false\n[kit_runtime]\nowner_id="owner"\nheart_id="heart"\ntarget_id="portal-A"\nauthority="local"\nstate_dir=${JSON.stringify(path.join(root, 'state'))}\ncontroller_token="${'a'.repeat(40)}"\n[[kit_runtime.native_targets]]\ntarget_id="target"\nexecutor="desktop_plugin_host"\ncontroller_token="${'c'.repeat(40)}"\n`);
  if (process.platform !== 'win32') await chmod(config, 0o600);
  const env = { ...process.env, HOME: root, HEART_PORTAL_SUPERVISED: '1', HEART_PORTAL_CLIENT_MANAGED: '1' }; delete env.PORTAL_MCP_TOKEN; delete env.LOOM_URL;
  processHandle = spawn(binary, ['--config', config], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  // Keep logs local and never print credential-bearing runtime errors.
  let log = ''; for (const stream of [processHandle.stdout, processHandle.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-32000); });
  const deadline = Date.now() + 20000;
  while (!controller) {
    if (processHandle.exitCode !== null) throw new Error('isolated_portal_exited');
    try { controller = await NativeKitController.connect(port, 'c'.repeat(40), { owner_id: 'owner', heart_id: 'heart', target_id: 'target', authority: 'local' }); } catch { if (Date.now() > deadline) throw new Error('isolated_portal_startup_timeout'); await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  const scope = { owner_id: 'owner', heart_id: 'heart', target_id: 'target', authority: 'local' };
  const adapter = new ManagedDesktopPlugins(registry, controller, scope, path.join(root, 'bindings.json'));
  const observed = await adapter.observed(manifest.id), native = observed.find(v => v.native_name.endsWith('.create'));
  const binding = { ...scope, installation_id: 'install', installation_revision: 1, component_id: 'board', release_id: 'release', closure_digest: 'a'.repeat(64), capability_id: 'create', runtime: 'local', target_generation: 1, remote_tool: native.remote_tool, effect: { kind: 'write', operation_scope: `plugin-${manifest.id}` }, accounts: {}, workspace_ref: null, browser_session_ref: null, policy_epoch: 1, schema_digest: digest(native.input_schema), expires_at_unix_seconds: 4_000_000_000 };
  delete binding.authority;
  const alias = 'kit_' + digest(binding).slice(0, 56);
  const registration = { expected_revision: 0, installation_id: 'install', resources: [{ ...scope, installation_id: 'install', component_id: 'board', native_resource_ref: native.resource_ref, enabled: true, entries: { [native.native_name]: binding }, retired_names: [] }], records: [{ tool: { name: alias, description: 'Fixture create', inputSchema: native.input_schema }, binding }] };
  await adapter.register(registration, [{ id: manifest.id, expectedDigest: bundle.sha256 }]);
  await assert.rejects(() => registry.agentCommand(endpoint, JSON.stringify({ plugin: manifest.id, op: 'create', requestId: 'bypass', data: { title: 'Bypass' } })), /managed_plugin_requires_admission/);
  const context = { endpoint, sessionId: 'desktop-client-session', rpcId: 100 };
  const result = await adapter.call(alias, { requestId: 'one', data: { title: 'Durable' } }, context);
  assert.equal(JSON.parse(result.content[0].text).record.data.title, 'Durable');
  assert.deepEqual(JSON.parse(JSON.stringify(await adapter.call(alias, { requestId: 'one', data: { title: 'Durable' } }, context))), result);
  await assert.rejects(() => adapter.call(alias, { requestId: 'other', data: { title: 'Conflict' } }, context));
  const session = await registry.open(manifest.id, 'main');
  const snapshot = await registry.call(session.token, 'agent.snapshot'); assert.equal(snapshot.records.length, 1);
  await assert.rejects(() => adapter.call(alias, { requestId: 'invalid', data: { title: 3 } }, { ...context, rpcId: 101 }));
  assert.equal((await registry.call(session.token, 'agent.snapshot')).records.length, 1);
  const rejected = await adapter.call(alias, { requestId: 'one', data: { title: 'Conflicting business retry' } }, { ...context, rpcId: 102 });
  assert.equal(rejected.isError, true); assert.match(rejected.content[0].text, /requestId/);
  await assert.rejects(() => adapter.call(alias, { requestId: 'fresh-id', data: { title: 'Must remain fenced' } }, { ...context, rpcId: 103 }));
  assert.equal((await registry.call(session.token, 'agent.snapshot')).records.length, 1);
  const secondBinding = { ...binding, installation_id: 'second-install' }, secondAlias = 'kit_' + digest(secondBinding).slice(0, 56);
  const nativeStatus = await controller.request('kit/native/status', {});
  const secondRegistration = { expected_revision: nativeStatus.revision, installation_id: 'second-install', resources: [{ ...registration.resources[0], installation_id: 'second-install', entries: { [native.native_name]: secondBinding } }], records: [{ tool: { name: secondAlias, description: 'Explicit second usage', inputSchema: native.input_schema }, binding: secondBinding }] };
  await adapter.register(secondRegistration, [{ id: manifest.id, expectedDigest: bundle.sha256 }], { snapshot: nativeStatus, publish: (method, params) => controller.request(method, params) });
  const shared = await controller.request('kit/native/status', {});
  assert.equal(shared.resources.find(r => r.native_resource_ref === native.resource_ref).installation_id, 'install');
  assert(shared.usage.grants.some(g => g.binding.installation_id === 'second-install' && g.enabled));
  await assert.rejects(() => adapter.call(secondAlias, { requestId: 'other-kit-new-id', data: { title: 'Cross-Kit physical fence' } }, { ...context, rpcId: 'rpc_second' }));
  await controller.request('kit/native/grants', { expected_revision: shared.revision, installation_id: 'install', grants: [], records: [] });
  await registry.unlinkInstallation(manifest.id, 'install', 'board');
  assert.equal((await registry.list()).plugins.length, 1);
  await assert.rejects(() => adapter.call(secondAlias, { requestId: 'after-first-remove', data: { title: 'Still fenced' } }, { ...context, rpcId: 'rpc_after_remove' }));
  assert.equal((await registry.call(session.token, 'agent.snapshot')).records.length, 1);
  await registry.setEnabled(manifest.id, false);
  await assert.rejects(() => adapter.call(alias, { requestId: 'disabled', data: { title: 'Blocked' } }, { ...context, rpcId: 102 }));
  console.log('PASS: Desktop Registry -> actual Rust native registration/admission/completion, replay/conflict/schema/error, two explicit Kits sharing one physical original, immutable ownership after first removal, cross-Kit unknown fence, managed legacy/disabled denial. No real Heart.');
} finally {
  controller?.close();
  if (processHandle && processHandle.exitCode === null) { processHandle.kill('SIGTERM'); await Promise.race([new Promise(resolve => processHandle.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]); if (processHandle.exitCode === null) processHandle.kill('SIGKILL'); }
  await rm(root, { recursive: true, force: true });
}
