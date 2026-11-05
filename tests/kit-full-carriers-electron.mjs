// Actual isolated signed offline Kit -> CLI -> Electron SDK + real Portal MCP.
// This fixture has no real Heart/Home credentials and does not claim DEV acceptance.
import { build } from 'esbuild';
import { createServer as viteServer } from 'vite';
import { createServer as netServer, createConnection } from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import electron from 'electron';
import { launchDesktop } from './support/electron-lifecycle.mjs';
const run = promisify(execFile), root = process.cwd();
const installerRoot = process.env.KIT_INSTALLER_ROOT;
const portalBinary = process.env.KIT_PORTAL_BINARY;
if (!installerRoot || !portalBinary || !path.isAbsolute(installerRoot) || !path.isAbsolute(portalBinary)) throw new Error('Explicit KIT_INSTALLER_ROOT and KIT_PORTAL_BINARY required');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'full-kit-carriers-'));
const profile = path.join(temporary, 'profile'), state = path.join(temporary, 'state'), kits = path.join(temporary, 'kits');
let application, vite, portal, client, mcpSocket, committing;
const privateJson = (file, value) => writeFile(file, JSON.stringify(value), { mode: 0o600 });
const wait = async (check, timeout = 30000) => { const end = Date.now() + timeout; for (;;) { const result = await check(); if (result) return result; if (Date.now() > end) throw new Error('fixture_condition_timeout'); await new Promise(resolve => setTimeout(resolve, 50)); } };
const freshMcpSession = async port => {
  const socket = createConnection({ host: '127.0.0.1', port }); socket.setEncoding('utf8');
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  let buffer = '', next = 0; const pending = new Map();
  socket.on('data', data => { buffer += data; for (;;) { const n = buffer.indexOf('\n'); if (n < 0) break; const response = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1); const resolve = pending.get(response.id); if (resolve) { pending.delete(response.id); resolve(response); } } });
  const call = (method, params) => new Promise((resolve, reject) => { const id = ++next; const timer = setTimeout(() => { pending.delete(id); reject(new Error('fixture_reconnected_mcp_timeout')); }, 20000); pending.set(id, response => { clearTimeout(timer); resolve(response); }); socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  await call('auth', { token: 'h'.repeat(40) }); return { call, close: () => socket.destroy() };
};
try {
  await mkdir(profile); await mkdir(kits); await mkdir(path.join(temporary, 'workspace'));
  const fixture = path.join(temporary, 'fixture'); await mkdir(fixture);
  await run('cargo', ['test', '--locked', '--manifest-path', path.join(installerRoot, 'Cargo.toml'), '--test', 'desktop_fixture', '--', '--ignored'], { cwd: installerRoot, env: { ...process.env, KIT_DESKTOP_FIXTURE_OUT: fixture }, maxBuffer: 1024 * 1024 });
  await run('cargo', ['build', '--locked', '--manifest-path', path.join(installerRoot, 'Cargo.toml')], { cwd: installerRoot, maxBuffer: 1024 * 1024 });
  const frozen = path.join(temporary, 'binaries'); await mkdir(frozen);
  const binary = path.join(frozen, 'kit-installer');
  const installerBytes = await readFile(path.join(installerRoot, 'target/debug/kit-installer')); await writeFile(binary, installerBytes, { mode: 0o700 });
  const installerHash = createHash('sha256').update(installerBytes).digest('hex');
  const cli = async args => JSON.parse((await run(binary, ['--state', state, ...args], { maxBuffer: 4 * 1024 * 1024 })).stdout);
  console.log('Fixture signed; actual CLI built.');
  const metadata = JSON.parse(await readFile(path.join(fixture, 'fixture.json'), 'utf8'));
  await cli(['init', '--root-metadata', metadata.root, '--root-digest', metadata.root_digest, '--kits-dir', kits]);
  const probe = netServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const endpoint = 'https://fixture.invalid/heart';
  const portalConfig = path.join(temporary, 'portal.toml');
  await writeFile(portalConfig, `name="full-kit-fixture"\nbind="127.0.0.1:${port}"\nworkspace=${JSON.stringify(path.join(temporary, 'workspace'))}\nkits_dir=${JSON.stringify(kits)}\nportal_mcp_token="${'h'.repeat(40)}"\n[subagent]\nenabled=false\nauto_install=false\n[kit_runtime]\nowner_id="owner"\nheart_id="heart"\ntarget_id="portal-A"\nauthority="local"\nstate_dir=${JSON.stringify(path.join(temporary, 'portal-state'))}\ncontroller_token="${'a'.repeat(40)}"\n[[kit_runtime.native_targets]]\ntarget_id="desktop-B"\nexecutor="desktop_plugin_host"\ncontroller_token="${'l'.repeat(40)}"\n[kit_runtime.native_targets.consumer]\ndescriptor=${JSON.stringify(path.join(profile, 'desktop-control-endpoint.json'))}\ntoken="${'p'.repeat(40)}"\n[kit_runtime.host_policy]\ngeneration=1\npolicy_revision=1\n[kit_runtime.host_policy.roots]\nstore=${JSON.stringify(state)}\nkits=${JSON.stringify(kits)}\n[kit_runtime.host_policy.runtimes]\ninstaller=${JSON.stringify(binary)}\n[kit_runtime.host_policy.permission_ceiling]\nread_roots=["store","kits"]\nwrite_roots=[]\nnetwork_hosts=[]\n`, { mode: 0o600 });
  const env = { ...process.env, HOME: temporary, HEART_PORTAL_SUPERVISED: '1', HEART_PORTAL_CLIENT_MANAGED: '1' }; delete env.PORTAL_MCP_TOKEN; delete env.LOOM_URL;
  const portalBytes = await readFile(portalBinary), frozenPortal = path.join(frozen, 'heart-portal'); await writeFile(frozenPortal, portalBytes, { mode: 0o700 });
  const portalHash = createHash('sha256').update(portalBytes).digest('hex');
  portal = spawn(frozenPortal, ['--config', portalConfig], { env, stdio: 'ignore' });
  const moduleFile = path.join(temporary, 'control.mjs');
  await build({ stdin: { contents: `export {NativeKitController} from './desktop/main/kits/native-controller.ts';`, resolveDir: root }, bundle: true, platform: 'node', format: 'esm', outfile: moduleFile });
  const { NativeKitController } = await import(pathToFileURL(moduleFile).href);
  await wait(async () => { if (portal.exitCode !== null) throw new Error('isolated_portal_exited'); try { const c = await NativeKitController.connect(port, 'a'.repeat(40), { owner_id: 'owner', heart_id: 'heart', target_id: 'portal-A', authority: 'local' }); c.close(); return true; } catch { return false; } });
  const controlA = path.join(temporary, 'controller-A.json');
  await privateJson(controlA, { owner_id: 'owner', heart_id: 'heart', target_id: 'portal-A', port, controller_token: 'a'.repeat(40), generation: 1, policy_revision: 1, state_root_id: 'store', kits_root_id: 'kits', installer_runtime_id: 'installer' });
  await cli(['bind-controller', controlA]);
  await privateJson(path.join(profile, 'kit-controller.json'), { owner_id: 'owner', heart_id: 'heart', target_id: 'desktop-B', authority: 'local', port, controller_token: 'l'.repeat(40) });
  const b = { owner_id: 'owner', heart_id: 'heart', target_id: 'desktop-B', authority: 'local' };
  const c = { ...b, target_id: 'desktop-C' };
  const policy = { controllerToken: 'i'.repeat(40), generation: 1, policyRevision: 1, roots: { store: state }, allowedPluginCapabilities: ['storage', 'agent.read', 'agent.write'], readRoots: ['store'], writeRoots: [], networkHosts: [] };
  await privateJson(path.join(profile, 'desktop-controller.json'), { format_version: 1, port: 0, targets: [{ ...policy, context: b, executor: 'desktop_plugin_host', consumerToken: 'p'.repeat(40), beingEndpoint: endpoint }, { ...policy, controllerToken: 'j'.repeat(40), context: c, executor: 'os_app' }] });
  const appFile = path.join(temporary, 'explicit-user-app'); await writeFile(appFile, 'Explicit temporary association fixture');
  await privateJson(path.join(profile, 'local-apps.json'), [{ id: 'fixture.existing-app', name: 'Explicit temporary app', path: appFile }]);
  vite = await viteServer({ configFile: path.join(root, 'vite.renderer.config.ts'), cacheDir: path.join(temporary, 'vite-cache'), server: { host: '127.0.0.1', port: 0 } }); await vite.listen();
  const url = `http://127.0.0.1:${vite.httpServer.address().port}/`, output = path.join(temporary, 'build');
  await build({ entryPoints: ['desktop/main/main.ts'], outfile: path.join(output, 'main.js'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], loader: { '.py': 'text', '.ps1': 'text' }, plugins: [{ name: 'fixture-observation', setup(builder) { builder.onLoad({ filter: /desktop[\\/]main[\\/]main\.ts$/ }, async args => {
    let contents = await readFile(args.path, 'utf8'); const anchor = 'store = new SettingsStore(directory, secretStorage, binary);'; assert(contents.includes(anchor));
    contents = contents.replace(anchor, `${anchor}\n(globalThis as any).kitFixtureStore=store;`); return { contents, loader: 'ts' };
  }); } }], define: { MAIN_WINDOW_VITE_DEV_SERVER_URL: JSON.stringify(url), MAIN_WINDOW_VITE_NAME: '"main_window"', PORTAL_DESKTOP_BUILD: '"kit-fixture"', PORTAL_DESKTOP_UPDATE_REPOSITORY: '"fixture/repo"' } });
  await build({ entryPoints: ['desktop/preload/preload.ts'], outfile: path.join(output, 'preload.js'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
  application = await launchDesktop({ executablePath: electron, args: [path.join(output, 'main.js')], cwd: root, env: { ...process.env, HOME: temporary, PORTAL_DESKTOP_USER_DATA: profile, PORTAL_DESKTOP_TEST_MOCK_KEYCHAIN: '1' } });
  const page = await application.firstWindow(); await page.locator('#client-main').waitFor({ state: 'visible' });
  await application.evaluate(({ protocol }, endpoint) => { protocol.handle('https', () => Response.json({ services: {}, kits: [], count: 0 })); globalThis.kitFixtureStore.connection = { endpoint, being: 'heart' }; }, endpoint);
  const descriptor = await wait(async () => { try { return JSON.parse(await readFile(path.join(profile, 'desktop-control-endpoint.json'), 'utf8')); } catch { return null; } });
  const desktopConfig = path.join(temporary, 'desktop-targets.json');
  const provision = { owner_id: 'owner', heart_id: 'heart', descriptor: path.join(profile, 'desktop-control-endpoint.json'), generation: 1, policy_revision: 1, state_root_id: 'store' };
  await privateJson(desktopConfig, [{ ...provision, target_id: 'desktop-B', controller_token: 'i'.repeat(40), executor: 'desktop_plugin_host' }, { ...provision, target_id: 'desktop-C', controller_token: 'j'.repeat(40), executor: 'os_app', app_associations: { [metadata.app_component_ref]: 'fixture.existing-app' } }]);
  await cli(['bind-desktop-controller', desktopConfig]);
  console.log('Actual Electron HMAC producer and Portal controller authenticated.');
  const planned = await cli(['plan', '--bundle', metadata.bundle, '--profile', 'basic', '--installation', 'full-kit', '--trust-user-computer']);
  assert.equal(planned.plan.projections.length, 1); assert.equal(planned.plan.desktop.length, 2); assert.equal(planned.plan.skills.length, 1);
  const preview = planned.plan.desktop.find(p => p.request.plan.payload.executor === 'desktop_plugin_host').preview;
  assert.deepEqual(preview.detail.added_capabilities, ['storage', 'agent.read', 'agent.write']); assert(preview.detail.sdk);
  const gate = path.join(temporary, 'managed-startup'); await writeFile(gate + '.hold', 'hold');
  await new Promise((resolve, reject) => { const child = execFile(binary, ['--state', state, 'configure-variable', '--operation', planned.plan.id, '--component', planned.plan.projections[0].component_ref, '--name', 'KIT_INSTALLER_PROBE_GATE'], (error) => error ? reject(error) : resolve()); child.stdin.end(gate); });
  committing = spawn(binary, ['--state', state, 'commit', '--operation', planned.plan.id, '--digest', planned.digest], { stdio: 'ignore' });
  await wait(async () => { if (committing.exitCode !== null) throw new Error('managed_commit_exited_before_startup'); try { return await readFile(gate, 'utf8') === 'started'; } catch { return false; } });
  committing.kill('SIGKILL'); await new Promise(resolve => committing.once('exit', resolve));
  await rm(gate + '.hold');
  await cli(['recover']); assert.equal(await readFile(gate + '.count', 'utf8'), '1');
  console.log('Full Kit committed through actual carriers.');
  const floating = application.windows().find(w => w !== page); assert(floating); await floating.frameLocator('.plugin-frame').locator('#full-kit-fixture').waitFor();
  const frame = await floating.locator('.plugin-frame').elementHandle().then(el => el.contentFrame()); await frame.evaluate(() => window.grove.saveData({ retained: 'full-kit' }));
  const evidence = path.join(root, 'output/playwright/kit-full-carriers'); await mkdir(evidence, { recursive: true });
  await floating.screenshot({ path: path.join(evidence, 'window.png') });
  const api = await NativeKitController.connect(descriptor.port, 'i'.repeat(40), b); client = api;
  const status = await api.request('desktop/host/status', {}); assert.equal(status[0].receipt.state, 'ready'); assert.equal(status[0].registered, true);
  const consumer = await NativeKitController.connect(descriptor.port, 'p'.repeat(40), b, 'kit-consumer');
  const catalog = await consumer.request('desktop/plugins/catalog', {}); assert.equal(catalog.tools.length, 2);
  const create = catalog.tools.find(t => t.inputSchema.properties.requestId).name;
  const call = { call: { name: create, arguments: { requestId: 'one', data: { title: 'Actual full Kit' } } }, trusted_call: { session_id: 'authenticated-fixture-origin', rpc_id: 'rpc_one' } };
  const result = await consumer.request('desktop/plugins/call', call); assert.equal(result.isError, undefined); assert.equal(JSON.parse(result.content[0].text).record.data.title, 'Actual full Kit');
  assert.deepEqual(await consumer.request('desktop/plugins/call', call), result);
  consumer.close();
  // Actual Portal ordinary MCP session -> P server proof -> L native ledger -> original Registry.
  mcpSocket = createConnection({ host: '127.0.0.1', port }); mcpSocket.setEncoding('utf8');
  await new Promise((resolve, reject) => { mcpSocket.once('connect', resolve); mcpSocket.once('error', reject); });
  const pending = new Map(); let lines = '', rpc = 0;
  mcpSocket.on('data', bytes => { lines += bytes; for (;;) { const i = lines.indexOf('\n'); if (i < 0) break; const response = JSON.parse(lines.slice(0, i)); lines = lines.slice(i + 1); const callback = pending.get(response.id); if (callback) { pending.delete(response.id); callback(response); } } });
  const mcp = (method, params, id = ++rpc) => new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(new Error('fixture_mcp_timeout')); }, 20000); pending.set(id, value => { clearTimeout(timer); resolve(value); }); mcpSocket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  assert.equal((await mcp('auth', { token: 'h'.repeat(40) })).error, undefined);
  const listed = await mcp('tools/list', {}); assert(listed.result.tools.some(t => t.name === create));
  const portalWrite = await mcp('tools/call', { name: create, arguments: { requestId: 'via-portal', data: { title: 'Actual Portal P+L' } } });
  assert.equal(portalWrite.result.isError, undefined); assert.equal(JSON.parse(portalWrite.result.content[0].text).record.data.title, 'Actual Portal P+L');
  const compatibility = await mcp('tools/call', { name: 'portal_exec', arguments: { command: '@kit-plugins' } });
  assert(compatibility.result.structuredContent.tools.some(t => t.name === create));
  for (const args of [{ plugin: 'fixture.full-board' }, { plugin: 'fixture.full-board', op: 'bogus' }, { plugin: 'fixture.full-board', op: 'CREATE' }]) {
    const denied = await mcp('tools/call', { name: 'portal_exec', arguments: { command: `@plugins ${JSON.stringify(args)}` } });
    assert.match(JSON.stringify(denied), /managed_legacy_entry_denied/);
  }
  const updated = await cli(['plan', '--bundle', metadata.update_bundle, '--profile', 'basic', '--installation', 'full-kit', '--trust-user-computer']);
  await cli(['commit', '--operation', updated.plan.id, '--digest', updated.digest]);
  assert.equal((await page.evaluate(() => window.beings.plugins.list())).plugins[0].manifest.version, '2.0.0');
  const failed = await cli(['plan', '--bundle', metadata.invalid_bundle, '--profile', 'basic', '--installation', 'full-kit', '--trust-user-computer']);
  await assert.rejects(() => cli(['commit', '--operation', failed.plan.id, '--digest', failed.digest]), /desktop_original_operation_missing/);
  const restored = (await api.request('desktop/host/status', {}))[0]; assert.equal(restored.receipt.state, 'ready'); assert.equal(restored.receipt.revision, 4);
  assert.equal((await page.evaluate(() => window.beings.plugins.list())).plugins[0].manifest.version, '2.0.0');
  const retired = await mcp('tools/call', { name: create, arguments: { requestId: 'old-name', data: { title: 'Must not run' } } });
  assert(retired.error || retired.result?.isError);
  // A separately launched controlled shim cannot turn Ready/active metadata
  // into another stdio business path, including after a real unknown write.
  const activeState = JSON.parse(await readFile(path.join(state, 'state.json'), 'utf8'));
  const activePlan = JSON.parse(await readFile(path.join(state, 'operations', activeState.installations['full-kit'].active_plan, 'plan.json'), 'utf8'));
  const toolsAfterRestore = await mcp('tools/list', {}), echo = toolsAfterRestore.result.tools.find(t => t.inputSchema.properties.message).name;
  const unknown = await mcp('tools/call', { name: echo, arguments: { message: 'unknown' } }); assert(unknown.error || unknown.result?.isError);
  const callsFile = path.join(state, 'data/full-kit', activePlan.projections[0].component_ref, 'calls'), countBefore = await readFile(callsFile, 'utf8');
  const deniedShim = async extraEnv => new Promise((resolve, reject) => {
    const child = spawn(binary, ['--state', state, 'run-component', '--operation', activePlan.id, '--component', activePlan.projections[0].component_ref], { env: { ...process.env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { error += bytes; });
    child.stdin.on('error', e => { if (e.code !== 'EPIPE') reject(e); }); child.on('error', reject); child.once('exit', code => resolve({ code, output, error }));
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 900, method: 'tools/call', params: { name: 'echo', arguments: { message: 'bypass' } } }) + '\n');
  });
  let denied = await deniedShim({}); assert.notEqual(denied.code, 0); assert.match(denied.error, /managed_host_spawn_required/); assert.equal(denied.output, '');
  denied = await deniedShim({ KIT_PORTAL_SPAWN_NONCE: '0'.repeat(64), KIT_PORTAL_PROCESS_GENERATION: '1' }); assert.notEqual(denied.code, 0); assert.equal(denied.output, '');
  const controlFile = path.join(state, 'controller.json'); await rename(controlFile, controlFile + '.offline');
  try { denied = await deniedShim({}); assert.notEqual(denied.code, 0); assert.match(denied.error, /unsupported_managed_admission/); }
  finally { await rename(controlFile + '.offline', controlFile); }
  assert.equal(await readFile(callsFile, 'utf8'), countBefore);
  await cli(['disable', 'full-kit']); assert.equal((await api.request('desktop/host/status', {}))[0].receipt.state, 'stopped');
  await cli(['enable', 'full-kit']);
  assert((await api.request('desktop/host/status', {}))[0].receipt.revision > 1);
  const reconnected = await freshMcpSession(port);
  try {
    const listing = await reconnected.call('tools/list', {}), freshEcho = listing.result.tools.find(t => t.inputSchema.properties.message).name;
    const stillUnknown = await reconnected.call('tools/call', { name: freshEcho, arguments: { message: 'must-remain-fenced-after-reconnect-and-new-alias' } });
    assert(stillUnknown.error || stillUnknown.result?.isError); assert.equal(await readFile(callsFile, 'utf8'), countBefore);
    const current = JSON.parse(await readFile(path.join(state, 'state.json'), 'utf8'));
    const currentPlan = JSON.parse(await readFile(path.join(state, 'operations', current.installations['full-kit'].active_plan, 'plan.json'), 'utf8'));
    const native = (currentPlan.projections[0].manifest.name + '_echo').replaceAll('-', '_');
    const deniedOld = await reconnected.call('tools/call', { name: native, arguments: { message: 'old-stdio-bypass' } }); assert(deniedOld.error || deniedOld.result?.isError);
    assert.equal(await readFile(callsFile, 'utf8'), countBefore);
  } finally { reconnected.close(); }
  await cli(['uninstall', 'full-kit']); assert.equal(await readFile(appFile, 'utf8'), 'Explicit temporary association fixture');
  const pluginData = JSON.parse(await readFile(path.join(profile, 'plugins/data/fixture.full-board.json'), 'utf8')); assert.deepEqual(pluginData, { retained: 'full-kit' });
  assert.equal((await page.evaluate(() => window.beings.plugins.list())).plugins.length, 0);
  await writeFile(path.join(evidence, 'acceptance.json'), JSON.stringify({ format_version: 1, boundary: 'isolated actual frozen binaries with fixture identities and mock keychain; no real Heart/Home/production', passed_at: new Date().toISOString(), portal_binary_sha256: portalHash, installer_binary_sha256: installerHash, executors: ['portal_mcp', 'desktop_plugin_host', 'os_app'], sdk: preview.detail.sdk, preview_added_capabilities: preview.detail.added_capabilities, revision_restored: restored.receipt.revision, checks: ['required authenticated managed admission', 'one-use Portal spawn nonce with actual OS parent', 'controlled shim rejects missing proof, forged proof and missing controller after unknown', 'CLI SIGKILL during actual managed startup recovers without duplicate spawn', 'signed exact closure', 'actual CLI confirmation', 'Portal MCP real tools/list Ready', 'Electron original Plugin real SDK Ready', 'explicit Root stable App ID association', 'ordinary Portal MCP alias write via secure P and L', 'same-RPC replay', '@kit-plugins catalog', 'old @plugins pre-HTTP denial incl invalid op', 'v1 to v2 update', 'failed v3 compensation to v2 under fresh revision4', 'retired alias denial', 'disable and fresh enable', 'uninstall preserves private data and OS program'] }, null, 2));
  console.log('PASS: actual frozen CLI/Electron/Portal full Kit, authenticated one-use parent-bound spawn, startup SIGKILL/recover-once, no-controller/forged standalone shim and old stdio denial after unknown/reconnect; SDK Ready, v1/v2/failed-v3 compensation/fresh aliases, disable/enable/uninstall, data/program retained. No real Heart claimed.');
} finally {
  if (committing?.exitCode === null) committing.kill('SIGKILL');
  mcpSocket?.destroy(); client?.close(); if (application) await application.close(); if (vite) await vite.close();
  if (portal?.exitCode === null) { portal.kill('SIGTERM'); await Promise.race([new Promise(resolve => portal.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]); if (portal.exitCode === null) portal.kill('SIGKILL'); }
  await rm(temporary, { recursive: true, force: true });
}
