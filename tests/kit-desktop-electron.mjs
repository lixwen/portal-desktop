// Real Electron main/preload/sandbox/independent window, temporary profile only.
// Local @plugins command transport is exercised; this is not a real Heart test.
import { build } from 'esbuild';
import { createServer } from 'vite';
import electron from 'electron';
import { launchDesktop } from './support/electron-lifecycle.mjs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve('.');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'kit-desktop-electron-'));
const profile = path.join(temporary, 'profile'), source = path.join(temporary, 'plugin');
let application, server;
const manifest = { schemaVersion: 1, apiVersion: 1, minSdkVersion: '1.4.0', id: 'fixture.kit-board', name: 'Kit Board', version: '1.0.0', author: 'Fixture', description: 'Isolated UI regression', entry: 'index.html', capabilities: ['storage', 'agent.read', 'agent.write'], contributes: { views: [{ id: 'main', title: 'Kit Fixture' }], agent: { description: 'Fixture records', instructions: 'Only this fixture data', fields: { title: { type: 'string', title: 'Title', maxLength: 100 } }, required: ['title'] } } };
try {
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'desktop.plugin.json'), JSON.stringify(manifest));
  await writeFile(path.join(source, 'index.html'), '<h1 id="kit-fixture">Fixture v1</h1>');
  server = await createServer({ configFile: path.join(root, 'vite.renderer.config.ts'), cacheDir: path.join(temporary, 'vite-cache'), server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
  const directory = path.join(temporary, 'build');
  await build({ entryPoints: ['desktop/main/main.ts'], outfile: path.join(directory, 'main.js'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], loader: { '.py': 'text', '.ps1': 'text' }, plugins: [{ name: 'isolated-kit-instrumentation', setup(builder) {
    builder.onLoad({ filter: /desktop[\\/]main[\\/]main\.ts$/ }, async args => {
      let contents = await readFile(args.path, 'utf8');
      const anchor = 'store = new SettingsStore(directory, secretStorage, binary);';
      assert(contents.includes(anchor));
      contents = contents.replace(anchor, `${anchor}\n(globalThis as any).kitFixtureStore = store;\nstore.settings.workspace = ${JSON.stringify(path.join(temporary, 'workspace'))};`);
      const pluginAnchor = 'pluginWindows = new PluginWindows(plugins, shellURL, () => window, () => appearance);';
      assert(contents.includes(pluginAnchor));
      contents = contents.replace(pluginAnchor, `${pluginAnchor}\n(globalThis as any).kitFixtureRegistry = plugins;`);
      return { contents, loader: 'ts' };
    });
  } }], define: { MAIN_WINDOW_VITE_DEV_SERVER_URL: JSON.stringify(url), MAIN_WINDOW_VITE_NAME: '"main_window"', PORTAL_DESKTOP_BUILD: '"kit-fixture"', PORTAL_DESKTOP_UPDATE_REPOSITORY: '"fixture/repo"' } });
  await build({ entryPoints: ['desktop/preload/preload.ts'], outfile: path.join(directory, 'preload.js'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
  application = await launchDesktop({ executablePath: electron, args: [path.join(directory, 'main.js')], cwd: root, env: { ...process.env, HOME: temporary, PORTAL_DESKTOP_USER_DATA: profile, PORTAL_DESKTOP_TEST_MOCK_KEYCHAIN: '1' } });
  const page = await application.firstWindow();
  await application.evaluate(({ dialog, protocol }, source) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
    dialog.showMessageBox = async () => ({ response: 1 });
    protocol.handle('https', () => Response.json({ services: {}, kits: [], count: 0 }));
  }, source);
  await page.locator('#client-main').waitFor({ state: 'visible' });
  await page.evaluate(() => window.beings.plugins.importLocal());
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '更多功能', exact: true }).click();
  await page.getByRole('dialog', { name: '更多功能' }).getByRole('button', { name: '工具库', exact: true }).click();
  await page.getByRole('tab', { name: 'Plugin', exact: true }).click();
  await page.locator('.plugin-card').waitFor();
  await page.getByLabel('Kit Fixture显示位置', { exact: true }).selectOption('window');
  const opened = application.waitForEvent('window');
  await page.locator('.plugin-card').getByRole('button', { name: 'Kit Fixture', exact: true }).click();
  let floating = await opened;
  await floating.frameLocator('.plugin-frame').locator('#kit-fixture').waitFor();
  assert.equal(await floating.evaluate(() => typeof window.beings), 'undefined');
  const frame = await floating.locator('.plugin-frame').elementHandle().then(el => el.contentFrame());
  assert.equal(await frame.evaluate(() => typeof window.require), 'undefined');
  await frame.evaluate(() => window.grove.saveData({ retained: 'native-window' }));
  const floatingClosed = floating.waitForEvent('close');
  await page.evaluate(() => window.beings.plugins.setEnabled('fixture.kit-board', false));
  await floatingClosed;
  await assert.rejects(() => page.evaluate(() => window.beings.plugins.openWindow('fixture.kit-board', 'main')), /未启用/);
  await writeFile(path.join(source, 'desktop.plugin.json'), JSON.stringify({ ...manifest, version: '2.0.0' }));
  await writeFile(path.join(source, 'index.html'), '<h1 id="kit-fixture">Fixture v2</h1>');
  await page.locator('.plugin-card').getByRole('button', { name: '更新', exact: true }).click();
  await page.locator('.plugin-card').getByText(/v2.0.0/).waitFor();
  let plugin = (await page.evaluate(() => window.beings.plugins.list())).plugins[0];
  assert.equal(plugin.enabled, false); assert.equal(plugin.placements.main, 'window');
  await page.locator('.plugin-card').getByRole('button', { name: '恢复上一版本', exact: true }).click();
  await page.locator('.plugin-card').getByText(/v1.0.0/).waitFor();
  await page.evaluate(() => window.beings.plugins.setEnabled('fixture.kit-board', true));
  const reopened = application.waitForEvent('window');
  await page.evaluate(() => window.beings.plugins.openWindow('fixture.kit-board', 'main'));
  floating = await reopened;
  await floating.frameLocator('.plugin-frame').locator('#kit-fixture').waitFor();
  const restoredFrame = await floating.locator('.plugin-frame').elementHandle().then(el => el.contentFrame());
  assert.deepEqual(await restoredFrame.evaluate(() => window.grove.loadData()), { retained: 'native-window' });
  const endpoint = 'https://heart.fixture.invalid/being';
  await application.evaluate(async (_, endpoint) => { globalThis.kitFixtureStore.connection = { endpoint }; }, endpoint);
  const command = JSON.parse(await readFile(path.join(profile, '.portal-client.json'), 'utf8'));
  const call = async (args, overrides = {}) => {
    const response = await fetch(`http://127.0.0.1:${command.port}/command`, { method: 'POST', headers: { authorization: `Bearer ${command.token}` }, body: JSON.stringify({ endpoint, verb: 'plugins', args: JSON.stringify(args), ...overrides }) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await call({ plugin: manifest.id, op: 'describe' })).body.error, undefined);
  assert.equal((await call({ plugin: manifest.id, op: 'create', requestId: 'fixture-create', data: { title: 'Local command data' } })).body.error, undefined);
  assert.equal((await call({ plugin: manifest.id, op: 'list' }, { endpoint: 'https://heart.fixture.invalid/other' })).status, 409);
  plugin = (await page.evaluate(() => window.beings.plugins.list())).plugins[0];
  await application.evaluate(async (_, plugin) => { await globalThis.kitFixtureRegistry.referenceInstallation(plugin.manifest.id, 'fixture-installation', 'fixture-component', plugin); }, plugin);
  assert.match((await call({ plugin: manifest.id, op: 'list' })).body.error, /managed_plugin_requires_admission/);
  await mkdir(path.join(root, 'output/playwright/kit-desktop'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'output/playwright/kit-desktop/library.png') });
  console.log('PASS: real Electron import/window/sandbox/disable/update/restore/private data; authenticated local @plugins bridge/Being rejection/managed legacy rejection. No real Heart or OS installation claimed.');
} finally {
  if (application) await application.close();
  if (server) await server.close();
  await rm(temporary, { recursive: true, force: true });
}
