import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { managedDesktopSupported, requireManagedDesktop } from './managed-platform';
import { lstat, readFile } from 'node:fs/promises';
import { durablePrivateJson } from './durable-file';
import { protocolDigest } from './desktop-host-contract';
import type { HostEnrollment } from '../../shared/kit-host';
export type { HostEnrollment } from '../../shared/kit-host';

export type DesktopExecutor = 'desktop_plugin_host' | 'os_app';
export type HostExecutor = DesktopExecutor | 'portal_mcp';
export interface HostCapabilityDescription {
  runtime: 'local'; executor: HostExecutor;
  operating_system: 'macos' | 'windows' | 'linux'; architecture: 'x86_64' | 'aarch64' | 'armv7';
  preserve_tool_errors: boolean; features: string[]; trusts: ['user_computer'];
  account_channels: string[]; transports: string[]; protocol_versions: string[]; result_types: string[];
  external: Record<string, { kind: 'runtime'; status: 'ready'; version: string | null }>;
}
export interface HostRegistration {
  request_id: string; device_id: string; incarnation_id: string; expected_revision?: number;
  capabilities: HostCapabilityDescription;
  device_display_name?: string;
}
/** Constructed by the authenticated Home native-session owner. A Heart connection
 * and a renderer-supplied owner/token are never accepted as an enrollment session. */
export interface HomeNativeSession {
  ownerId: string; homeOrigin: string; clientId: string;
  homeRealm?: string;
  serverFeatures?: readonly string[];
  register(request: HostRegistration): Promise<HostEnrollment>;
}
interface PendingEnrollment { ownerId: string; homeOrigin: string; homeRealm?: string; clientId: string; executor: HostExecutor; request: HostRegistration }
interface State {
  formatVersion: 1; deviceId: string; pending?: PendingEnrollment[];
  enrollments: { ownerId: string; homeOrigin: string; homeRealm?: string; clientId: string; executor: HostExecutor; incarnationId?: string; receipt: HostEnrollment }[];
}
const uuid = (v: string) => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
declare const nativeDeviceScope: unique symbol;
export type HomeNativeDeviceScope = string & { readonly [nativeDeviceScope]: true };
/** Main-only owned enrollment identity, matching Home's stable physical fence.
 * This is an opaque ledger scope, never an operating-system path. */
export function homeNativeDeviceScope(ownerId: string, deviceId: string): HomeNativeDeviceScope {
  if (!uuid(ownerId) || !uuid(deviceId)) throw new Error('home_native_device_identity_invalid');
  return `device_${protocolDigest({ domain: 'home-kit-physical-device-v1', owner: ownerId.toLowerCase(), identity: `device:${deviceId.toLowerCase()}` })}` as HomeNativeDeviceScope;
}

const DEVICE_NAME_FEATURE = 'kit.host-device-display-name.v1';
function observedDeviceName(): string | undefined {
  const name = os.hostname().trim();
  return name && Buffer.byteLength(name, 'utf8') <= 128 && !/[\p{Cc}]/u.test(name) ? name : undefined;
}
function validReceipt(v: HostEnrollment) {
  return v && typeof v.target_id === 'string' && /^[a-zA-Z0-9_.-]{1,160}$/.test(v.target_id) &&
    Number.isSafeInteger(v.revision) && v.revision > 0 && Number.isSafeInteger(v.generation) && v.generation > 0 &&
    typeof v.lease_expires_at === 'string' && Number.isFinite(Date.parse(v.lease_expires_at));
}
/** OS and architecture are observed from the actual native process. This producer
 * intentionally advertises no MCP, isolation, durable calls or App readiness. */
export function desktopCapabilities(executor: DesktopExecutor): HostCapabilityDescription {
  const os = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform as 'darwin' | 'win32' | 'linux'];
  const arch = { x64: 'x86_64', arm64: 'aarch64', arm: 'armv7' }[process.arch as 'x64' | 'arm64' | 'arm'];
  if (!os || !arch) throw new Error('unsupported_native_platform');
  return { runtime: 'local', executor, operating_system: os as HostCapabilityDescription['operating_system'],
    architecture: arch as HostCapabilityDescription['architecture'], preserve_tool_errors: true,
    features: [], trusts: ['user_computer'], account_channels: [], transports: [], protocol_versions: [], result_types: [], external: {} };
}
export class DesktopHostFacts {
  private incarnationId = randomUUID();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private file: string) {}
  private async state(): Promise<State> {
    try {
      const info = await lstat(this.file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) throw new Error('invalid_host_identity');
      const state = JSON.parse(await readFile(this.file, 'utf8')) as State;
      if (state.formatVersion !== 1 || !uuid(state.deviceId) || !Array.isArray(state.enrollments) || state.enrollments.length > 100 ||
          state.enrollments.some(v => !v.ownerId || !v.clientId || !['desktop_plugin_host', 'os_app', 'portal_mcp'].includes(v.executor) || !validReceipt(v.receipt))) throw new Error('invalid_host_identity');
      if (state.pending && (!Array.isArray(state.pending) || state.pending.length > 100 || state.pending.some(v => !v.ownerId || !v.clientId || !uuid(v.request?.request_id) || v.request.device_id !== state.deviceId || !uuid(v.request.incarnation_id)))) throw new Error('invalid_host_identity');
      return state;
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { formatVersion: 1, deviceId: randomUUID(), enrollments: [] }; throw e; }
  }
  private save(state: State) { return durablePrivateJson(this.file, state); }
  private serialize<T>(operation: () => Promise<T>) {
    const result = this.queue.then(operation); this.queue = result.catch(() => {}); return result;
  }
  identity() {
    return this.serialize(async () => { const state = await this.state(); await this.save(state); return { deviceId: state.deviceId, capabilities: managedDesktopSupported() ? [desktopCapabilities('desktop_plugin_host'), desktopCapabilities('os_app')] : [] }; });
  }
  enroll(session: HomeNativeSession, executor: DesktopExecutor) {
    return this.enrollObserved(session, desktopCapabilities(executor));
  }
  /** Internal producer entry only. Callers obtain facts from the fixed native
   * executor/configuration, never through IPC or a package assertion. */
  enrollObserved(session: HomeNativeSession, capabilities: HostCapabilityDescription, incarnationId = this.incarnationId) {
    return this.serialize(async () => {
      const executor = capabilities.executor;
      if (executor === 'desktop_plugin_host' || executor === 'os_app') requireManagedDesktop();
      if (!['portal_mcp', 'desktop_plugin_host', 'os_app'].includes(executor) || capabilities.runtime !== 'local' || !uuid(incarnationId) || ['target_id', 'generation', 'online'].some(key => Object.hasOwn(capabilities, key))) throw new Error('invalid_native_host_observation');
      const origin = new URL(session.homeOrigin);
      if (origin.origin !== session.homeOrigin || origin.username || origin.password ||
          !(origin.protocol === 'https:' || (origin.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname))) || !session.ownerId || !session.clientId) throw new Error('invalid_home_native_session');
      const realm = session.homeRealm ? new URL(session.homeRealm) : undefined;
      if (realm && (realm.origin !== session.homeOrigin || realm.username || realm.password || realm.search || realm.hash || realm.href !== session.homeRealm)) throw new Error('invalid_home_native_realm');
      const sameRealm = (v: { homeRealm?: string; homeOrigin: string }) => (v.homeRealm || v.homeOrigin + '/') === (session.homeRealm || session.homeOrigin + '/');
      const state = await this.state();
      // Persist identity before network I/O so a lost response cannot invent a new device.
      await this.save(state);
      for (let recovery = 0; recovery < 3; recovery++) {
      const old = state.enrollments.find(v => v.ownerId === session.ownerId && v.homeOrigin === session.homeOrigin && sameRealm(v) && v.clientId === session.clientId && v.executor === executor);
      state.pending ||= [];
      let pending = state.pending.find(v => v.ownerId === session.ownerId && v.homeOrigin === session.homeOrigin && sameRealm(v) && v.clientId === session.clientId && v.executor === executor);
      if (pending?.request.device_display_name !== undefined && !session.serverFeatures?.includes(DEVICE_NAME_FEATURE)) throw new Error('host_registration_feature_lost');
      if (!pending) {
        const deviceName = session.serverFeatures?.includes(DEVICE_NAME_FEATURE) ? observedDeviceName() : undefined;
        pending = { ownerId: session.ownerId, homeOrigin: session.homeOrigin, ...(session.homeRealm ? { homeRealm: session.homeRealm } : {}), clientId: session.clientId, executor, request: {
          request_id: randomUUID(), device_id: state.deviceId, incarnation_id: incarnationId,
          ...(old ? { expected_revision: old.receipt.revision } : {}), ...(deviceName ? { device_display_name: deviceName } : {}), capabilities: structuredClone(capabilities) } };
        state.pending.push(pending); await this.save(state);
      }
      const receipt = await session.register(structuredClone(pending.request));
      if (!validReceipt(receipt) ||
          (old && (receipt.target_id !== old.receipt.target_id || receipt.revision < old.receipt.revision || receipt.generation < old.receipt.generation || (old.incarnationId && old.incarnationId !== pending.request.incarnation_id && receipt.generation <= old.receipt.generation)))) throw new Error('invalid_host_registration_receipt');
      state.enrollments = state.enrollments.filter(v => v !== old);
      state.enrollments.push({ ownerId: session.ownerId, homeOrigin: session.homeOrigin, ...(session.homeRealm ? { homeRealm: session.homeRealm } : {}), clientId: session.clientId, executor, incarnationId: pending.request.incarnation_id, receipt });
      state.pending = state.pending.filter(v => v !== pending);
      await this.save(state);
      // A replay from a dead producer settles the lost response, then enrolls
      // this process with a new incarnation before reporting usable host facts.
      if (Date.parse(receipt.lease_expires_at) <= Date.now()) throw new Error('invalid_host_registration_receipt');
      if (pending.request.incarnation_id !== incarnationId) continue;
      return receipt;
      }
      throw new Error('host_registration_recovery_limit');
    });
  }
}
