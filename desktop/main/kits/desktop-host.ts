import path from 'node:path';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { readPlugin, type PluginRegistry, type ManagedPluginOrigin } from '../plugins/registry';
import type { LocalApps } from '../app/local-apps';
import type { ManagedDesktopPlugins } from './managed-plugins';
import type { NativeRegistration } from './native-controller';
import type { DesktopControlPeer } from './control-server';
import { boundPath, protocolDigest, reference, validateDesktopRequest, type DesktopHostRequest, type DesktopHostReceipt, type DesktopTargetPolicy } from './desktop-host-contract';
import { durablePrivateJson, privateStateParent } from './durable-file';
import { parseUniqueJson } from './json';
import { PLUGIN_SDK_VERSION } from '../../shared/plugin-sdk';
import { managedDesktopSupported, requireManagedDesktop } from './managed-platform';

interface RecordState {
  appPath?: string;
  request: DesktopHostRequest; receipt: DesktopHostReceipt; pluginDigest?: string; externalReference?: boolean;
  observationRevision?: number; registered?: boolean; failure?: string;
  revocationPending?: boolean; requiresDataReview?: boolean;
  registrationDigest?: string;
  managementEpoch?: number;
}
interface State { format_version: 1; sequence: number; process_generation: number; records: RecordState[]; physical?: Record<string, { digest: string; revision: number }> }
export interface DesktopHostOptions {
  policies: DesktopTargetPolicy[]; registry: PluginRegistry; apps: LocalApps;
  adapter(targetId: string): ManagedDesktopPlugins | undefined;
  ledger(targetId: string, method: string, params: unknown): Promise<unknown>;
  openPlugin(id: string, view: string): Promise<void>; closePlugin(id: string): void;
  currentEndpoint(): string; readyTimeoutMs?: number;
}
/** Authenticated native installer boundary. A persisted Ready receipt is never
 * reused after main-process replacement; actual SDK observation is required. */
export class DesktopKitHost {
  private state: State = { format_version: 1, sequence: 0, process_generation: 0, records: [] };
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private file: string, private options: DesktopHostOptions) {}
  async load() {
    try {
      await privateStateParent(this.file);
      const info = await lstat(this.file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024 || (process.platform !== 'win32' && ((info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.()))) throw new Error('desktop_host_state_invalid');
      const state = parseUniqueJson(await readFile(this.file, 'utf8'), 16 * 1024 * 1024) as State;
      if (state.format_version !== 1 || !Number.isSafeInteger(state.sequence) || !Number.isSafeInteger(state.process_generation) || !Array.isArray(state.records) || state.records.length > 1000) throw new Error('desktop_host_state_invalid');
      this.state = state;
      for (const record of state.records) if (record.receipt.state === 'ready') { record.receipt.state = 'prepared'; record.receipt.process_generation = null; record.registered = false; }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.state.process_generation++; await this.save();
  }
  private save() { return durablePrivateJson(this.file, this.state); }
  private serial<T>(fn: () => Promise<T>) { const promise = this.queue.then(fn); this.queue = promise.catch(() => {}); return promise; }
  private policy(peer: DesktopControlPeer) {
    const policy = this.options.policies.find(p => protocolDigest(p.context) === protocolDigest(peer.context));
    if (!policy) throw new Error('desktop_host_scope_rejected'); return policy;
  }
  private origin(request: DesktopHostRequest): ManagedPluginOrigin {
    const p = request.provenance; return { rootDigest: p.root_digest, kitId: p.kit_id, releaseId: p.release_id, artifactDigest: p.artifact_digest };
  }
  private key(record: RecordState, target: string, installation: string, component: string) {
    return record.receipt.target_id === target && record.receipt.installation_id === installation && record.receipt.component_instance_id === component;
  }
  private current(policy: DesktopTargetPolicy, raw: any) {
    if (!raw || Object.keys(raw).some(k => !['installation_id', 'component_instance_id', 'expected_sequence', 'registration', 'restore_data', 'request', 'explicit_enable'].includes(k))) throw new Error('desktop_host_request_invalid');
    const record = this.state.records.find(r => this.key(r, policy.context.target_id, raw.installation_id, raw.component_instance_id));
    if (!record || record.receipt.sequence !== raw.expected_sequence) throw new Error('desktop_host_sequence_changed'); return record;
  }
  private async bundle(request: DesktopHostRequest, policy: DesktopTargetPolicy) {
    if (request.plan.payload.executor !== 'desktop_plugin_host') throw new Error('desktop_host_executor_mismatch');
    const manifest = await boundPath(request.plan.payload.manifest, policy);
    const source = parseUniqueJson(await readFile(manifest, 'utf8')) as any;
    const bundle = await readPlugin(path.dirname(manifest));
    if (bundle.manifest.id !== request.plan.payload.plugin_id || bundle.manifest.capabilities.some(c => !policy.allowedPluginCapabilities.includes(c))) throw new Error('desktop_plugin_identity_or_capability_conflict');
    const covered = new Set(await Promise.all(Object.values(request.plan.files).map(f => boundPath(f.path, policy))));
    for (const file of [source.entry, source.icon, ...(source.contributes?.views || []).map((v: any) => v.icon)].filter(v => typeof v === 'string' && !v.startsWith('data:'))) {
      if (!covered.has(path.resolve(path.dirname(manifest), file))) throw new Error('desktop_plugin_original_file_not_verified');
    }
    await validateDesktopRequest(request, policy); // reject changes between archive read and Registry snapshot
    return bundle;
  }
  private async preview(raw: unknown, policy: DesktopTargetPolicy) {
    const request = structuredClone(await validateDesktopRequest(raw, policy)), plan = request.plan;
    let detail: unknown;
    if (plan.payload.executor === 'desktop_plugin_host') {
      const bundle = await this.bundle(request, policy);
      const reviewed = await this.options.registry.managedPreview(bundle, this.origin(request), plan.installation_id, request.expected_plugin_digest, request.external_reference, plan.component_instance_id);
      detail = { executor: policy.executor, plugin_id: bundle.manifest.id, plugin_digest: bundle.sha256, sdk: PLUGIN_SDK_VERSION, minimum_sdk: bundle.manifest.minSdkVersion,
        capabilities: bundle.manifest.capabilities, added_capabilities: reviewed.addedCapabilities, original_enabled: reviewed.installed?.enabled ?? false,
        external_reference: !!request.external_reference, requires_explicit_enable: !request.external_reference && reviewed.userDisabled, private_data: 'retained', permissions: plan.permissions };
    } else {
      const app = (await this.options.apps.list()).find(a => a.id === (plan.payload.executor === 'os_app' ? plan.payload.target.association_id : ''));
      if (!app?.exists) throw new Error('desktop_app_explicit_association_missing');
      detail = { executor: policy.executor, association_id: app.id, name: app.name, state: 'associated', version_verified: false, owns_os_installation: false, permissions: plan.permissions };
    }
    const preview = { plan_digest: request.expected_plan_digest, provenance: request.provenance, detail };
    const stableDetail = { ...(detail as Record<string, unknown>) }; delete stableDetail.original_enabled;
    return { request, preview, preview_digest: protocolDigest({ ...preview, detail: stableDetail }) };
  }
  private receipt(request: DesktopHostRequest, state: DesktopHostReceipt['state']): DesktopHostReceipt {
    const p = request.plan; return { sequence: ++this.state.sequence, process_generation: state === 'ready' ? this.state.process_generation : null,
      operation_id: p.operation_id, owner_user_id: p.owner_user_id, installation_id: p.installation_id, component_instance_id: p.component_instance_id,
      target_id: p.target_id, generation: p.generation, revision: p.revision, plan_digest: request.expected_plan_digest, state, resource_refs: [] };
  }
  private async prepare(raw: unknown, policy: DesktopTargetPolicy) {
    const request = structuredClone(await validateDesktopRequest(raw, policy)), plan = request.plan;
    const old = this.state.records.find(r => this.key(r, plan.target_id, plan.installation_id, plan.component_instance_id));
    const replay = old?.request.expected_plan_digest === request.expected_plan_digest;
    if (replay && protocolDigest(old.request) !== protocolDigest(request)) throw new Error('desktop_host_request_identity_conflict');
    if (replay && old.failure !== 'staging') return this.describe(old, policy);
    if (!replay) {
      const checked = await this.preview(request, policy);
      if (request.expected_preview_digest !== checked.preview_digest) throw new Error('desktop_preview_confirmation_changed');
      if (old && (plan.revision <= old.receipt.revision || !['stopped', 'failed'].includes(old.receipt.state))) throw new Error('desktop_old_component_must_stop');
    }
    const record: RecordState = replay ? old : { request, receipt: this.receipt(request, 'prepared'), externalReference: !!request.external_reference };
    this.state.records = this.state.records.filter(r => !this.key(r, plan.target_id, plan.installation_id, plan.component_instance_id)).concat(record);
    // Journal before ownership or package changes. Interrupted staging never exposes aliases.
    record.failure = 'staging'; await this.save();
    if (plan.payload.executor === 'desktop_plugin_host') {
      const bundle = await this.bundle(request, policy);
      const result = await this.options.registry.stageManaged(bundle, this.origin(request), plan.installation_id, plan.component_instance_id, request.expected_plugin_digest, request.external_reference, replay);
      record.pluginDigest = result.sha256;
      record.observationRevision = (old?.observationRevision || 0) + 1;
    } else {
      const app = (await this.options.apps.list()).find(a => plan.payload.executor === 'os_app' && a.id === plan.payload.target.association_id && a.exists);
      if (!app) throw new Error('desktop_app_explicit_association_missing');
      const observedPath = await realpath(app.path);
      const reference = await this.options.apps.referenceInstallation(plan.payload.target.association_id, plan.installation_id, plan.component_instance_id);
      if (reference.state !== 'associated' || await realpath(app.path) !== observedPath) throw new Error('desktop_app_association_changed');
      record.appPath = observedPath;
      record.receipt.state = 'associated';
    }
    delete record.failure; await this.save(); return this.describe(record, policy);
  }
  private async describe(record: RecordState, policy: DesktopTargetPolicy) {
    const p = record.request.plan.payload;
    const observation = record.receipt.state !== 'stopped' && p.executor === 'desktop_plugin_host' && record.pluginDigest && this.options.adapter(policy.context.target_id)
      ? await this.options.adapter(policy.context.target_id)!.physicalObservation(p.plugin_id, record.observationRevision || 1) : null;
    if (observation) {
      if (observation.source_digest !== record.pluginDigest) throw new Error('desktop_physical_source_changed');
      this.state.physical ||= {};
      const physical = this.state.physical, key = observation.native_resource_ref;
      const digest = protocolDigest({ source_digest: observation.source_digest, operations: observation.operations });
      const previous = physical[key];
      observation.revision = previous?.digest === digest ? previous.revision : (previous?.revision || 0) + 1;
      if (!previous || previous.digest !== digest) { physical[key] = { digest, revision: observation.revision }; await this.save(); }
      record.receipt.resource_refs = [observation.native_resource_ref];
    }
    if (p.executor === 'os_app') record.receipt.resource_refs = [p.target.association_id];
    return structuredClone({ receipt: record.receipt, physical_observation: observation, plugin_digest: record.pluginDigest ?? null, registered: !!record.registered, failure: record.failure ?? null });
  }
  private async ready(record: RecordState, policy: DesktopTargetPolicy, explicitEnable = false) {
    if (record.receipt.state === 'ready' && record.request.plan.payload.executor === 'desktop_plugin_host' && record.pluginDigest &&
        await this.options.registry.readyGeneration(record.request.plan.payload.plugin_id, record.pluginDigest)) return this.describe(record, policy);
    if (record.failure || record.requiresDataReview || record.receipt.state !== 'prepared') throw new Error('desktop_host_not_prepared');
    if (record.request.provenance.expires_at_unix_seconds <= Date.now() / 1000 || record.request.plan.generation !== policy.generation || record.request.plan.policy_revision !== policy.policyRevision) throw new Error('desktop_host_authority_expired');
    const payload = record.request.plan.payload;
    if (payload.executor !== 'desktop_plugin_host' || !record.pluginDigest) throw new Error('desktop_host_executor_mismatch');
    const current = await this.options.registry.managedStatus(payload.plugin_id);
    if (!current.installed || current.installed.sha256 !== record.pluginDigest) throw new Error('desktop_plugin_source_changed');
    if (record.externalReference && !current.installed.enabled) throw new Error('desktop_external_plugin_requires_owner_enable');
    if (!record.externalReference) await this.options.registry.setEnabled(payload.plugin_id, true, { explicitEnable });
    try {
      const view = current.installed.manifest.contributes.views[0]?.id;
      if (!view) throw new Error('desktop_plugin_view_missing');
      await this.options.openPlugin(payload.plugin_id, view);
      const deadline = Date.now() + (this.options.readyTimeoutMs || 15000);
      while (!(await this.options.registry.readyGeneration(payload.plugin_id, record.pluginDigest))) {
        if (Date.now() >= deadline) throw new Error('desktop_plugin_sdk_ready_timeout');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      record.managementEpoch = (await this.options.registry.nativeObservation(payload.plugin_id)).managementEpoch;
      record.receipt = this.receipt(record.request, 'ready'); await this.save(); return this.describe(record, policy);
    } catch (error) {
      this.options.closePlugin(payload.plugin_id);
      if (!record.externalReference) await this.options.registry.setEnabled(payload.plugin_id, false, {});
      record.receipt = this.receipt(record.request, 'failed'); record.failure = error instanceof Error ? error.message : 'desktop_plugin_ready_failed'; await this.save(); throw error;
    }
  }
  private async register(record: RecordState, raw: any, policy: DesktopTargetPolicy) {
    if (record.receipt.state !== 'ready' || record.failure || record.request.plan.payload.executor !== 'desktop_plugin_host' || !record.pluginDigest) throw new Error('desktop_plugin_not_ready');
    const registration = raw.registration as NativeRegistration, p = record.request.plan;
    if (!registration || registration.installation_id !== p.installation_id || !Array.isArray(registration.records) || registration.records.some(r => r.binding.component_id !== p.component_instance_id ||
        r.binding.installation_revision !== p.revision || r.binding.target_generation !== p.generation || r.binding.policy_epoch !== p.policy_revision || r.binding.release_id !== p.release_id ||
        r.binding.closure_digest !== record.request.provenance.closure_digest || r.binding.expires_at_unix_seconds > record.request.provenance.expires_at_unix_seconds)) throw new Error('desktop_binding_plan_conflict');
    const adapter = this.options.adapter(policy.context.target_id); if (!adapter) throw new Error('desktop_ledger_unavailable');
    const registrationDigest = protocolDigest({ resources: registration.resources, records: registration.records });
    if (record.registered) { if (record.registrationDigest !== registrationDigest) throw new Error('desktop_binding_registration_conflict'); return this.describe(record, policy); }
    const snapshot = await this.options.ledger(policy.context.target_id, 'kit/native/status', {}) as any;
    if (snapshot.revision !== registration.expected_revision) throw new Error('desktop_native_revision_changed');
    const hasPhysical = registration.resources.every(r => snapshot.resources?.some((p: any) => p.native_resource_ref === r.native_resource_ref));
    await adapter.register(registration, [{ id: record.request.plan.payload.plugin_id, expectedDigest: record.pluginDigest }], hasPhysical ? {
      snapshot, publish: (method, params) => this.options.ledger(policy.context.target_id, method, params),
    } : undefined);
    record.registered = true; record.registrationDigest = registrationDigest; await this.save(); return this.describe(record, policy);
  }
  private async stop(record: RecordState, policy: DesktopTargetPolicy, uninstall: boolean) {
    const p = record.request.plan, payload = p.payload;
    // Local catalog closes durably before any remote revocation or package edit.
    record.revocationPending ||= !!record.registered;
    record.registered = false; record.failure = 'stopping'; record.receipt = this.receipt(record.request, 'failed'); await this.save();
    await this.revokeUsage(record, policy);
    if (payload.executor === 'desktop_plugin_host') {
      if (!this.state.records.some(other => other !== record && other.request.plan.payload.executor === 'desktop_plugin_host' && other.request.plan.payload.plugin_id === payload.plugin_id && this.usable(other, policy))) this.options.closePlugin(payload.plugin_id);
      if (!record.externalReference) await this.options.registry.setEnabled(payload.plugin_id, false, {});
      if (uninstall) await this.options.registry.removeManaged(payload.plugin_id, p.installation_id, p.component_instance_id, record.pluginDigest!);
    } else if (uninstall) await this.options.apps.unlinkInstallation(p.installation_id, p.component_instance_id);
    record.receipt = this.receipt(record.request, 'stopped'); delete record.failure; await this.save(); return this.describe(record, policy);
  }
  private async revokeUsage(record: RecordState, policy: DesktopTargetPolicy) {
    const p = record.request.plan;
    await this.options.adapter(policy.context.target_id)?.withdraw(p.installation_id, p.component_instance_id);
    if (!record.revocationPending || p.payload.executor !== 'desktop_plugin_host') return;
    const status = await this.options.ledger(policy.context.target_id, 'kit/native/status', {}) as any;
    const grants = (status.usage?.grants || []).filter((g: any) => g.binding.installation_id === p.installation_id && g.binding.component_id !== p.component_instance_id);
    const records = grants.map((grant: any) => ({ binding: grant.binding, tool: { name: `kit_${protocolDigest(grant.binding).slice(0, 56)}`, description: 'Managed Desktop plugin operation',
      inputSchema: status.usage.observations.find((o: any) => o.native_resource_ref === grant.native_resource_ref)?.operations[grant.binding.remote_tool]?.input_schema } }));
    await this.options.ledger(policy.context.target_id, 'kit/native/grants', { expected_revision: status.revision, installation_id: p.installation_id, grants, records });
    record.revocationPending = false; await this.save();
  }
  private async refresh(policy: DesktopTargetPolicy) {
    for (const record of this.state.records.filter(r => r.receipt.target_id === policy.context.target_id && r.receipt.state === 'associated' && r.request.plan.payload.executor === 'os_app')) {
      const payload = record.request.plan.payload; if (payload.executor !== 'os_app') continue;
      const app = (await this.options.apps.list()).find(a => a.id === payload.target.association_id && a.exists);
      if (app && record.appPath && await realpath(app.path).catch(() => '') === record.appPath) continue;
      record.failure = 'desktop_app_association_changed'; record.receipt = this.receipt(record.request, 'failed'); await this.save();
    }
    for (const record of this.state.records.filter(r => r.receipt.target_id === policy.context.target_id && r.receipt.state === 'ready' && r.request.plan.payload.executor === 'desktop_plugin_host')) {
      const payload = record.request.plan.payload;
      if (payload.executor !== 'desktop_plugin_host') continue;
      let valid = false;
      try { const observed = await this.options.registry.nativeObservation(payload.plugin_id); valid = observed.installed.enabled && observed.installed.sha256 === record.pluginDigest && observed.managementEpoch === (record.managementEpoch || 0); }
      catch { valid = false; }
      if (valid) continue;
      record.revocationPending ||= !!record.registered; record.registered = false; record.failure = 'desktop_plugin_lifecycle_changed'; record.receipt = this.receipt(record.request, 'failed');
      await this.save(); await this.revokeUsage(record, policy);
    }
  }
  private async restore(record: RecordState, raw: any, policy: DesktopTargetPolicy) {
    if (record.externalReference || record.request.plan.payload.executor !== 'desktop_plugin_host' || !record.pluginDigest) throw new Error('desktop_restore_requires_owned_plugin');
    const payload = record.request.plan.payload;
    const checked = await this.preview(raw.request, policy), request = checked.request, old = record.request;
    if (request.expected_preview_digest !== checked.preview_digest || request.plan.installation_id !== old.plan.installation_id || request.plan.component_instance_id !== old.plan.component_instance_id ||
        request.plan.revision <= old.plan.revision || request.plan.payload.executor !== 'desktop_plugin_host' || request.plan.payload.plugin_id !== payload.plugin_id ||
        request.provenance.root_digest !== old.provenance.root_digest || request.provenance.kit_id !== old.provenance.kit_id || request.external_reference) throw new Error('desktop_restore_transition_invalid');
    await this.stop(record, policy, false);
    const expected = await this.bundle(request, policy);
    const restored = await this.options.registry.restoreManaged(payload.plugin_id, old.plan.installation_id, record.pluginDigest, raw.restore_data === true);
    if (restored.sha256 !== expected.sha256) throw new Error('desktop_restore_original_digest_conflict');
    record.request = request; record.pluginDigest = restored.sha256; record.observationRevision = (record.observationRevision || 0) + 1;
    record.requiresDataReview = restored.requiresDataReview; record.receipt = this.receipt(request, 'prepared'); await this.save();
    return { ...await this.describe(record, policy), requires_data_review: !!record.requiresDataReview, private_data_restored: raw.restore_data === true };
  }
  private usable(record: RecordState, policy: DesktopTargetPolicy) {
    return record.receipt.state === 'ready' && record.receipt.process_generation === this.state.process_generation && record.registered &&
      record.receipt.generation === policy.generation && record.request.plan.policy_revision === policy.policyRevision && record.request.provenance.expires_at_unix_seconds > Date.now() / 1000;
  }
  async dispatch(peer: DesktopControlPeer, method: string, params: unknown): Promise<unknown> {
    const policy = this.policy(peer);
    if (policy.context.authority !== 'local') throw new Error('home_native_authenticated_channel_required');
    return this.serial(async () => {
      if (!managedDesktopSupported()) {
        if (peer.role === 'kit-consumer') {
          if (!policy.beingEndpoint || policy.beingEndpoint !== this.options.currentEndpoint()) throw new Error('desktop_consumer_endpoint_unavailable');
          if (method === 'desktop/plugins/catalog') return { tools: [] };
          requireManagedDesktop();
        }
        if (!['desktop/host/status', 'desktop/native/status', 'desktop/host/stop', 'desktop/host/uninstall'].includes(method)) requireManagedDesktop();
      }
      await this.refresh(policy);
      if (peer.role === 'kit-controller' && policy.beingEndpoint && policy.beingEndpoint !== this.options.currentEndpoint() && !['desktop/host/status', 'desktop/host/capabilities', 'desktop/host/stop', 'desktop/host/uninstall', 'desktop/native/status'].includes(method)) throw new Error('desktop_host_endpoint_changed');
      if (peer.role === 'kit-consumer') {
        const endpoint = policy.beingEndpoint;
        if (!endpoint || endpoint !== this.options.currentEndpoint()) throw new Error('desktop_consumer_endpoint_unavailable');
        const adapter = this.options.adapter(policy.context.target_id); if (!adapter) throw new Error('desktop_ledger_unavailable');
        const allowed = (installation: string, component: string) => this.state.records.some(r => this.key(r, policy.context.target_id, installation, component) && this.usable(r, policy));
        if (method === 'desktop/plugins/catalog') return adapter.catalog(allowed);
        if (method === 'desktop/plugins/call') {
          const raw = params as any;
          if (!raw || Object.keys(raw).some(k => !['call', 'trusted_call', 'scene_id'].includes(k)) || !raw.call || Object.keys(raw.call).some(k => !['name', 'arguments'].includes(k)) || !raw.trusted_call || Object.keys(raw.trusted_call).some(k => !['session_id', 'rpc_id'].includes(k))) throw new Error('desktop_consumer_call_invalid');
          const owner = adapter.entryOwner(raw.call.name); if (!owner?.installationId || !owner.componentId || !allowed(owner.installationId, owner.componentId)) throw new Error('desktop_binding_unavailable');
          return adapter.call(raw.call.name, raw.call.arguments, { endpoint, sessionId: raw.trusted_call.session_id, rpcId: raw.trusted_call.rpc_id, sceneId: raw.scene_id });
        }
        throw new Error('desktop_consumer_method_rejected');
      }
      if (method === 'desktop/host/preview') { const value = await this.preview(params, policy); return { ...value.preview, preview_digest: value.preview_digest }; }
      if (method === 'desktop/host/capabilities') return {
        target_id: policy.context.target_id, generation: policy.generation, online: true, runtime: 'local', executor: policy.executor,
        operating_system: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform === 'linux' ? 'linux' : 'unsupported',
        architecture: process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch === 'arm' ? 'armv7' : 'unsupported',
        preserve_tool_errors: true, features: policy.executor === 'desktop_plugin_host' ? ['runtime.plan.v1', 'desktop.plugin.v1', 'desktop.plugin.sdk.v1', 'native_entry.admission.v1'] : ['runtime.plan.v1', 'apps.association.v1'],
        trusts: ['user_computer'], account_channels: ['local_store'], transports: [], protocol_versions: [], result_types: ['text'], external: {},
        policy_revision: policy.policyRevision, sdk: PLUGIN_SDK_VERSION, allowed_plugin_capabilities: policy.allowedPluginCapabilities,
      };
      if (method === 'desktop/host/prepare') return this.prepare(params, policy);
      if (method === 'desktop/plugins/inspect' && policy.executor === 'desktop_plugin_host') {
        const raw = params as any;
        if (!raw || Object.keys(raw).some(k => k !== 'plugin_id') || !reference(raw.plugin_id)) throw new Error('desktop_plugin_selection_invalid');
        const observed = await this.options.registry.managedStatus(raw.plugin_id);
        return observed.installed ? { plugin_id: raw.plugin_id, digest: observed.installed.sha256, enabled: observed.installed.enabled, source: observed.installed.source.kind } : null;
      }
      if (method === 'desktop/native/status') { const value = await this.options.ledger(policy.context.target_id, 'kit/native/status', {}) as any; return { revision: value.revision }; }
      if (method === 'desktop/host/status') return this.state.records.filter(r => r.receipt.target_id === policy.context.target_id).map(r => ({ receipt: r.receipt, failure: r.failure ?? null, registered: !!r.registered, plugin_digest: r.pluginDigest ?? null }));
      if (method === 'desktop/apps/associations' && policy.executor === 'os_app') return { associations: (await this.options.apps.list()).map(a => ({ id: a.id, name: a.name, exists: a.exists })) };
      const record = this.current(policy, params);
      if (method === 'desktop/host/ready') return this.ready(record, policy, (params as any).explicit_enable === true);
      if (method === 'desktop/host/register') return this.register(record, params, policy);
      if (method === 'desktop/host/stop') return this.stop(record, policy, false);
      if (method === 'desktop/host/uninstall') return this.stop(record, policy, true);
      if (method === 'desktop/host/restore') return this.restore(record, params, policy);
      throw new Error('desktop_host_method_rejected');
    });
  }
}
