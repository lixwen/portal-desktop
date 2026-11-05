import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { PluginRegistry, ManagedPluginOrigin } from '../plugins/registry';
import { readPlugin } from '../plugins/registry';
import type { LocalApps } from '../app/local-apps';
import { durablePrivateJson, privateStateParent } from '../kits/durable-file';
import { privateJson } from '../kits/market-native';
import { operationSchema } from '../kits/managed-plugins';
import { protocolDigest, reference, digest, type DesktopHostPlan, type DesktopHostReceipt } from '../kits/desktop-host-contract';
import type { ExecutionBinding } from '../kits/native-controller';
import type { PluginCapability } from '../../shared/plugins';
import { PLUGIN_SDK_VERSION } from '../../shared/plugin-sdk';
import type { HomeChannelContext, HomeExecutorCommand } from './host-channel';
import type { HomeNativeDeviceScope } from '../kits/host-facts';
import { requireManagedDesktop } from '../kits/managed-platform';
type Provenance = { initial_root_digest: string; kit_id: string; artifact_digest: string; closure_digest: string; expires_at_unix_seconds: number };
type Projection = { executor: 'desktop_plugin_host'; plugin_id: string; version: string; description: string; selected_tools: Record<string, string>; provenance: Provenance } |
  { executor: 'os_app'; mode: 'existing_association'; expected_association_id: string | null; association_revision: number; provenance: Provenance };
export interface HomeDesktopPreparation { plan: DesktopHostPlan; projection: Projection }
interface ObservedTool { remote_tool: string; description: string; input_schema: Record<string, unknown>; effect: ExecutionBinding['effect'] }
export interface HomeDesktopReady {
  context: HomeChannelContext; receipt: DesktopHostReceipt; process_generation: null; native_resource_ref: string; source_digest: string; tools: ObservedTool[];
  observation: { executor: 'desktop_plugin_host'; sdk_instance_id: string; registry_revision: number } | { executor: 'os_app'; association_id: string; association_revision: number };
}
interface RecordState { preparation: HomeDesktopPreparation; digest: string; phase: 'staging' | 'prepared' | 'stopped'; host?: HomeDesktopReady; expectedDigest?: string; externalReference?: boolean; associationPath?: string; sourceDigest?: string }
interface State { format_version: 1; sequence: number; records: RecordState[]; calls: { id: string; digest: string; value?: unknown }[]; reservedPlugins: string[] }
interface Options {
  root: string; file: string; realm: string; ownerId: string; profileId: string; executor: 'desktop_plugin_host' | 'os_app'; targetId: string; generation: number; policyRevision: number; nativeScope: HomeNativeDeviceScope;
  endpoint: string; managementDomain: string; registry: PluginRegistry; apps: LocalApps; allowedCapabilities: PluginCapability[];
  openPlugin(id: string, view: string): Promise<void>; closePlugin(id: string): void;
  confirm(message: string, detail: string): Promise<boolean>;
  reservePlugins(ids: string[]): Promise<void>; currentEndpoint(): string; readyTimeoutMs?: number;
}
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const hasC0 = (value: string) => [...value].some(character => character.charCodeAt(0) < 32);
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const object = (v: any, names: string[]) => { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !names.includes(k))) throw new Error('home_native_contract_invalid'); };
/** Only an authenticated Home channel can reach this producer. It materializes
 * original SDK bundles and explicit App references, with no Local-ledger permit
 * API or model-selected source/configuration. */
export class HomeDesktopProducer {
  private state: State = { format_version: 1, sequence: 0, records: [], calls: [], reservedPlugins: [] };
  private queue: Promise<unknown> = Promise.resolve(); private active?: HomeChannelContext;
  constructor(private options: Options) {}
  async load() {
    if (this.options.executor === 'os_app') await this.options.apps.initializeObservations();
    await mkdir(this.options.root, { recursive: true, mode: 0o700 }); await privateStateParent(this.options.file);
    try { const state = await privateJson(this.options.file, 64 * 1024 * 1024) as State;
      if (state.format_version !== 1 || !Number.isSafeInteger(state.sequence) || state.sequence < 0 || !Array.isArray(state.records) || state.records.length > 1000 || !Array.isArray(state.calls) || state.calls.length > 10000 || !Array.isArray(state.reservedPlugins) || state.reservedPlugins.some(id => !reference(id))) throw new Error('home_native_state_invalid'); this.state = state;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; if (this.options.executor === 'desktop_plugin_host') for (const installed of (await this.options.registry.list()).plugins) if ((await this.options.registry.managedStatus(installed.manifest.id)).ownership?.managementDomain === this.options.managementDomain) throw new Error('home_native_history_missing'); }
    for (const record of this.state.records) { record.phase = record.phase === 'stopped' ? 'stopped' : 'staging'; record.host = undefined; }
    await this.options.reservePlugins(this.state.reservedPlugins); await this.save();
  }
  private save() { if (Buffer.byteLength(JSON.stringify(this.state)) > 64 * 1024 * 1024) throw new Error('home_native_state_limit'); return durablePrivateJson(this.options.file, this.state); }
  private serial<T>(task: () => Promise<T>) { const result = this.queue.then(task); this.queue = result.catch(() => {}); return result; }
  activate(context: HomeChannelContext) { this.checkContext(context); this.active = structuredClone(context); }
  private checkContext(context: HomeChannelContext) {
    if (context.owner_id !== this.options.ownerId || context.profile_id !== this.options.profileId || context.target_id !== this.options.targetId || context.generation !== this.options.generation || !positive(context.fence) || this.options.currentEndpoint() !== this.options.endpoint) throw new Error('home_native_context_changed');
  }
  private checkActive(context: HomeChannelContext) { this.checkContext(context); if (!this.active || protocolDigest(this.active) !== protocolDigest(context)) throw new Error('home_native_channel_fenced'); }
  async disconnected(context?: HomeChannelContext) {
    if (context && this.active && protocolDigest(context) !== protocolDigest(this.active)) return;
    this.active = undefined;
    // Revoke windows immediately; a new channel must obtain fresh actual SDK
    // observation. Never infer Stopped/compensated receipts from disconnection.
    for (const record of this.state.records) if (record.host?.observation.executor === 'desktop_plugin_host') this.options.closePlugin(record.preparation.plan.payload.executor === 'desktop_plugin_host' ? record.preparation.plan.payload.plugin_id : '');
  }
  private validate(raw: unknown, context: HomeChannelContext): HomeDesktopPreparation {
    const value = raw as HomeDesktopPreparation; object(value, ['plan', 'projection']); const { plan, projection } = value;
    object(plan, ['format_version', 'operation_id', 'owner_user_id', 'installation_id', 'component_instance_id', 'release_id', 'target_id', 'generation', 'revision', 'policy_revision', 'required_features', 'trust', 'permissions', 'files', 'payload']);
    // Home supplies its own authorization epoch. The operator ceiling revision
    // belongs to local configuration and cannot be compared to that epoch.
    if (Buffer.byteLength(JSON.stringify(value)) > 256 * 1024 || plan.format_version !== 1 || ![plan.operation_id, plan.owner_user_id, plan.installation_id, plan.component_instance_id, plan.release_id, plan.target_id].every(reference) || plan.owner_user_id !== context.owner_id || plan.target_id !== context.target_id || plan.generation !== context.generation || !positive(plan.revision) || !positive(plan.policy_revision) || plan.trust !== 'user_computer' || plan.payload?.executor !== this.options.executor || projection?.executor !== this.options.executor) throw new Error('home_native_plan_scope_invalid');
    const supported = ['home.authority-channel.v1', 'runtime.plan.v1', 'native_entry.admission.v1', 'desktop.plugin.v1', 'desktop.plugin.sdk.v1', 'apps.association.v1'];
    if (!Array.isArray(plan.required_features) || !plan.required_features.includes('home.authority-channel.v1') || plan.required_features.some(f => !supported.includes(f))) throw new Error('home_native_feature_unsupported');
    object(plan.permissions, ['read_roots', 'write_roots', 'network_hosts']);
    for (const key of ['read_roots', 'write_roots', 'network_hosts'] as const) if (!Array.isArray(plan.permissions[key]) || plan.permissions[key].some(v => key !== 'network_hosts' ? v !== 'home-components' : true)) throw new Error('home_native_permission_exceeds_ceiling');
    const p = projection.provenance; object(p, ['initial_root_digest', 'kit_id', 'artifact_digest', 'closure_digest', 'expires_at_unix_seconds']);
    if (![p.initial_root_digest, p.artifact_digest, p.closure_digest].every(digest) || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(p.kit_id) || !positive(p.expires_at_unix_seconds) || p.expires_at_unix_seconds <= Date.now() / 1000) throw new Error('home_native_provenance_expired');
    const prefix = `home-${sha(plan.operation_id)}/${sha(plan.component_instance_id)}/package/`, paths = new Set<string>(); let total = 0;
    object(plan.files, Object.keys(plan.files)); if (!Object.keys(plan.files).length || Object.keys(plan.files).length > 1024) throw new Error('home_native_file_limit');
    for (const [id, file] of Object.entries(plan.files)) {
      object(file, ['size_bytes', 'digest', 'path']); object(file.path, ['root_id', 'relative_path']); const relative = file.path.relative_path;
      if (!reference(id) || !digest(file.digest) || !Number.isSafeInteger(file.size_bytes) || file.size_bytes < 0 || file.size_bytes > 16 * 1024 * 1024 || file.path.root_id !== 'home-components' || typeof relative !== 'string' || relative.normalize('NFC') !== relative || !relative.startsWith(prefix) || relative.includes('\\') || relative.includes(':') || relative.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || hasC0(part)) || paths.has(relative)) throw new Error('home_native_path_invalid');
      paths.add(relative); total += file.size_bytes;
    }
    if (total > 64 * 1024 * 1024) throw new Error('home_native_file_limit');
    if (projection.executor === 'desktop_plugin_host' && plan.payload.executor === 'desktop_plugin_host') {
      object(projection, ['executor', 'plugin_id', 'version', 'description', 'selected_tools', 'provenance']); object(plan.payload, ['executor', 'plugin_id', 'manifest']);
      if (projection.plugin_id !== plan.payload.plugin_id || !reference(projection.plugin_id) || typeof projection.version !== 'string' || !projection.version || typeof projection.description !== 'string' || projection.description.length > 8192 || !Object.values(plan.files).some(file => protocolDigest(file.path) === protocolDigest(plan.payload.executor === 'desktop_plugin_host' ? plan.payload.manifest : {})) || path.posix.basename(plan.payload.manifest.relative_path) !== 'desktop.plugin.json') throw new Error('home_native_plugin_invalid');
      object(projection.selected_tools, Object.keys(projection.selected_tools)); const selected = Object.entries(projection.selected_tools);
      if (selected.length > 128 || selected.some(([id, remote]) => !reference(id) || !this.operation(projection.plugin_id, remote))) throw new Error('home_native_operation_invalid');
    } else if (projection.executor === 'os_app' && plan.payload.executor === 'os_app') {
      object(projection, ['executor', 'mode', 'expected_association_id', 'association_revision', 'provenance']); object(plan.payload, ['executor', 'target']); object(plan.payload.target, ['mode', 'association_id']);
      if (!positive(projection.association_revision) || projection.mode !== 'existing_association' || plan.payload.target.mode !== 'existing_association' || !reference(plan.payload.target.association_id) || (projection.expected_association_id !== null && projection.expected_association_id !== plan.payload.target.association_id)) throw new Error('home_native_app_choice_invalid');
    } else throw new Error('home_native_executor_invalid');
    return structuredClone(value);
  }
  private async confirm(message: string, detail: string) { let timer: ReturnType<typeof setTimeout>; try { return await Promise.race([this.options.confirm(message, detail), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 45000); })]); } finally { clearTimeout(timer!); } }
  private operation(pluginId: string, remote: unknown) { if (typeof remote !== 'string' || !remote.startsWith(pluginId + '.')) return undefined; const op = remote.slice(pluginId.length + 1); return ['describe', 'list', 'get', 'create', 'update', 'configure'].includes(op) ? op as 'describe' | 'list' | 'get' | 'create' | 'update' | 'configure' : undefined; }
  private origin(record: RecordState): ManagedPluginOrigin { const p = record.preparation.projection.provenance; return { rootDigest: p.initial_root_digest, kitId: p.kit_id, releaseId: record.preparation.plan.release_id, artifactDigest: p.artifact_digest, managementDomain: this.options.managementDomain }; }
  private async file(relative: string, create = false) {
    await privateStateParent(path.join(this.options.root, relative)); const root = await realpath(this.options.root); let current = root;
    for (const part of relative.split('/').slice(0, -1)) { current = path.join(current, part); if (create) await mkdir(current, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; }); const info = await lstat(current); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('home_native_link_rejected'); }
    const file = path.join(current, path.basename(relative)); const info = await lstat(file).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; }); if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('home_native_link_rejected'); return file;
  }
  private record(operation: string, component: string) { const record = this.state.records.find(r => r.preparation.plan.operation_id === operation && r.preparation.plan.component_instance_id === component); if (!record) throw new Error('home_native_plan_missing'); return record; }
  private receipt(record: RecordState, state: DesktopHostReceipt['state'], refs: string[]): DesktopHostReceipt { if (this.state.sequence >= Number.MAX_SAFE_INTEGER) throw new Error('home_native_sequence_exhausted'); const p = record.preparation.plan; return { sequence: ++this.state.sequence, process_generation: null, operation_id: p.operation_id, owner_user_id: p.owner_user_id, installation_id: p.installation_id, component_instance_id: p.component_instance_id, target_id: p.target_id, generation: p.generation, revision: p.revision, plan_digest: record.digest, state, resource_refs: refs }; }
  execute(command: HomeExecutorCommand, context: HomeChannelContext): Promise<unknown> {
    return this.serial(async () => {
      this.checkActive(context);
      if (['stage', 'file_chunk', 'prepare', 'dispatch', 'app_associations'].includes(command.command)) requireManagedDesktop();
      if (command.command === 'app_associations') {
        if (this.options.executor !== 'os_app' || (command.query !== null && (typeof command.query !== 'string' || Buffer.byteLength(command.query) > 256 || hasC0(command.query))) || !Number.isSafeInteger(command.offset) || command.offset < 0 || command.offset > 4096 || !positive(command.limit) || command.limit > 100) throw new Error('home_native_association_query_invalid');
        const query = command.query?.toLocaleLowerCase() || '', inventory = (await this.options.apps.associationInventory()).filter(item => !query || item.id.toLocaleLowerCase().includes(query) || item.display_name.toLocaleLowerCase().includes(query));
        const associations = inventory.slice(command.offset, command.offset + command.limit);
        if (associations.some(item => !reference(item.id) || !positive(item.revision) || !item.display_name.trim() || Buffer.byteLength(item.display_name) > 512 || hasC0(item.display_name))) throw new Error('home_native_association_metadata_invalid');
        const next = command.offset + associations.length; return { result: 'app_associations', page: { associations, next_offset: next < inventory.length && next <= 4096 ? next : null } };
      }
      if (command.command === 'stage') {
        const prep = this.validate(command.preparation, context), fingerprint = protocolDigest(prep.plan); const old = this.state.records.find(r => r.preparation.plan.operation_id === prep.plan.operation_id && r.preparation.plan.component_instance_id === prep.plan.component_instance_id);
        if (old) { if (old.digest !== fingerprint || protocolDigest(old.preparation) !== protocolDigest(prep)) throw new Error('home_native_plan_changed'); return { result: 'staged' }; }
        const previous = this.state.records.filter(r => r.preparation.plan.installation_id === prep.plan.installation_id && r.preparation.plan.component_instance_id === prep.plan.component_instance_id);
        if (previous.some(r => r.preparation.plan.revision >= prep.plan.revision || r.phase === 'prepared')) throw new Error('home_native_stop_previous_required');
        if (this.state.records.length >= 1000) throw new Error('home_native_state_limit'); this.state.records.push({ preparation: prep, digest: fingerprint, phase: 'staging' }); await this.save(); return { result: 'staged' };
      }
      if (command.command === 'file_chunk') {
        const record = this.record(command.operation_id, command.component_instance_id); if (record.phase !== 'staging') throw new Error('home_native_file_not_staging');
        const spec = record.preparation.plan.files[command.file_id], bytes = Buffer.from(command.bytes_base64, 'base64'); if (!spec || bytes.toString('base64') !== command.bytes_base64 || bytes.length > 65536 || !Number.isSafeInteger(command.offset) || command.offset < 0 || command.offset + bytes.length > spec.size_bytes) throw new Error('home_native_chunk_invalid');
        const file = await this.file(spec.path.relative_path, true); const handle = await open(file, command.offset === 0 ? 'wx' : 'r+', 0o600).catch(async (error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST' || command.offset !== 0) throw error; return open(file, 'r+'); });
        try { const info = await handle.stat(); if (info.size !== command.offset) { if (info.size >= command.offset + bytes.length) { const prior = Buffer.alloc(bytes.length); await handle.read(prior, 0, prior.length, command.offset); if (prior.equals(bytes)) return { result: 'file_accepted', next_offset: command.offset + bytes.length }; } throw new Error('home_native_chunk_offset_changed'); } await handle.write(bytes, 0, bytes.length, command.offset); await handle.sync(); }
        finally { await handle.close(); } return { result: 'file_accepted', next_offset: command.offset + bytes.length };
      }
      if (command.command === 'prepare') return this.prepare(this.record(command.operation_id, command.component_instance_id), context);
      if (command.command === 'dispatch') return this.dispatch(command.dispatch, context);
      if (command.command === 'stop') { const host = command.host as HomeDesktopReady; const record = this.record(host.receipt.operation_id, host.receipt.component_instance_id); if (!record.host || protocolDigest(record.host) !== protocolDigest(host)) throw new Error('home_native_host_changed'); return { result: 'stopped', receipt: await this.stop(record) }; }
      const preparation = command.preparation as HomeDesktopPreparation; object(preparation, ['plan', 'projection']);
      if (preparation.plan?.owner_user_id !== context.owner_id || preparation.plan?.target_id !== context.target_id) throw new Error('home_native_owned_plan_scope_changed');
      const record = this.state.records.find(r => r.digest === protocolDigest(preparation.plan));
      if (record && protocolDigest(record.preparation) !== protocolDigest(preparation)) throw new Error('home_native_owned_plan_changed');
      if (!record) { if (command.command === 'stop_owned') return { result: 'owned_stopped', receipt: null }; throw new Error('home_native_owned_plan_unproven'); }
      if (command.command === 'stop_owned') return { result: 'owned_stopped', receipt: await this.stop(record) };
      const live = record.host && await this.live(record); return { result: 'owned_observation', observation: { context, plan_digest: record.digest, state: live ? 'active' : record.phase === 'stopped' ? 'stopped' : 'unknown', receipt: live ? record.host!.receipt : null, native_resource_ref: live ? record.host!.native_resource_ref : null, source_digest: live ? record.host!.source_digest : null, process_generation: null } };
    });
  }
  private async prepare(record: RecordState, context: HomeChannelContext) {
    this.validate(record.preparation, context); if (record.phase === 'prepared' && record.host && protocolDigest(record.host.context) === protocolDigest(context) && await this.live(record)) return { result: 'prepared', host: record.host };
    for (const spec of Object.values(record.preparation.plan.files)) { const bytes = await readFile(await this.file(spec.path.relative_path)); if (bytes.length !== spec.size_bytes || sha(bytes) !== spec.digest) throw new Error('home_native_file_changed'); }
    const { plan, projection } = record.preparation; let host: HomeDesktopReady;
    if (plan.payload.executor === 'desktop_plugin_host' && projection.executor === 'desktop_plugin_host') {
      const manifestFile = await this.file(plan.payload.manifest.relative_path), bundle = await readPlugin(path.dirname(manifestFile));
      if (bundle.manifest.id !== projection.plugin_id || bundle.manifest.version !== projection.version || bundle.manifest.capabilities.some(c => !this.options.allowedCapabilities.includes(c))) throw new Error('home_native_sdk_identity_or_ceiling');
      const covered = new Set(await Promise.all(Object.values(plan.files).map(f => this.file(f.path.relative_path))));
      const raw = JSON.parse(await readFile(manifestFile, 'utf8')); for (const file of [raw.entry, raw.icon, ...(raw.contributes?.views || []).map((v: any) => v.icon)].filter(v => typeof v === 'string' && !v.startsWith('data:'))) if (!covered.has(path.resolve(path.dirname(manifestFile), file))) throw new Error('home_native_original_file_unverified');
      const current = await this.options.registry.managedStatus(bundle.manifest.id), external = current.ownership?.owner !== 'kit_installation' || current.ownership.ownerInstallationId !== plan.installation_id;
      const review = await this.options.registry.managedPreview(bundle, this.origin(record), plan.installation_id, current.installed?.sha256, !!current.installed && external, plan.component_instance_id);
      const reopening = this.state.records.some(prior => prior !== record && prior.phase === 'stopped' && prior.preparation.plan.installation_id === plan.installation_id && prior.preparation.plan.component_instance_id === plan.component_instance_id);
      if (!await this.confirm(reopening ? '重新打开 Home 插件？' : '启用 Home 原始 Desktop 插件？', `Home：${this.options.realm}\n账号：${this.options.ownerId}\n插件：${bundle.manifest.name} ${bundle.manifest.version}\nSDK：${PLUGIN_SDK_VERSION}；要求：${bundle.manifest.minSdkVersion}\n新增能力：${review.addedCapabilities.join('、') || '无'}\n全部能力：${bundle.manifest.capabilities.join('、')}\n权限：${JSON.stringify(plan.permissions)}\n打开插件会运行插件初始化。重新打开时，初始化会再次运行。若上次操作结果不确定，请先核实外部结果；本次确认不会清除先前不确定的业务结果。\n私有数据保留。此确认只适用于当前 Home 计划与原始内容。`)) throw new Error('home_native_confirmation_cancelled');
      this.checkActive(context); record.expectedDigest = current.installed?.sha256; record.externalReference = !!current.installed && external; await this.save();
      await this.options.registry.stageManaged(bundle, this.origin(record), plan.installation_id, plan.component_instance_id, record.expectedDigest, record.externalReference, true);
      if (!this.state.reservedPlugins.includes(bundle.manifest.id)) this.state.reservedPlugins.push(bundle.manifest.id); await this.save(); await this.options.reservePlugins(this.state.reservedPlugins);
      if (record.externalReference && !current.installed?.enabled) throw new Error('home_native_owner_disabled');
      if (!record.externalReference) await this.options.registry.setEnabled(bundle.manifest.id, true, { explicitEnable: true });
      try {
        await this.options.openPlugin(bundle.manifest.id, bundle.manifest.contributes.views[0].id); const deadline = Date.now() + (this.options.readyTimeoutMs || 15000);
        let observation = await this.options.registry.readyObservation(bundle.manifest.id, bundle.sha256);
        while (!observation) { this.checkActive(context); if (Date.now() > deadline) throw new Error('home_native_sdk_ready_timeout'); await new Promise(r => setTimeout(r, 25)); observation = await this.options.registry.readyObservation(bundle.manifest.id, bundle.sha256); }
        this.checkActive(context); const physical = await this.options.registry.nativeObservation(bundle.manifest.id), contract = bundle.manifest.contributes.agent; if (Object.keys(projection.selected_tools).length && !contract) throw new Error('home_native_sdk_contract_missing');
        const tools = [...new Set(Object.values(projection.selected_tools))].map(remote => { const op = this.operation(bundle.manifest.id, remote)!; const read = ['describe', 'list', 'get'].includes(op); if (!bundle.manifest.capabilities.includes(read ? 'agent.read' : 'agent.write')) throw new Error('home_native_sdk_capability_missing'); return { remote_tool: remote, description: projection.description, input_schema: operationSchema(contract!, op), effect: read ? { kind: 'read_only' as const } : { kind: 'write' as const, operation_scope: `plugin-${bundle.manifest.id}` } }; });
        host = { context, receipt: this.receipt(record, 'ready', [physical.resourceRef]), process_generation: null, observation: { executor: 'desktop_plugin_host', ...observation }, native_resource_ref: physical.resourceRef, source_digest: bundle.sha256, tools };
      } catch (error) { this.options.closePlugin(bundle.manifest.id); if (!record.externalReference) await this.options.registry.setEnabled(bundle.manifest.id, false, {}); throw error; }
    } else if (plan.payload.executor === 'os_app' && projection.executor === 'os_app') {
      const associated = await this.options.apps.observeAssociation(plan.payload.target.association_id);
      if (associated.association_revision !== projection.association_revision) throw new Error('home_native_association_revision_changed');
      if (!await this.confirm('确认 Home 使用现有 App 关联？', `Home：${this.options.realm}\n账号：${this.options.ownerId}\n关联：${associated.app.name} (${associated.association_id})\n用户已选择路径：${associated.app.path}\n只建立该稳定关联的引用，不证明版本、不安装或卸载系统程序。`)) throw new Error('home_native_confirmation_cancelled');
      this.checkActive(context); const latest = await this.options.apps.observeAssociation(associated.association_id); if (latest.canonicalPath !== associated.canonicalPath || latest.association_revision !== associated.association_revision) throw new Error('home_native_association_changed');
      await this.options.apps.referenceInstallation(associated.association_id, plan.installation_id, plan.component_instance_id); record.associationPath = associated.canonicalPath;
      const ref = `app-${sha(JSON.stringify({ id: associated.association_id, path: associated.canonicalPath }))}`;
      host = { context, receipt: this.receipt(record, 'associated', [ref]), process_generation: null, observation: { executor: 'os_app', association_id: associated.association_id, association_revision: associated.association_revision }, native_resource_ref: ref, source_digest: protocolDigest({ association_id: associated.association_id, path: associated.canonicalPath, revision: associated.association_revision }), tools: [] };
    } else throw new Error('home_native_executor_invalid');
    record.host = host; record.sourceDigest = host.source_digest; record.phase = 'prepared'; await this.save(); return { result: 'prepared', host };
  }
  private async live(record: RecordState) {
    const host = record.host; if (!host || record.phase !== 'prepared' || record.preparation.projection.provenance.expires_at_unix_seconds <= Date.now() / 1000) return false;
    const p = record.preparation.plan.payload;
    if (p.executor === 'desktop_plugin_host' && host.observation.executor === 'desktop_plugin_host') { const physical = await this.options.registry.nativeObservation(p.plugin_id); const observation = await this.options.registry.readyObservation(p.plugin_id, host.source_digest); return !!observation && physical.managementDomain === this.options.managementDomain && physical.installed.sha256 === host.source_digest && protocolDigest(observation) === protocolDigest({ sdk_instance_id: host.observation.sdk_instance_id, registry_revision: host.observation.registry_revision }); }
    if (p.executor === 'os_app' && host.observation.executor === 'os_app') { const observed = await this.options.apps.observeAssociation(p.target.association_id); return observed.canonicalPath === record.associationPath && observed.association_revision === host.observation.association_revision; }
    return false;
  }
  observationsCurrent() {
    // Do not mistake our own serialized stop/prepare transition for external
    // observation loss. Checks still see genuine window/association changes.
    return this.serial(async () => { if (!this.active) return false; for (const record of this.state.records) if (record.phase === 'prepared' && (!record.host || !await this.live(record).catch(() => false))) return false; return true; });
  }
  private async dispatch(raw: unknown, context: HomeChannelContext) {
    const value = raw as { call_id: string; host: HomeDesktopReady; binding: ExecutionBinding; arguments: Record<string, unknown>; expires_at_unix_seconds: number }; object(value, ['call_id', 'host', 'binding', 'arguments', 'expires_at_unix_seconds']);
    if (!reference(value.call_id) || !positive(value.expires_at_unix_seconds) || value.expires_at_unix_seconds <= Date.now() / 1000 || value.expires_at_unix_seconds > Math.floor(Date.now() / 1000) + 30) throw new Error('home_native_dispatch_expired');
    const h = value.host, record = this.record(h.receipt.operation_id, h.receipt.component_instance_id), b = value.binding, p = record.preparation.plan;
    if (!record.host || protocolDigest(h) !== protocolDigest(record.host) || protocolDigest(h.context) !== protocolDigest(context) || !await this.live(record) || b.owner_id !== context.owner_id || b.heart_id !== context.heart_id || b.target_id !== context.target_id || b.target_generation !== context.generation || b.runtime !== 'local' || b.installation_id !== p.installation_id || b.component_id !== p.component_instance_id || b.installation_revision !== p.revision || b.release_id !== p.release_id || b.closure_digest !== record.preparation.projection.provenance.closure_digest || b.policy_epoch !== p.policy_revision || b.expires_at_unix_seconds <= Date.now() / 1000 || b.expires_at_unix_seconds > record.preparation.projection.provenance.expires_at_unix_seconds || Object.keys(b.accounts).length || b.workspace_ref !== this.options.nativeScope || b.browser_session_ref !== null) throw new Error('home_native_dispatch_binding_changed');
    const tool = h.tools.find(t => t.remote_tool === b.remote_tool); if (!tool || protocolDigest(tool.input_schema) !== b.schema_digest || protocolDigest(tool.effect) !== protocolDigest(b.effect) || p.payload.executor !== 'desktop_plugin_host') throw new Error('home_native_dispatch_schema_changed');
    const fingerprint = protocolDigest(value), old = this.state.calls.find(c => c.id === value.call_id); if (old) { if (old.digest !== fingerprint || old.value === undefined) throw new Error('home_native_call_already_consumed'); return { result: 'tool_result', value: old.value }; }
    if (this.state.calls.length >= 10000) throw new Error('home_native_call_storage_limit'); const consumed = { id: value.call_id, digest: fingerprint } as State['calls'][number]; this.state.calls.push(consumed); await this.save();
    this.checkActive(context); if (!await this.live(record)) throw new Error('home_native_observation_changed');
    // Original SDK returns JSON text, not an MCP envelope. Adapt once at this
    // explicit boundary; dynamic SDK results are never used as control facts.
    const result = await this.options.registry.managedAgentCommand(this.options.endpoint, JSON.stringify({ ...value.arguments, plugin: p.payload.plugin_id, op: this.operation(p.payload.plugin_id, b.remote_tool) }), h.source_digest, undefined, this.options.managementDomain);
    const envelope = { content: [{ type: 'text', text: result }] }; consumed.value = envelope; await this.save(); return { result: 'tool_result', value: envelope };
  }
  private async stop(record: RecordState) {
    const p = record.preparation.plan, host = record.host;
    if (p.payload.executor === 'desktop_plugin_host') { const shared = this.state.records.some(r => r !== record && r.phase === 'prepared' && r.preparation.plan.payload.executor === 'desktop_plugin_host' && r.preparation.plan.payload.plugin_id === (p.payload.executor === 'desktop_plugin_host' ? p.payload.plugin_id : '')); if (!shared) { const observed = await this.options.registry.managedStatus(p.payload.plugin_id); if (!record.sourceDigest || observed.installed?.sha256 === record.sourceDigest) this.options.closePlugin(p.payload.plugin_id); if (observed.installed && observed.ownership?.managementDomain === this.options.managementDomain && (!record.sourceDigest || observed.installed.sha256 === record.sourceDigest) && observed.ownership.origin?.artifactDigest === record.preparation.projection.provenance.artifact_digest && !record.externalReference) await this.options.registry.setEnabled(p.payload.plugin_id, false, {}); } }
    else await this.options.apps.unlinkInstallation(p.installation_id, p.component_instance_id);
    const receipt = this.receipt(record, 'stopped', host ? [host.native_resource_ref] : []); record.phase = 'stopped'; record.host = undefined; await this.save(); return receipt;
  }
}
