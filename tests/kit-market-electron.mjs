// Genuine HTTP market -> isolated actual Electron -> actual CLI -> secure real
// Portal + original Desktop SDK. Fixture Heart identity is not DEV acceptance.
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { createServer as viteServer } from 'vite';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import electron from 'electron';
import { launchDesktop } from './support/electron-lifecycle.mjs';
const run = promisify(execFile), root = process.cwd(), installerRoot = process.env.KIT_INSTALLER_ROOT, portalSource = process.env.KIT_PORTAL_BINARY;
const referenceMode = process.env.KIT_EXISTING_PLUGIN_REFERENCE === '1';
if (!installerRoot || !portalSource || !path.isAbsolute(installerRoot) || !path.isAbsolute(portalSource)) throw new Error('Explicit absolute KIT_INSTALLER_ROOT and KIT_PORTAL_BINARY required');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'kit-market-ui-')), profile = path.join(temporary, 'profile'), fixture = path.join(temporary, 'fixture');
let application, market, vite, portal, mcp;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const privateJson = (file, value) => writeFile(file, JSON.stringify(value), { mode: 0o600 });
const wait = async (check, timeout = 45000) => { const until = Date.now() + timeout; for (;;) { const result = await check(); if (result) return result; if (Date.now() > until) throw new Error('market_fixture_timeout'); await new Promise(resolve => setTimeout(resolve, 50)); } };
async function mcpSession(port) {
  const socket = createConnection({ host: '127.0.0.1', port }); socket.setEncoding('utf8');
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  let buffer = '', next = 0; const pending = new Map();
  socket.on('data', data => { buffer += data; for (;;) { const n = buffer.indexOf('\n'); if (n < 0) break; const value = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1); pending.get(value.id)?.(value); pending.delete(value.id); } });
  const call = (method, params) => new Promise((resolve, reject) => { const id = ++next; const timer = setTimeout(() => reject(new Error('market_mcp_timeout')), 20000); pending.set(id, value => { clearTimeout(timer); resolve(value); }); socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  await call('auth', { token: 'h'.repeat(40) }); return { call, close: () => socket.destroy() };
}
try {
  await mkdir(profile); await mkdir(fixture); await mkdir(path.join(temporary, 'workspace'));
  await run('cargo', ['test', '--locked', '--manifest-path', path.join(installerRoot, 'Cargo.toml'), '--test', 'desktop_fixture', '--', '--ignored'], { cwd: installerRoot, env: { ...process.env, KIT_DESKTOP_FIXTURE_OUT: fixture }, maxBuffer: 1024 * 1024 });
  await run('cargo', ['build', '--locked', '--manifest-path', path.join(installerRoot, 'Cargo.toml')], { cwd: installerRoot, maxBuffer: 1024 * 1024 });
  const metadata = JSON.parse(await readFile(path.join(fixture, 'fixture.json'))), routes = new Map(), requests = [];
  for (const descriptor of [metadata.market_bundle, metadata.market_update_bundle]) {
    const bundle = JSON.parse(await readFile(descriptor));
    for (const item of bundle.releases) {
      const prefix = `/private/v1/releases/${item.release.payload.release_id}`;
      routes.set(`${prefix}/metadata`, Buffer.from(JSON.stringify(item.release))); routes.set(`${prefix}/status`, Buffer.from(JSON.stringify({ release_id: item.release.payload.release_id, publisher_id: 'fixture', maintenance: 'maintained', current: 'published', signed: item.status })));
      routes.set(`${prefix}/lock`, await readFile(item.lock)); routes.set(`${prefix}/package`, await readFile(item.archive));
    }
  }
  market = createServer((request, response) => { requests.push(request.url); const body = routes.get(request.url); response.writeHead(body ? 200 : 404, { 'content-type': 'application/octet-stream' }); response.end(body || 'missing'); });
  await new Promise(resolve => market.listen(0, '127.0.0.1', resolve));
  const binary = path.join(temporary, 'kit-installer'), portalBinary = path.join(temporary, 'heart-portal');
  const installerBytes = await readFile(path.join(installerRoot, 'target/debug/kit-installer')), portalBytes = await readFile(portalSource);
  await writeFile(binary, installerBytes, { mode: 0o700 }); await writeFile(portalBinary, portalBytes, { mode: 0o700 });
  await privateJson(path.join(profile, 'kit-product.json'), { format_version: 1, development_runtime: { installer: binary, installer_sha256: sha(installerBytes), portal: portalBinary, portal_sha256: sha(portalBytes) }, markets: [{ id: 'private-fixture', label: 'Private fixture market', base_url: `http://127.0.0.1:${market.address().port}/private/`, root: JSON.parse(await readFile(metadata.root)), root_digest: metadata.root_digest, allow_http_loopback: true }] });
  const moduleFile = path.join(temporary, 'bootstrap.mjs');
  await build({ stdin: { contents: "export {bootstrapKitProduct} from './desktop/main/kits/product-bootstrap.ts'; export {NativeKitController} from './desktop/main/kits/native-controller.ts'; export {PluginRegistry,readPlugin} from './desktop/main/plugins/registry.ts';", resolveDir: root }, bundle: true, platform: 'node', format: 'esm', outfile: moduleFile });
  const { bootstrapKitProduct, NativeKitController, PluginRegistry, readPlugin } = await import(pathToFileURL(moduleFile));
  const endpoint = 'https://fixture.invalid/heart', connection = { endpoint, being: 'heart', token: 'fixture-only', relaySecret: 'fixture-only', link: endpoint };
  const legacyDirectory = path.join(temporary, '.heart-portal', 'kits', 'unmanaged'); await mkdir(legacyDirectory, { recursive: true });
  const legacyManifest = JSON.stringify({ name: 'fixture-legacy-unmanaged', version: '1.0.0', command: ['python3', path.join(legacyDirectory, 'server.py')], tools: [{ name: 'echo', description: 'Existing unmanaged fixture', params: { type: 'object', properties: { legacyMarker: { type: 'string' } }, required: ['legacyMarker'] } }] });
  await writeFile(path.join(legacyDirectory, 'manifest.json'), legacyManifest);
  await writeFile(path.join(legacyDirectory, 'server.py'), `import json,sys\nfor line in sys.stdin:\n r=json.loads(line)\n if 'id' not in r: continue\n method=r['method']\n if method=='initialize': value={'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'legacy','version':'1'}}\n elif method=='tools/list': value={'tools':[{'name':'echo','description':'Existing unmanaged fixture','inputSchema':{'type':'object','properties':{'legacyMarker':{'type':'string'}},'required':['legacyMarker']}}]}\n else: value={'content':[{'type':'text','text':'legacy-ok'}]}\n print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':value}),flush=True)\n`);
  // One independent operator source file; automatic bootstrap produces all
  // private A/B/C and distinct I/P/L scopes, state ownership and source pins.
  await bootstrapKitProduct(profile, path.join(temporary, 'resources'), false, connection, path.join(temporary, '.heart-portal', 'kits'));
  let originalPlugin;
  if (referenceMode) {
    originalPlugin = await readPlugin(metadata.legacy_plugin_dir);
    await new PluginRegistry(path.join(profile, 'plugins')).install(originalPlugin, { kind: 'local' });
  }
  const keys = JSON.parse(await readFile(path.join(profile, 'kit-local-authority.json'))), managed = JSON.parse(await readFile(path.join(profile, 'kit-portal-profile.json')));
  assert.equal(new Set([keys.a, keys.i, keys.j, keys.p, keys.l]).size, 5);
  const config = path.join(temporary, 'portal.toml');
  await writeFile(config, `name="market-fixture"\nbind="127.0.0.1:${keys.port}"\nworkspace=${JSON.stringify(path.join(temporary, 'workspace'))}\nkits_dir=${JSON.stringify(managed.kitsDir)}\nportal_mcp_token="${'h'.repeat(40)}"\n[subagent]\nenabled=false\nauto_install=false\n${managed.fragment}`, { mode: 0o600 });
  portal = spawn(portalBinary, ['--config', config], { env: { ...process.env, HOME: temporary, HEART_PORTAL_SUPERVISED: '1', HEART_PORTAL_CLIENT_MANAGED: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let portalError = ''; portal.stderr.on('data', bytes => { portalError += bytes; });
  await wait(async () => { if (portal.exitCode !== null) throw new Error(`market_fixture_portal_exited:${portalError.slice(0, 300)}`); try { const c = await NativeKitController.connect(keys.port, keys.a, { owner_id: keys.owner, heart_id: 'heart', target_id: keys.targetA, authority: 'local' }); c.close(); return true; } catch { return false; } });
  vite = await viteServer({ configFile: path.join(root, 'vite.renderer.config.ts'), cacheDir: path.join(temporary, 'vite-cache'), server: { host: '127.0.0.1', port: 0 } }); await vite.listen();
  const url = `http://127.0.0.1:${vite.httpServer.address().port}/`, output = path.join(temporary, 'build');
  await build({ entryPoints: ['desktop/main/main.ts'], outfile: path.join(output, 'main.js'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], loader: { '.py': 'text', '.ps1': 'text' }, plugins: [{ name: 'fixture-existing-heart', setup(builder) { builder.onLoad({ filter: /desktop[\\/]main[\\/]main\.ts$/ }, async args => {
    let contents = await readFile(args.path, 'utf8'); const anchor = 'store = new SettingsStore(directory, secretStorage, binary);'; assert(contents.includes(anchor));
    contents = contents.replace(anchor, `${anchor}\nstore.connection=${JSON.stringify(connection)};store.settings.permissionMode='full-access';store.settings.portalBinary=${JSON.stringify(portalBinary)};store.settings.workspace=${JSON.stringify(path.join(temporary, 'workspace'))};`); return { contents, loader: 'ts' };
  }); } }], define: { MAIN_WINDOW_VITE_DEV_SERVER_URL: JSON.stringify(url), MAIN_WINDOW_VITE_NAME: '"main_window"', PORTAL_DESKTOP_BUILD: '"market-fixture"', PORTAL_DESKTOP_UPDATE_REPOSITORY: '"fixture/repo"' } });
  await build({ entryPoints: ['desktop/preload/preload.ts'], outfile: path.join(output, 'preload.js'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
  application = await launchDesktop({ executablePath: electron, args: [path.join(output, 'main.js')], cwd: root, env: { ...process.env, HOME: temporary, PORTAL_DESKTOP_USER_DATA: profile, PORTAL_DESKTOP_TEST_MOCK_KEYCHAIN: '1' } });
  const page = await application.firstWindow(); await page.locator('#client-main').waitFor();
  const appFile = path.join(temporary, 'explicit-user-app'); await writeFile(appFile, 'User selected original OS App; never delete');
  await application.evaluate(({ dialog, protocol }, appFile) => { globalThis.marketConfirmAllowed = false; globalThis.marketConfirms = 0; globalThis.pluginReferences = 0; globalThis.appChoices = 0; dialog.showOpenDialog = async () => { globalThis.appChoices++; return { canceled: false, filePaths: [appFile] }; }; dialog.showMessageBox = async (_window, input) => { if (input.title === '复用现有原生插件') { globalThis.pluginReferences++; return { response: 1 }; } if (input.title === 'Kit 安装确认') globalThis.marketConfirms++; return { response: globalThis.marketConfirmAllowed ? 1 : 0 }; }; protocol.handle('https', () => Response.json({ services: {}, kits: [], count: 0 })); }, appFile);
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '更多功能', exact: true }).click(); await page.getByRole('dialog', { name: '更多功能' }).getByRole('button', { name: '工具库', exact: true }).click();
  await page.getByLabel('Kit 发布 UUID').fill('638db5e1-b2f2-4b12-952f-0aff3e85bb90'); await page.getByRole('button', { name: '预览安装计划', exact: true }).click();
  await page.getByRole('region', { name: 'Kit 安装预览' }).waitFor({ timeout: 60000 });
  assert.equal(await page.getByRole('region', { name: 'Kit 安装预览' }).getByText(/SDK、能力/).count(), 2);
  const nativeConfig = JSON.parse(await readFile(path.join(profile, 'kit-markets.json'))), state = nativeConfig.markets[0].state;
  const cli = async args => JSON.parse((await run(binary, ['--state', state, ...args], { maxBuffer: 8 * 1024 * 1024 })).stdout);
  assert.deepEqual(await cli(['list']), {}); assert.deepEqual(await readdir(managed.kitsDir), ['unmanaged']); assert.equal(await application.evaluate(() => globalThis.appChoices), 1);
  assert.equal((await application.windows()).length, 1); // No SDK view/Ready/code before confirmation.
  const evidence = path.join(root, 'output/playwright', referenceMode ? 'kit-market-reference' : 'kit-market'); await mkdir(evidence, { recursive: true });
  await page.getByRole('region', { name: 'Kit 安装预览' }).screenshot({ path: path.join(evidence, 'preview.png') });
  await page.getByRole('button', { name: '确认安装', exact: true }).click(); await wait(() => application.evaluate(() => globalThis.marketConfirms === 1)); assert.deepEqual(await cli(['list']), {});
  await application.evaluate(() => { globalThis.marketConfirmAllowed = true; });
  await page.getByRole('button', { name: '确认安装', exact: true }).click();
  const installation = await wait(async () => Object.values(await cli(['list']))[0]); assert.equal(installation.enabled, true);
  await wait(async () => application.windows().length === 2); const floating = application.windows().find(w => w !== page); await floating.frameLocator('.plugin-frame').locator('#full-kit-fixture').waitFor();
  const operation = JSON.parse(await readFile(path.join(state, 'operations', installation.active_plan, 'plan.json')));
  assert.equal(operation.projections.length, 1); assert.equal(operation.desktop.length, 2); assert.equal(operation.skills.length, 1);
  assert(operation.desktop.some(p => p.preview.detail.sdk && (referenceMode ? p.preview.detail.external_reference : p.preview.detail.added_capabilities.includes('agent.write'))));
  if (referenceMode) assert.equal(await application.evaluate(() => globalThis.pluginReferences), 1);
  const receipts = JSON.parse(await readFile(path.join(state, 'operations', installation.active_plan, 'host-receipts.json'))); assert.equal(receipts[0].state, 'ready');
  mcp = await mcpSession(keys.port);
  const catalog = await mcp.call('tools/list', {}), nativeAlias = catalog.result.tools.find(t => t.inputSchema?.properties?.requestId)?.name, mcpAlias = catalog.result.tools.find(t => t.inputSchema?.properties?.message)?.name;
  assert(nativeAlias && mcpAlias);
  const created = await mcp.call('tools/call', { name: nativeAlias, arguments: { requestId: 'market-ui-one', data: { title: 'Installed through market UI' } } });
  assert.equal(created.result.isError, undefined); assert.equal(JSON.parse(created.result.content[0].text).record.data.title, 'Installed through market UI');
  const echoed = await mcp.call('tools/call', { name: mcpAlias, arguments: { message: 'market' } }); assert(echoed.result.content[0].text.startsWith('market|'));
  const legacyAlias = catalog.result.tools.find(t => t.inputSchema?.properties?.legacyMarker)?.name; assert(legacyAlias);
  const legacyResult = await mcp.call('tools/call', { name: legacyAlias, arguments: { legacyMarker: 'existing-baseline' } }); assert.equal(legacyResult.result.content[0].text, 'legacy-ok');
  // Same Kit selection updates the same owned installation after a fresh preview.
  if (!referenceMode) {
    await page.getByLabel('Kit 发布 UUID').fill('638db5e1-b2f2-4b12-952f-0aff3e85bb91'); await page.getByRole('button', { name: '预览安装计划', exact: true }).click(); await page.getByRole('region', { name: 'Kit 安装预览' }).waitFor({ timeout: 60000 }); await page.getByRole('button', { name: '确认安装', exact: true }).click();
    await wait(async () => Object.values(await cli(['list']))[0]?.revision === 2);
    const retired = await mcp.call('tools/call', { name: nativeAlias, arguments: { requestId: 'retired', data: { title: 'Must reject' } } }); assert(retired.error || retired.result?.isError);
  } else {
    await page.getByLabel('Kit 发布 UUID').fill('638db5e1-b2f2-4b12-952f-0aff3e85bb91'); await page.getByRole('button', { name: '预览安装计划', exact: true }).click();
    await page.getByRole('region', { name: '安装完整 Kit' }).getByRole('alert').waitFor({ timeout: 60000 });
    const unchanged = Object.values(await cli(['list']))[0]; assert.equal(unchanged.revision, 1); assert.equal(unchanged.enabled, true);
    assert.equal((await new PluginRegistry(path.join(profile, 'plugins')).nativeObservation(originalPlugin.manifest.id)).installed.sha256, originalPlugin.sha256);
  }
  await page.getByRole('region', { name: '安装完整 Kit' }).getByRole('button', { name: '停用', exact: true }).click(); await wait(async () => !Object.values(await cli(['list']))[0]?.enabled);
  await page.getByRole('region', { name: '安装完整 Kit' }).getByRole('button', { name: '启用', exact: true }).click(); await wait(async () => Object.values(await cli(['list']))[0]?.enabled && Object.values(await cli(['list']))[0]?.revision > (referenceMode ? 1 : 2));
  await page.getByRole('region', { name: '安装完整 Kit' }).getByRole('button', { name: '卸载', exact: true }).click(); await wait(async () => Object.values(await cli(['list']))[0]?.removed);
  await page.getByRole('region', { name: '安装完整 Kit' }).getByRole('button', { name: '卸载', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await readFile(appFile, 'utf8'), 'User selected original OS App; never delete');
  assert.equal(await readFile(path.join(legacyDirectory, 'manifest.json'), 'utf8'), legacyManifest);
  if (referenceMode) { const retained = await new PluginRegistry(path.join(profile, 'plugins')).nativeObservation(originalPlugin.manifest.id); assert.equal(retained.installed.sha256, originalPlugin.sha256); assert.equal(retained.installed.source.kind, 'local'); }
  await page.screenshot({ path: path.join(evidence, 'market.png') });
  await writeFile(path.join(evidence, 'acceptance.json'), JSON.stringify({ accepted: true, at: new Date().toISOString(), portal_sha256: sha(portalBytes), installer_sha256: sha(installerBytes), market: 'genuine isolated HTTP fixture', root: 'independently operator-pinned private fixture Root', controller_bootstrap: 'automatic distinct A/B/C I/P/L', checks: ['exact signed UUID/full closure', 'native explicit original App selection without Root local ID', 'actual SDK/capability delta preview', 'no code or projection before confirmation', 'native cancellation blocks commit', 'actual UI confirm -> CLI -> Portal Ready + SDK Ready + App associated', 'ordinary Portal MCP -> P/L -> original SDK business call', 'ordinary managed MCP alias actual stdio business call', 'unmanaged old library remains at same path and callable under HostPolicy', ...(referenceMode ? ['explicit native ID+digest original Plugin reference', 'different content cannot update an existing referenced original', 'uninstall retains original source identity and bytes'] : ['same-installation update retires old native alias']), 'UI disable/fresh reviewed enable/uninstall retains OS App'], real_heart: false, home_identity: false, production: false }, null, 2));
  console.log('PASS: genuine market -> explicit Electron confirmation -> real CLI/Portal/SDK lifecycle.');
} finally {
  mcp?.close(); if (application) await application.close(); if (portal?.exitCode === null) { portal.kill('SIGTERM'); await new Promise(resolve => portal.once('exit', resolve)); } if (vite) await vite.close(); if (market) await new Promise(resolve => market.close(resolve)); await rm(temporary, { recursive: true, force: true });
}
