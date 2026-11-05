// Actual Mac SDK/App + production native Home client/hosts. The fixture token
// store and OS keychain are explicit boundaries; Home is a real TLS AppState/DB.
import { build } from 'esbuild';
import { createServer as viteServer } from 'vite';
import { createServer as netServer, createConnection } from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, appendFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import assert from 'node:assert/strict';
import electron from 'electron';
import { launchDesktop } from './support/electron-lifecycle.mjs';
const root = process.cwd(), run = promisify(execFile), hash = v => createHash('sha256').update(v).digest('hex');
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
assert.equal(process.platform, 'darwin'); assert.equal(config.format_version, 1);
assert(path.isAbsolute(config.portal_binary)); assert.match(config.portal_sha256, /^[a-f0-9]{64}$/);
const temporary = await mkdtemp(path.join(os.tmpdir(), 'kit-real-home-desktop-')), profile = path.join(temporary, 'profile');
await chmod(temporary, 0o700); await mkdir(profile, { mode: 0o700 });
let application, vite, portal, portalSocket, closed = false;
// Kept outside the disposable profile: fixed codes/counts only, never tokens,
// payload values, channel UUIDs, URLs, paths, plugin content or business results.
const diagnosticRoot = await mkdtemp(path.join(os.tmpdir(), 'kit-home-native-safe-diagnostics-'));
await chmod(diagnosticRoot, 0o700);
const diagnosticFile = path.join(diagnosticRoot, 'channel.ndjson');
await writeFile(diagnosticFile, '', { mode: 0o600 });
const retainDiagnostics = async phase => {
  try {
    const trace = application ? await application.evaluate(() => globalThis.actualNativeChannelDiagnostics || []) : [];
    await appendFile(diagnosticFile, JSON.stringify({ phase, trace }) + '\n');
  } catch { await appendFile(diagnosticFile, JSON.stringify({ phase, code: 'diagnostic_snapshot_unavailable' }) + '\n').catch(() => {}); }
};
process.stderr.write(JSON.stringify({ event: 'actual_native_safe_diagnostics', file: diagnosticFile }) + '\n');
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const wait = async check => { const until = Date.now() + 30000; while (!await check()) { if (Date.now() > until) throw new Error('actual_native_condition_timeout'); await new Promise(r => setTimeout(r, 25)); } };
const stopChild = async child => { if (!child || child.exitCode !== null || child.signalCode !== null) return; child.kill('SIGTERM'); await wait(async () => child.exitCode !== null || child.signalCode !== null); };
async function portalRpc(method, params) {
  if (!portalSocket) {
    portalSocket = createConnection({ host: '127.0.0.1', port: globalThis.actualGatePort }); portalSocket.setEncoding('utf8');
    await new Promise((resolve, reject) => { portalSocket.once('connect', resolve); portalSocket.once('error', reject); });
    let buffer = ''; globalThis.actualPortalPending = new Map(); globalThis.actualPortalRpc = 0;
    portalSocket.on('data', chunk => { buffer += chunk; for (;;) { const at = buffer.indexOf('\n'); if (at < 0) break; const response = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1); const done = globalThis.actualPortalPending.get(response.id); if (done) { globalThis.actualPortalPending.delete(response.id); done(response); } } });
    await portalRpc('auth', { token: 'h'.repeat(40) });
  }
  const id = ++globalThis.actualPortalRpc;
  return new Promise((resolve, reject) => { const timer = setTimeout(() => { globalThis.actualPortalPending.delete(id); reject(new Error('actual_gate_rpc_timeout')); }, 15000); globalThis.actualPortalPending.set(id, value => { clearTimeout(timer); resolve(value); }); portalSocket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
}
async function snapshot() {
  const state = await application.evaluate(async () => ({ peers: globalThis.actualNativeHosts.state(), plugins: (await globalThis.actualNativeRegistry.list()).plugins.map(p => ({ id: p.manifest.id, version: p.manifest.version, enabled: p.enabled, source: p.source.kind })), confirmations: globalThis.actualConfirmations, sdkOpens: globalThis.actualSdkOpens, recoveryWarningObserved: globalThis.actualRecoveryWarningObserved, deltaObserved: globalThis.actualCapabilityDelta, cancelledAfterSdkReady: globalThis.actualCancelledAfterSdkReady, lostSdkInstance: globalThis.actualLostSdkInstance, sdk: await globalThis.actualNativeRegistry.managedStatus('fixture.home-board').then(async p => p.installed ? await globalThis.actualNativeRegistry.readyObservation('fixture.home-board', p.installed.sha256) : null), data: await globalThis.actualNativeRegistry.dataSnapshot('fixture.home-board'), commands: globalThis.actualNativeTrace }));
  state.storage_sha256 = hash(JSON.stringify(Object.fromEntries(Object.entries(state.data).sort()))); delete state.data;
  const page = (await application.firstWindow()); const floating = application.windows().find(w => w !== page && !w.isClosed());
  if (floating) {
    const handle = await floating.locator('.plugin-frame').elementHandle(); const frame = handle && await handle.contentFrame();
    if (frame) { const data = await frame.evaluate(() => window.grove.agent.snapshot()); state.records = data.records.length; state.records_sha256 = hash(JSON.stringify(data.records)); }
  }
  return state;
}
async function close() {
  if (closed) return; closed = true;
  try { await retainDiagnostics('before_close'); if (application) await application.evaluate(async () => { await globalThis.actualNativeHosts?.stop(); }); await retainDiagnostics('after_close'); }
  finally { portalSocket?.destroy(); try { if (application) await application.close(); }
    finally { try { await stopChild(portal); } finally { if (vite) await vite.close(); await rm(temporary, { recursive: true, force: true }); } } }
}
process.once('SIGTERM', () => { void close().finally(() => process.exit(143)); });

try {
  const bytes = await readFile(config.portal_binary); assert.equal(hash(bytes), config.portal_sha256);
  const frozenPortal = path.join(temporary, 'heart-portal'); await writeFile(frozenPortal, bytes, { mode: 0o700 });
  const software = JSON.parse((await run(frozenPortal, ['--kit-runtime-capabilities'])).stdout); assert(software.features.includes('home.native-reservations.v1'));
  const reservation = path.join(profile, 'home-native-reservations.json'); await writeFile(reservation, JSON.stringify({ format_version: 1, plugin_ids: [] }), { mode: 0o600 });
  const listener = netServer(); await new Promise(r => listener.listen(0, '127.0.0.1', r)); globalThis.actualGatePort = listener.address().port; await new Promise(r => listener.close(r));
  const workspace = path.join(temporary, 'workspace'), kits = path.join(temporary, 'legacy-kits'); await mkdir(workspace); await mkdir(kits);
  const portalConfig = path.join(temporary, 'portal.toml');
  await writeFile(portalConfig, `name="actual-home-desktop-gate"\nbind="127.0.0.1:${globalThis.actualGatePort}"\nworkspace=${JSON.stringify(workspace)}\nkits_dir=${JSON.stringify(kits)}\nportal_mcp_token="${'h'.repeat(40)}"\nhome_native_reservations=${JSON.stringify(reservation)}\n[subagent]\nenabled=false\nauto_install=false\n`, { mode: 0o600 });
  const gateEnv = { ...process.env, HOME: temporary, HEART_PORTAL_SUPERVISED: '1', HEART_PORTAL_CLIENT_MANAGED: '1' }; delete gateEnv.PORTAL_MCP_TOKEN; delete gateEnv.LOOM_URL;
  portal = spawn(frozenPortal, ['--config', portalConfig], { env: gateEnv, stdio: ['ignore', 'ignore', 'pipe'] });
  await wait(async () => { const s = createConnection({ host: '127.0.0.1', port: globalThis.actualGatePort }); return new Promise(r => { s.once('connect', () => { s.destroy(); r(true); }); s.once('error', () => { s.destroy(); r(false); }); }); });
  assert.equal((await portalRpc('tools/list', {})).error, undefined);
  vite = await viteServer({ configFile: path.join(root, 'vite.renderer.config.ts'), cacheDir: path.join(temporary, 'vite-cache'), server: { host: '127.0.0.1', port: 0 } }); await vite.listen();
  const output = path.join(temporary, 'build'), url = `http://127.0.0.1:${vite.httpServer.address().port}/`;
  await build({ entryPoints: ['desktop/main/main.ts'], outfile: path.join(output, 'main.js'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], loader: { '.py': 'text', '.ps1': 'text' }, plugins: [{ name: 'actual-home-test-observation', setup(builder) { builder.onLoad({ filter: /desktop[\\/]main[\\/]main\.ts$/ }, async args => { let contents = await readFile(args.path, 'utf8'); const anchor = 'pluginWindows = new PluginWindows(plugins, shellURL, () => window, () => appearance);'; assert(contents.includes(anchor)); contents = contents.replace(anchor, `${anchor}\n(globalThis as any).actualRequire=require;(globalThis as any).actualNativeRegistry=plugins;(globalThis as any).actualNativeWindows=pluginWindows;(globalThis as any).actualNativeStore=store;`); const app = "const localApps = new LocalApps(path.join(directory, 'local-apps.json'));"; assert(contents.includes(app)); contents = contents.replace(app, `${app}\n(globalThis as any).actualNativeApps=localApps;`); return { contents, loader: 'ts' }; }); } }], define: { MAIN_WINDOW_VITE_DEV_SERVER_URL: JSON.stringify(url), MAIN_WINDOW_VITE_NAME: '"main_window"', PORTAL_DESKTOP_BUILD: '"real-home-local-integration"', PORTAL_DESKTOP_UPDATE_REPOSITORY: '"fixture/repo"' } });
  await build({ entryPoints: ['desktop/preload/preload.ts'], outfile: path.join(output, 'preload.js'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
  const helper = path.join(output, 'native-runtime.cjs'); await build({ stdin: { contents: "export {HomeClient} from './desktop/main/home/client';export {NativeHomeDesktopHosts} from './desktop/main/home/desktop-hosts';export {HomeDesktopProducer} from './desktop/main/home/desktop-producer';export {HomeExecutorChannel} from './desktop/main/home/host-channel';export {DesktopHostFacts} from './desktop/main/kits/host-facts';export {durablePrivateJson} from './desktop/main/kits/durable-file';export {parseConnection} from './desktop/main/chat/connection';", resolveDir: root }, outfile: helper, bundle: true, platform: 'node', format: 'cjs' });
  await writeFile(path.join(profile, 'kit-home-host.json'), JSON.stringify({ format_version: 1, policy_revision: 1, allowed_plugin_capabilities: ['storage', 'agent.read', 'agent.write'], ca_file: config.home_ca }), { mode: 0o600 });
  application = await launchDesktop({ executablePath: electron, args: [path.join(output, 'main.js')], cwd: root, env: { ...process.env, HOME: temporary, PORTAL_DESKTOP_USER_DATA: profile, PORTAL_DESKTOP_TEST_MOCK_KEYCHAIN: '1', NODE_EXTRA_CA_CERTS: config.home_ca } });
  const page = await application.firstWindow(); await page.locator('#client-main').waitFor();
  await application.evaluate(async (_, input) => {
    const runtime = globalThis.actualRequire(input.helper), fs = globalThis.actualRequire('node:fs/promises'), path = globalThis.actualRequire('node:path');
    const connection = runtime.parseConnection(input.config.heart_link); globalThis.actualNativeStore.connection = connection;
    Object.assign(globalThis.actualNativeStore.settings, { permissionMode: 'full-access', allowExec: true, kitsEnabled: true, autoStart: false, backgroundEnabled: false, workspace: input.workspace });
    globalThis.actualSdkOpens = 0; globalThis.actualDenyPluginOnce = false; globalThis.actualRecoveryWarningObserved = false; globalThis.actualAllowed = true; globalThis.actualCancelAppOnce = false; globalThis.actualConfirmations = 0; globalThis.actualCapabilityDelta = false; globalThis.actualCancelledAfterSdkReady = false; globalThis.actualLosePrepareOnce = false; globalThis.actualLostSdkInstance = null;
    // Real HomeClient with a private fixture-only cipher store. No fake Home
    // methods, coordinator, enrollment receipt, HostReady or execution permit.
    const storage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from('fixture-token-store:' + value), decryptString: value => { const text = value.toString(); if (!text.startsWith('fixture-token-store:')) throw new Error('fixture_cipher_invalid'); return text.slice(20); } };
    const directory = path.join(input.profile, 'oauth-fixture'); await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const home = new runtime.HomeClient(directory, storage, async () => { throw new Error('interactive_oauth_not_part_of_fixture'); });
    const authority = { baseUrl: input.config.home_url, clientId: input.config.client_id }; await home.configure(authority);
    await runtime.durablePrivateJson(path.join(directory, 'home-session.json'), { formatVersion: 2, config: authority, credential: storage.encryptString(JSON.stringify({ authority, tokens: { access_token: input.config.access_token, expires_at: Date.now() + 3600000 } })).toString('base64') }); await home.load();
    if (!home.state().signedIn) throw new Error('actual_home_token_store_load_failed');
    globalThis.actualHomeClient = home;
    globalThis.actualNativeChannelDiagnostics = [];
    let diagnosticSequence = 0;
    const diagnostic = (code, channel, extra = {}) => {
      const event = { n: ++diagnosticSequence, code, epoch: Number.isSafeInteger(channel?.epoch) ? channel.epoch : null, sequence: Number.isSafeInteger(channel?.sequence) ? channel.sequence : null, queued: Number.isSafeInteger(channel?.queued) ? channel.queued : null, connected: !!channel?.state?.(), ...extra };
      globalThis.actualNativeChannelDiagnostics.push(event);
      if (globalThis.actualNativeChannelDiagnostics.length > 500) globalThis.actualNativeChannelDiagnostics.shift();
    };
    const channelPrototype = runtime.HomeExecutorChannel.prototype;
    const send = channelPrototype.send, disconnect = channelPrototype.disconnect;
    channelPrototype.send = function(message) {
      const type = ['hello', 'pong', 'reply', 'reauthenticate'].includes(message?.type) ? message.type : 'other';
      diagnostic('send_' + type, this, { reply_sequence: Number.isSafeInteger(message?.sequence) ? message.sequence : null, reply_rejected: message?.outcome?.status === 'rejected' });
      if (type === 'hello' && this.socket && !this.socket.actualDiagnosticAttached) {
        this.socket.actualDiagnosticAttached = true;
        this.socket.on('close', code => diagnostic('socket_close', this, { close_code: Number.isSafeInteger(code) ? code : null }));
        this.socket.on('error', () => diagnostic('socket_error', this));
        this.socket.on('message', (raw, binary) => {
          let message; try { message = binary ? null : JSON.parse(raw.toString('utf8')); } catch {}
          const kind = ['welcome', 'ping', 'authenticated', 'command'].includes(message?.type) ? message.type : 'other';
          const command = ['stage', 'file_chunk', 'prepare', 'dispatch', 'observe_owned', 'stop_owned', 'stop', 'app_associations'].includes(message?.command?.command) ? message.command.command : null;
          diagnostic('receive_' + kind, this, { command, frame_sequence: Number.isSafeInteger(message?.sequence) ? message.sequence : null });
        });
      }
      try { return send.call(this, message); } catch (error) { diagnostic('send_failed', this); throw error; }
    };
    channelPrototype.disconnect = function(socket) { diagnostic('disconnect', this, { socket_current: this.socket === socket }); return disconnect.call(this, socket); };
    const hostsPrototype = runtime.NativeHomeDesktopHosts.prototype, stopHosts = hostsPrototype.stop;
    hostsPrototype.stop = function() {
      for (const peer of this.peers || []) diagnostic('hosts_stop', peer.channel, { prepared: peer.producer.state.records.filter(r => r.phase === 'prepared').length, producer_active: !!peer.producer.active });
      return stopHosts.call(this);
    };
    globalThis.actualNativeTrace = [];
    const execute = runtime.HomeDesktopProducer.prototype.execute;
    runtime.HomeDesktopProducer.prototype.execute = async function(command, context) {
      try { const result = await execute.call(this, command, context); if (globalThis.actualLosePrepareOnce && command.command === 'prepare' && result?.host?.observation?.executor === 'desktop_plugin_host') { globalThis.actualLosePrepareOnce = false; globalThis.actualLostSdkInstance = result.host.observation.sdk_instance_id; throw new Error('fixture_prepare_result_lost_after_sdk_ready'); } globalThis.actualNativeTrace.push({ command: command.command, outcome: 'completed' }); return result; }
      catch (error) { globalThis.actualNativeTrace.push({ command: command.command, outcome: 'rejected', code: /^[a-z][a-z0-9_]{0,119}$/.test(error?.message || '') ? error.message : 'native_error_redacted' }); throw error; }
    };
    globalThis.actualNativeHosts = new runtime.NativeHomeDesktopHosts({ directory: input.profile, home, facts: new runtime.DesktopHostFacts(path.join(input.profile, 'kit-host-identity.json')), registry: globalThis.actualNativeRegistry, apps: globalThis.actualNativeApps,
      settings: () => globalThis.actualNativeStore.settings, connection: () => globalThis.actualNativeStore.connection,
      openPlugin: (id, view) => { globalThis.actualSdkOpens++; return globalThis.actualNativeWindows.open(id, view); }, closePlugin: id => globalThis.actualNativeWindows.close(id),
      confirm: async (message, detail) => { globalThis.actualConfirmations++; if (message.includes('重新打开') && detail.includes('初始化会再次运行') && detail.includes('请先核实外部结果') && detail.includes('不会清除先前不确定的业务结果')) globalThis.actualRecoveryWarningObserved = true; if (message.includes('插件') && globalThis.actualDenyPluginOnce) { globalThis.actualDenyPluginOnce = false; return false; } if (detail.includes('新增能力') && detail.includes('storage')) globalThis.actualCapabilityDelta = true; if (message.includes('App') && globalThis.actualCancelAppOnce) { const physical = await globalThis.actualNativeRegistry.nativeObservation('fixture.home-board'); const sdk = await globalThis.actualNativeRegistry.readyObservation('fixture.home-board', physical.installed.sha256); globalThis.actualCancelledAfterSdkReady = !!sdk && physical.installed.manifest.version === '3.0.0'; globalThis.actualCancelAppOnce = false; return false; } return globalThis.actualAllowed; },
      ensureLegacyGate: async () => {
        const metadata = JSON.parse(await fs.readFile(path.join(input.profile, 'home-native-reservations.json'), 'utf8'));
        if (metadata.format_version !== 1) throw new Error('actual_legacy_gate_not_verified');
        const crypto = globalThis.actualRequire('node:crypto');
        if (crypto.createHash('sha256').update(await fs.readFile(input.frozenPortal)).digest('hex') !== input.config.portal_sha256) throw new Error('actual_portal_binary_changed');
        process.kill(input.portalPid, 0);
        const child = globalThis.actualRequire('node:child_process');
        const capabilities = await new Promise((resolve, reject) => child.execFile(input.frozenPortal, ['--kit-runtime-capabilities'], { timeout: 5000 }, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout))));
        if (!capabilities.features.includes('home.native-reservations.v1')) throw new Error('actual_legacy_gate_unsupported');
      } });
    const program = path.join(input.profile, 'synthetic-user-program'); await fs.writeFile(program, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await globalThis.actualNativeApps.associate({ id: 'actual-user-selected-app', name: 'Synthetic existing user program' }, program);
    globalThis.actualProgram = program;
  }, { helper, profile, workspace, config, frozenPortal, portalPid: portal.pid });
  emit({ event: 'ready', oauth_backend: 'fixture', os_keychain: 'fixture', real_home_client: true, portal_sha256: config.portal_sha256 });
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    const command = JSON.parse(line); try {
      let result;
      switch (command.action) {
        case 'start': await application.evaluate(async () => globalThis.actualNativeHosts.start()); result = await snapshot(); break;
        case 'snapshot': result = await snapshot(); break;
        case 'allow': await application.evaluate((_, allowed) => { globalThis.actualAllowed = allowed; }, command.allowed); result = {}; break;
        case 'deny_plugin_once': await application.evaluate(() => { globalThis.actualDenyPluginOnce = true; }); result = {}; break;
        case 'lose_prepare_once': await application.evaluate(() => { globalThis.actualLosePrepareOnce = true; }); result = {}; break;
        case 'cancel_app_once': await application.evaluate(() => { globalThis.actualCancelAppOnce = true; }); result = {}; break;
        case 'close_sdk': await application.evaluate(() => globalThis.actualNativeWindows.close('fixture.home-board')); result = {}; break;
        case 'remove_app': await application.evaluate(async () => globalThis.actualNativeApps.remove('actual-user-selected-app')); result = {}; break;
        case 'legacy': result = await portalRpc('tools/call', { name: 'portal_exec', arguments: { command: '@plugins {"plugin":"fixture.home-board","op":"create","data":{"title":"Must not execute"}}' } }); break;
        case 'stop': await application.evaluate(async () => globalThis.actualNativeHosts.stop()); result = await snapshot(); break;
        case 'program': result = await application.evaluate(async () => { const fs = globalThis.actualRequire('node:fs/promises'); return { retained: (await fs.readFile(globalThis.actualProgram, 'utf8')) === '#!/bin/sh\nexit 0\n' }; }); break;
        case 'quit': await close(); emit({ event: 'response', id: command.id, result: {} }); process.exit(0); break;
        default: throw new Error('actual_driver_command_unknown');
      }
      await retainDiagnostics('action_' + command.action); emit({ event: 'response', id: command.id, result });
    } catch (error) { emit({ event: 'response', id: command.id, error: /^[a-z0-9_]+$/.test(error.message) ? error.message : 'actual_desktop_operation_failed' }); }
  }
} finally { await close(); }
