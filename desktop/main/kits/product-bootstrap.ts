import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Connection } from '../chat/connection';
import { durablePrivateJson, privateStateParent } from './durable-file';
import { digest, reference, protocolDigest } from './desktop-host-contract';
import { privateJson, runInstaller } from './market-native';
import { PLUGIN_CAPABILITIES } from '../../shared/plugins';
import { managedDesktopSupported } from './managed-platform';

interface OperatorSource { id: string; label: string; base_url: string; root: unknown; root_digest: string; root_updates?: unknown[]; allow_http_loopback?: boolean }
interface OperatorConfiguration { format_version: 1; markets: OperatorSource[]; development_runtime?: { installer: string; installer_sha256: string; portal: string; portal_sha256: string } }
interface LocalKeys { format_version: 1; owner: string; targetA: string; targetB: string; targetC: string; port: number; a: string; i: string; j: string; p: string; l: string; heartId?: string; beingEndpoint?: string; kitsDir?: string }
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const exists = async (file: string) => lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
async function unusedPort() { const server = createServer(); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port; }
/** Independent operator Root bootstrap. The public market and release URL can
 * never create or change this file. After this one local setup, users select
 * releases normally; controllers and publisher registration are not user steps. */
export async function bootstrapKitProduct(directory: string, resources: string, packaged: boolean, connection: Connection | null, observedKitsDirectory?: string) {
  const operatorFile = path.join(directory, 'kit-product.json');
  if (!await exists(operatorFile)) return null;
  const operator = await privateJson(operatorFile, 256 * 1024) as OperatorConfiguration;
  if (operator?.format_version !== 1 || !Array.isArray(operator.markets) || !operator.markets.length || operator.markets.length > 16 || new Set(operator.markets.map(m => m.id)).size !== operator.markets.length || operator.markets.some(m => !reference(m.id) || typeof m.label !== 'string' || m.label.length > 100 || !digest(m.root_digest) || !m.root || typeof m.base_url !== 'string')) throw new Error('kit_operator_sources_invalid');
  let installer: string, installerSha: string, portal: string, portalSha: string;
  if (!packaged && operator.development_runtime) {
    const r = operator.development_runtime; installer = r.installer; installerSha = r.installer_sha256; portal = r.portal; portalSha = r.portal_sha256;
  } else {
    const bundle = JSON.parse(await readFile(path.join(resources, 'runtime-bundle.json'), 'utf8'));
    if (bundle.schema !== 2 || bundle.platform !== process.platform || bundle.arch !== process.arch) throw new Error('kit_packaged_runtime_invalid');
    installer = path.join(resources, process.platform === 'win32' ? 'kit-installer.exe' : 'kit-installer'); portal = path.join(resources, process.platform === 'win32' ? 'heart-portal.exe' : 'heart-portal'); installerSha = bundle.installerSha256; portalSha = bundle.sha256;
  }
  for (const [file, expected] of [[installer, installerSha], [portal, portalSha]]) {
    if (!path.isAbsolute(file) || !digest(expected)) throw new Error('kit_runtime_pin_invalid');
    await privateStateParent(file);
    const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o022) || sha(await readFile(file)) !== expected) throw new Error('kit_runtime_pin_changed');
  }
  const cliCaps = await runInstaller(installer, ['--capabilities']), portalCaps = await runInstaller(portal, ['--kit-runtime-capabilities']);
  for (const caps of [cliCaps, portalCaps]) if (caps.format_version !== 1 || caps.control_protocol !== 'kit-control-hmac-v1' || !['runtime.plan.v1', 'native_entry.admission.v1', 'host.spawn-proof.v1'].every(f => caps.features?.includes(f))) throw new Error('unsupported_kit_runtime_feature');
  const desktopSupported = managedDesktopSupported();
  if (!cliCaps.features.includes('market.pinned-source.v1') || (desktopSupported && !cliCaps.features.includes('desktop.original-sdk.v1'))) throw new Error('unsupported_kit_installer_feature');
  const keyFile = path.join(directory, 'kit-local-authority.json');
  let keys: LocalKeys;
  if (await exists(keyFile)) keys = await privateJson(keyFile);
  else { const secret = () => randomBytes(48).toString('hex'); keys = { format_version: 1, owner: `local-user-${randomUUID()}`, targetA: `portal-${randomUUID()}`, targetB: `desktop-${randomUUID()}`, targetC: `app-${randomUUID()}`, port: await unusedPort(), a: secret(), i: secret(), j: secret(), p: secret(), l: secret() }; await durablePrivateJson(keyFile, keys); }
  if (keys.format_version !== 1 || ![keys.owner, keys.targetA, keys.targetB, keys.targetC].every(reference) || new Set([keys.a, keys.i, keys.j, keys.p, keys.l]).size !== 5 || [keys.a, keys.i, keys.j, keys.p, keys.l].some(v => typeof v !== 'string' || !/^[a-f0-9]{96}$/.test(v)) || !Number.isSafeInteger(keys.port) || keys.port < 1 || keys.port > 65535) throw new Error('kit_local_authority_invalid');
  if (connection) {
    if ((keys.beingEndpoint && keys.beingEndpoint !== connection.endpoint) || (keys.heartId && keys.heartId !== connection.being)) throw new Error('kit_local_heart_identity_changed');
    keys.beingEndpoint = connection.endpoint; keys.heartId = connection.being; await durablePrivateJson(keyFile, keys);
  }
  const productRoot = path.join(directory, 'kit-platform'), kitsDir = observedKitsDirectory || path.join(productRoot, 'kits');
  if (!path.isAbsolute(kitsDir) || path.parse(kitsDir).root === kitsDir || (keys.kitsDir && keys.kitsDir !== kitsDir)) throw new Error('kit_existing_library_root_changed');
  keys.kitsDir = kitsDir; await durablePrivateJson(keyFile, keys);
  // Preserve the actual existing legacy library. Only new owned projections
  // receive managed admission; unrelated unmanaged tools keep their old path.
  await mkdir(kitsDir, { recursive: true, mode: 0o700 });
  const markets = [], roots: Record<string, string> = { kits: kitsDir };
  for (const source of operator.markets) {
    const state = path.join(productRoot, 'markets', source.id), rootFile = path.join(state, 'config', 'pinned-root.json');
    await durablePrivateJson(rootFile, source.root);
    if (!await exists(path.join(state, 'trust.json'))) await runInstaller(installer, ['--state', state, 'init', '--root-metadata', rootFile, '--root-digest', source.root_digest, '--kits-dir', kitsDir]);
    await runInstaller(installer, ['--state', state, 'check-initial-root', rootFile, '--root-digest', source.root_digest]);
    if (source.root_updates !== undefined && (!Array.isArray(source.root_updates) || source.root_updates.length > 128)) throw new Error('kit_root_updates_invalid');
    for (const [index, update] of (source.root_updates || []).entries()) { const file = path.join(state, 'config', `root-update-${index}.json`); await durablePrivateJson(file, update); await runInstaller(installer, ['--state', state, 'rotate-root', file]); }
    await runInstaller(installer, ['--state', state, 'configure-authority', '--owner', keys.owner, '--target', keys.targetA]);
    const sourceFile = path.join(state, 'config', 'market-source.json');
    await durablePrivateJson(sourceFile, { format_version: 1, market_id: source.id, base_url: source.base_url, root_digest: source.root_digest, allow_http_loopback: source.allow_http_loopback === true });
    await runInstaller(installer, ['--state', state, 'configure-market', sourceFile]);
    roots[`market-${source.id}`] = state; markets.push({ id: source.id, label: source.label, state });
  }
  await durablePrivateJson(path.join(directory, 'kit-markets.json'), { format_version: 1, installer: { file: installer, sha256: installerSha }, markets });
  if (!connection) return { installer, portal, markets, bind: async () => {} };
  const context = (target: string) => ({ owner_id: keys.owner, heart_id: connection.being, target_id: target, authority: 'local' });
  const stateRoots = Object.fromEntries(Object.entries(roots).filter(([id]) => id !== 'kits'));
  const policy = { generation: 1, policyRevision: 1, roots: stateRoots, readRoots: Object.keys(stateRoots), writeRoots: [] as string[], networkHosts: [] as string[], allowedPluginCapabilities: Object.keys(PLUGIN_CAPABILITIES), beingEndpoint: connection.endpoint };
  // Refuse silent replacement of manually provisioned host ownership.
  const ownershipFile = path.join(directory, 'kit-product-owns-runtime.json');
  if (await exists(ownershipFile)) { const owned = await privateJson(ownershipFile); if (owned.owner !== keys.owner) throw new Error('kit_runtime_owner_changed'); }
  else { for (const name of ['kit-controller.json', 'desktop-controller.json', 'kit-portal-profile.json']) if (await exists(path.join(directory, name))) throw new Error('kit_existing_controller_requires_explicit_adoption'); await durablePrivateJson(ownershipFile, { format_version: 1, owner: keys.owner }); }
  const publishOwned = (file: string, value: unknown) => durablePrivateJson(file, value);
  const hadLedger = await exists(path.join(directory, 'kit-controller.json')), hadDesktop = await exists(path.join(directory, 'desktop-controller.json'));
  if (!desktopSupported && hadLedger !== hadDesktop) throw new Error('kit_existing_desktop_cleanup_configuration_incomplete');
  // Keep existing owned B/C credentials byte-for-byte for historical cleanup.
  // A new Linux setup creates no B/C controller or installer binding.
  const keepNativeTarget = desktopSupported || (hadLedger && hadDesktop);
  if (desktopSupported) {
    await publishOwned(path.join(directory, 'kit-controller.json'), { ...context(keys.targetB), port: keys.port, controller_token: keys.l });
    await publishOwned(path.join(directory, 'desktop-controller.json'), { format_version: 1, port: 0, targets: [{ ...policy, context: context(keys.targetB), executor: 'desktop_plugin_host', controllerToken: keys.i, consumerToken: keys.p }, { ...policy, context: context(keys.targetC), executor: 'os_app', controllerToken: keys.j }] });
  }
  const q = JSON.stringify;
  const fragment = `[kit_runtime]\nowner_id=${q(keys.owner)}\nheart_id=${q(connection.being)}\nrelay_origin=${q(new URL(connection.endpoint).origin)}\ntarget_id=${q(keys.targetA)}\nauthority="local"\nstate_dir=${q(path.join(productRoot, 'portal-ledger'))}\ncontroller_bind=${q(`127.0.0.1:${keys.port}`)}\ncontroller_token=${q(keys.a)}\n${keepNativeTarget ? `[[kit_runtime.native_targets]]\ntarget_id=${q(keys.targetB)}\nexecutor="desktop_plugin_host"\ncontroller_token=${q(keys.l)}\n[kit_runtime.native_targets.consumer]\ndescriptor=${q(path.join(directory, 'desktop-control-endpoint.json'))}\ntoken=${q(keys.p)}\n` : ''}[kit_runtime.host_policy]\ngeneration=1\npolicy_revision=1\n[kit_runtime.host_policy.roots]\n${Object.entries(roots).map(([id, root]) => `${q(id)}=${q(root)}`).join('\n')}\n[kit_runtime.host_policy.runtimes]\ninstaller=${q(installer)}\n[kit_runtime.host_policy.permission_ceiling]\nread_roots=${q(Object.keys(roots))}\nwrite_roots=[]\nnetwork_hosts=[]\n`;
  await publishOwned(path.join(directory, 'kit-portal-profile.json'), { format_version: 1, beingEndpoint: connection.endpoint, heartId: connection.being, kitsDir, fragment, secrets: keepNativeTarget ? [keys.a, keys.l, keys.p] : [keys.a] });
  await durablePrivateJson(path.join(directory, 'kit-product-owns-runtime.json'), { format_version: 1, owner: keys.owner });
  const provisionFiles: { state: string; a: string; desktop?: string }[] = [];
  for (const market of markets) {
    const stateRoot = `market-${market.id}`, a = path.join(market.state, 'config', 'portal-controller.json'), desktop = path.join(market.state, 'config', 'desktop-controllers.json');
    await durablePrivateJson(a, { owner_id: keys.owner, heart_id: connection.being, target_id: keys.targetA, port: keys.port, controller_token: keys.a, generation: 1, policy_revision: 1, state_root_id: stateRoot, kits_root_id: 'kits', installer_runtime_id: 'installer' });
    if (!desktopSupported) { provisionFiles.push({ state: market.state, a }); continue; }
    const previous = await exists(path.join(market.state, 'desktop-targets.json')) ? await privateJson(path.join(market.state, 'desktop-targets.json')) : [];
    await durablePrivateJson(desktop, [{ target_id: keys.targetB, executor: 'desktop_plugin_host', controller_token: keys.i }, { target_id: keys.targetC, executor: 'os_app', controller_token: keys.j }].map(t => { const old = previous.find((p: any) => p.target_id === t.target_id && p.owner_id === keys.owner && p.heart_id === connection.being); return { ...t, owner_id: keys.owner, heart_id: connection.being, port: 0, descriptor: path.join(directory, 'desktop-control-endpoint.json'), generation: 1, policy_revision: 1, state_root_id: stateRoot, external_plugins: old?.external_plugins || {}, app_associations: old?.app_associations || {} }; }));
    provisionFiles.push({ state: market.state, a, desktop });
  }
  return { installer, portal, markets, bind: async () => { for (const p of provisionFiles) {
    await runInstaller(installer, ['--state', p.state, 'bind-controller', p.a]);
    if (!p.desktop) continue;
    const bound = path.join(p.state, 'desktop-targets.json');
    if (await exists(bound)) {
      const current = await privateJson(bound), expected = await privateJson(p.desktop);
      const identity = (v: any) => { const { app_associations: _apps, external_plugins: _plugins, ...rest } = v; return rest; };
      if (protocolDigest(current.map(identity)) !== protocolDigest(expected.map(identity))) throw new Error('kit_desktop_authority_changed');
      // Keep actual explicit native choices made after the initial bootstrap.
      await runInstaller(installer, ['--state', p.state, 'bind-desktop-controller', bound]);
    } else await runInstaller(installer, ['--state', p.state, 'bind-desktop-controller', p.desktop]);
  } } };
}
