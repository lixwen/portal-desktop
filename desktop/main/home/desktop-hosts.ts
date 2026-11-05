import { randomUUID } from 'node:crypto';
import { readFile, lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { HomeClient } from './client';
import type { HomeMe } from '../../shared/home';
import type { Settings } from '../../shared/types';
import type { PluginRegistry } from '../plugins/registry';
import type { LocalApps } from '../app/local-apps';
import type { Connection } from '../chat/connection';
import { permissionMode } from '../../shared/security';
import { PLUGIN_CAPABILITIES, type PluginCapability } from '../../shared/plugins';
import { DesktopHostFacts, desktopCapabilities, homeNativeDeviceScope, type HomeNativeSession } from '../kits/host-facts';
import { privateJson } from '../kits/market-native';
import { privateStateParent } from '../kits/durable-file';
import { protocolDigest } from '../kits/desktop-host-contract';
import { reserveHomePlugins } from './reservations';
import { HomeDesktopProducer } from './desktop-producer';
import { HomeExecutorChannel } from './host-channel';
import { managedDesktopSupported } from '../kits/managed-platform';
interface Options {
  directory: string; home: HomeClient; facts: DesktopHostFacts; registry: PluginRegistry; apps: LocalApps;
  connection(): Connection | null; settings(): Settings;
  openPlugin(id: string, view: string): Promise<void>; closePlugin(id: string): void;
  confirm(message: string, detail: string): Promise<boolean>; ensureLegacyGate(): Promise<void>;
}
/** Native B/C peers share the real Home device enrollment, never the Local A/B/C
 * controller credentials or local ledger. Nothing here is exported to preload. */
export class NativeHomeDesktopHosts {
  private peers: { channel: HomeExecutorChannel; producer: HomeDesktopProducer }[] = [];
  private epoch = 0; private timer?: ReturnType<typeof setInterval>; private busy = false; private fingerprint?: string;
  constructor(private options: Options) { options.home.onSessionInvalidated(() => { void this.stop().catch(() => {}); }); }
  supported() { return managedDesktopSupported(); }
  state() { return this.peers.map(p => p.channel.state()).filter(Boolean); }
  private current() { const h = this.options.home.state(), c = this.options.connection(), s = this.options.settings(); return protocolDigest({ home: h.baseUrl, client: h.clientId, endpoint: c?.endpoint, link: c?.link, mode: permissionMode(s.permissionMode), kits: s.kitsEnabled }); }
  async contextChanged() { if (this.fingerprint && this.fingerprint !== this.current()) await this.stop(); }
  async start() {
    // No new B/C target is enrolled on an unaccepted platform. Returning a
    // precise unsupported state must not stop the independently supported A.
    if (!this.supported()) return;
    if (this.peers.length && this.peers.every(p => p.channel.state())) return;
    await this.stop(); const epoch = ++this.epoch, fingerprint = this.current(), h = this.options.home.state(), connection = this.options.connection(), settings = this.options.settings();
    if (!h.signedIn || !connection || !settings.kitsEnabled || permissionMode(settings.permissionMode) !== 'full-access') throw new Error('home_native_current_policy_required');
    const me = await this.options.home.request<HomeMe>('/v1/me'); if (me.user.status !== 'active' || !me.being || me.being.owner_user_id !== me.user.id) throw new Error('home_native_active_profile_required');
    const config = await privateJson(path.join(this.options.directory, 'kit-home-host.json')) as { format_version: number; policy_revision: number; allowed_plugin_capabilities?: PluginCapability[]; ca_file?: string };
    const allowed = config.allowed_plugin_capabilities || ['storage', 'agent.read', 'agent.write'] as PluginCapability[];
    if (config.format_version !== 1 || !Number.isSafeInteger(config.policy_revision) || config.policy_revision < 1 || !Array.isArray(allowed) || allowed.some(c => !Object.hasOwn(PLUGIN_CAPABILITIES, c))) throw new Error('home_native_policy_invalid');
    let ca: Buffer | undefined;
    if (config.ca_file) { await privateStateParent(config.ca_file); const info = await lstat(config.ca_file); if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024 || (info.mode & 0o022)) throw new Error('home_native_ca_invalid'); ca = await readFile(config.ca_file); }
    // The Root-owned Portal must load deny-only reservations before any Home
    // plugin can be enabled. Invalid/missing declared metadata fails closed.
    await this.options.apps.initializeObservations();
    await this.reserve([]); await this.options.ensureLegacyGate();
    const identity = protocolDigest({ home: h.baseUrl, client: h.clientId, owner: me.user.id, profile: me.being.id, endpoint: connection.endpoint });
    const root = path.join(this.options.directory, 'kit-home', identity, 'desktop'), heartOrigin = new URL(connection.endpoint).origin;
    const heartId = `heart_${protocolDigest({ domain: 'home-kit-heart-v1', origin: heartOrigin, being_id: connection.being })}`, managementDomain = `home:${protocolDigest({ home: h.baseUrl, owner: me.user.id, profile: me.being.id, endpoint: connection.endpoint })}`;
    const check = () => { if (epoch !== this.epoch || fingerprint !== this.current()) throw new Error('home_native_context_changed'); };
    const session: HomeNativeSession = { ownerId: me.user.id, homeOrigin: new URL(h.baseUrl).origin, homeRealm: h.baseUrl, clientId: h.clientId, serverFeatures: await this.options.home.nativeFeatures(), register: async request => { check(); const current = await this.options.home.request<HomeMe>('/v1/me'); if (current.user.id !== me.user.id || current.being?.id !== me.being!.id) throw new Error('home_native_identity_changed'); return this.options.home.request('/v1/me/kit-hosts/registrations', 'POST', request); } };
    const device = await this.options.facts.identity(), nativeScope = homeNativeDeviceScope(me.user.id, device.deviceId); check();
    const renew: (() => Promise<void>)[] = [];
    try {
      for (const executor of ['desktop_plugin_host', 'os_app'] as const) {
        check(); const incarnation = randomUUID(), capabilities = { ...desktopCapabilities(executor),
          features: ['home.authority-channel.v1', 'runtime.plan.v1', 'native_entry.admission.v1', ...(executor === 'desktop_plugin_host' ? ['desktop.plugin.v1', 'desktop.plugin.sdk.v1'] : ['apps.association.v1'])] };
        const receipt = await this.options.facts.enrollObserved(session, capabilities, incarnation); check();
        const components = path.join(root, executor, 'components'); await mkdir(components, { recursive: true, mode: 0o700 });
        const producer = new HomeDesktopProducer({ root: components, file: path.join(root, executor, 'state.json'), realm: h.baseUrl, ownerId: me.user.id, profileId: me.being.id, executor, targetId: receipt.target_id, generation: receipt.generation, policyRevision: config.policy_revision, nativeScope, endpoint: connection.endpoint, managementDomain, registry: this.options.registry, apps: this.options.apps, allowedCapabilities: allowed, openPlugin: this.options.openPlugin, closePlugin: this.options.closePlugin, confirm: this.options.confirm, reservePlugins: ids => this.reserve(ids), currentEndpoint: () => this.options.connection()?.endpoint || '' });
        await producer.load(); check(); const channel = new HomeExecutorChannel({ home: this.options.home, baseUrl: h.baseUrl, clientId: h.clientId, ca,
          hello: { protocol: 'kit-home-host-v1', owner_id: me.user.id, profile_id: me.being.id, heart_id: heartId, heart_origin: heartOrigin, heart_slug: connection.being, target_id: receipt.target_id, generation: receipt.generation, incarnation_id: incarnation },
          connected: context => producer.activate(context), execute: (command, context) => producer.execute(command, context), disconnected: context => producer.disconnected(context) });
        this.peers.push({ channel, producer }); await channel.connect(); check();
        renew.push(async () => { const current = await this.options.facts.enrollObserved(session, capabilities, incarnation); if (current.target_id !== receipt.target_id || current.generation !== receipt.generation) throw new Error('home_native_enrollment_changed'); });
      }
      this.fingerprint = fingerprint; let renewal = Date.now();
      this.timer = setInterval(() => { if (this.busy) return; this.busy = true; void (async () => { check(); for (const peer of this.peers) if (!peer.channel.state() || !await peer.producer.observationsCurrent()) throw new Error('home_native_observation_lost'); if (Date.now() - renewal > 20000) { for (const refresh of renew) await refresh(); renewal = Date.now(); } })().catch(() => this.stop()).catch(() => {}).finally(() => { this.busy = false; }); }, 1000); this.timer.unref?.();
    } catch (error) { await this.stop(); throw error; }
  }
  private reserve(pluginIds: string[]) { return reserveHomePlugins(this.options.directory, pluginIds); }
  async stop() { this.epoch++; this.fingerprint = undefined; if (this.timer) clearInterval(this.timer); this.timer = undefined; const peers = this.peers.splice(0); await Promise.all(peers.map(peer => peer.channel.close())); }
}
