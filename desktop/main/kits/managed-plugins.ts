import { lstat, readFile } from 'node:fs/promises';
import { durablePrivateJson, privateStateParent } from './durable-file';
import type { PluginAgentContract } from '../../../plugins/sdk';
import type { PluginRegistry } from '../plugins/registry';
import type { NativeKitController, NativeRegistration, NativeTool, McpNativeResult } from './native-controller';
import { protocolDigest } from './desktop-host-contract';
import { managedDesktopSupported, requireManagedDesktop } from './managed-platform';

type Operation = 'describe' | 'list' | 'get' | 'create' | 'update' | 'configure';
interface Entry { alias: string; pluginId: string; operation: Operation; source: NativeTool; installationId?: string; componentId?: string; description?: string; expires?: number; managementEpoch?: number }
export interface DesktopManagedScope { owner_id: string; heart_id: string; target_id: string; authority: 'local' | 'home' }
const operations: Operation[] = ['describe', 'list', 'get', 'create', 'update', 'configure'];
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
export function operationSchema(contract: PluginAgentContract, op: Operation): Record<string, unknown> {
  const text = { type: 'string', minLength: 1, maxLength: 100 }, revision = { type: 'integer', minimum: 0 };
  const fields = Object.fromEntries(Object.entries(contract.fields).map(([key, field]) => [key,
    field.type === 'strings' ? { type: 'array', maxItems: field.maxItems || 12, items: { type: 'string', minLength: 1, maxLength: field.maxLength || 1000 } } :
      { type: field.type, ...(field.type === 'number' ? { minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER } : {}), ...(field.type === 'string' ? { maxLength: field.maxLength || 1000, ...(field.enum ? { enum: field.enum } : {}) } : {}) }]));
  if (op === 'describe') return object({});
  if (op === 'list') return object({ offset: { type: 'integer', minimum: 0 } });
  if (op === 'get') return object({ id: text }, ['id']);
  if (op === 'create') return object({ requestId: { ...text, pattern: '^[a-zA-Z0-9_.:-]+$' }, data: object(fields, contract.required) }, ['requestId', 'data']);
  if (op === 'update') return object({ requestId: { ...text, pattern: '^[a-zA-Z0-9_.:-]+$' }, id: text, expectedRevision: revision, patch: object(fields), note: { type: 'string', maxLength: 1000 } }, ['requestId', 'id', 'expectedRevision', 'patch', 'note']);
  return object({ requestId: { ...text, pattern: '^[a-zA-Z0-9_.:-]+$' }, expectedRevision: revision, preferences: object({ guidance: { type: 'string', maxLength: 2000 }, focusId: { type: ['string', 'null'], maxLength: 100 } }), note: { type: 'string', maxLength: 1000 } }, ['requestId', 'expectedRevision', 'preferences', 'note']);
}
/** Trusted main-process adapter. Registration is supplied by the local installer
 * or authenticated Home delegation, never by the model/Plugin SDK. The Rust
 * runtime validates bindings, schemas, current policy and durable admission. */
export class ManagedDesktopPlugins {
  private entries: Entry[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private registry: PluginRegistry, private controller: Pick<NativeKitController, 'register' | 'begin' | 'complete' | 'close'>,
    private scope: DesktopManagedScope, private file: string) {}
  private async observation(pluginId: string, includeDisabled = false): Promise<NativeTool[]> {
    const { installed, resourceRef } = await this.registry.nativeObservation(pluginId);
    const contract = installed.manifest.contributes.agent;
    if (!contract || (!includeDisabled && !installed.enabled)) return [];
    return operations.filter(op => installed.manifest.capabilities.includes(['describe', 'list', 'get'].includes(op) ? 'agent.read' : 'agent.write')).map(op => ({
      resource_ref: resourceRef, native_name: `${pluginId}.${op}`, remote_tool: `${pluginId}.${op}`,
      source_digest: installed.sha256, input_schema: operationSchema(contract, op),
    }));
  }
  async observed(pluginId: string) { return this.observation(pluginId); }
  async physicalObservation(pluginId: string, revision: number) {
    const { installed, resourceRef } = await this.registry.nativeObservation(pluginId);
    return { format_version: 1, target_id: this.scope.target_id, native_resource_ref: resourceRef, revision, source_digest: installed.sha256,
      operations: Object.fromEntries((await this.observation(pluginId, true)).map(tool => [tool.remote_tool, { native_name: tool.native_name,
        input_schema: tool.input_schema, schema_digest: protocolDigest(tool.input_schema), effect: ['describe', 'list', 'get'].includes(tool.native_name.slice(pluginId.length + 1)) ? { kind: 'read_only' } : { kind: 'write', operation_scope: `plugin-${pluginId}` } }])) };
  }
  async catalog(allowed: (installationId: string, componentId: string) => boolean) {
    if (!managedDesktopSupported()) return { tools: [] };
    await this.queue; const tools = [];
    for (const entry of this.entries) {
      if (!entry.installationId || !entry.componentId || !allowed(entry.installationId, entry.componentId) || !entry.expires || entry.expires <= Math.floor(Date.now() / 1000)) continue;
      const source = (await this.observation(entry.pluginId)).find(t => t.native_name === entry.source.native_name);
      if (source && protocolDigest(source) === protocolDigest(entry.source) && (await this.registry.nativeObservation(entry.pluginId)).managementEpoch === (entry.managementEpoch || 0)) tools.push({ name: entry.alias, description: entry.description || entry.operation, inputSchema: source.input_schema });
    }
    return { tools };
  }
  entryOwner(alias: string) { const entry = this.entries.find(v => v.alias === alias); return entry && { installationId: entry.installationId, componentId: entry.componentId }; }
  async withdraw(installationId: string, componentId: string) {
    await this.queue; const next = this.entries.filter(e => e.installationId !== installationId || e.componentId !== componentId);
    await durablePrivateJson(this.file, { formatVersion: 1, scope: this.scope, entries: next }); this.entries = next;
  }
  async load() {
    try {
      await privateStateParent(this.file);
      const info = await lstat(this.file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error('managed_desktop_state_invalid');
      const value = JSON.parse(await readFile(this.file, 'utf8'));
      if (value.formatVersion !== 1 || (!value.scope || Object.entries(this.scope).some(([key, expected]) => value.scope[key] !== expected)) || !Array.isArray(value.entries) || value.entries.length > 10000 ||
          value.entries.some((v: Entry) => typeof v.alias !== 'string' || typeof v.pluginId !== 'string' || !operations.includes(v.operation) || !v.source || v.source.native_name !== `${v.pluginId}.${v.operation}`)) throw new Error('managed_desktop_state_invalid');
      this.entries = value.entries;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  register(registration: NativeRegistration, plugins: { id: string; expectedDigest: string }[], usage?: { snapshot: any; publish(method: string, params: unknown): Promise<unknown> }) {
    const operation = this.queue.then(async () => {
      requireManagedDesktop();
      const observed = (await Promise.all(plugins.map(v => this.observation(v.id)))).flat();
      const entries: Entry[] = [];
      for (const resource of registration.resources) {
        if (resource.owner_id !== this.scope.owner_id || resource.heart_id !== this.scope.heart_id || resource.target_id !== this.scope.target_id || resource.authority !== this.scope.authority || resource.installation_id !== registration.installation_id) throw new Error('managed_desktop_scope_mismatch');
        const matching = observed.filter(v => v.resource_ref === resource.native_resource_ref);
        if (!matching.length) throw new Error('managed_desktop_source_missing');
        for (const [native, binding] of Object.entries(resource.entries)) {
          const source = matching.find(v => v.native_name === native);
          const record = registration.records.find(v => v.binding === binding || JSON.stringify(v.binding) === JSON.stringify(binding));
          const plugin = plugins.find(v => source?.native_name.startsWith(v.id + '.'));
          if (!source || !record || !plugin || source.source_digest !== plugin.expectedDigest || source.remote_tool !== binding.remote_tool) throw new Error('managed_desktop_source_changed');
          const operation = source.native_name.slice(plugin.id.length + 1) as Operation;
          entries.push({ alias: record.tool.name, pluginId: plugin.id, operation, source, installationId: binding.installation_id, componentId: binding.component_id, description: record.tool.description, expires: binding.expires_at_unix_seconds, managementEpoch: (await this.registry.nativeObservation(plugin.id)).managementEpoch });
        }
      }
      if (new Set(entries.map(v => v.alias)).size !== entries.length || !entries.length) throw new Error('managed_desktop_alias_conflict');
      // Revoke legacy path before the remote gate can expose any binding. A
      // failed registration remains unavailable and can be explicitly retried.
      for (const plugin of plugins) {
        const { installed, resourceRef } = await this.registry.nativeObservation(plugin.id);
        const resource = registration.resources.find(v => v.native_resource_ref === resourceRef);
        if (!resource || installed.sha256 !== plugin.expectedDigest) throw new Error('managed_desktop_source_changed');
        await this.registry.referenceInstallation(plugin.id, registration.installation_id, resource.component_id, installed);
      }
      if (usage) {
        const snapshot = usage.snapshot;
        const changedComponents = new Set(registration.resources.map(r => r.component_id));
        const grants = (snapshot.usage?.grants || []).filter((g: any) => g.binding.installation_id === registration.installation_id && !changedComponents.has(g.binding.component_id));
        const records = [];
        for (const grant of grants) {
          const operation = snapshot.usage.observations.find((o: any) => o.native_resource_ref === grant.native_resource_ref)?.operations[grant.binding.remote_tool];
          if (!operation) throw new Error('managed_physical_observation_missing');
          records.push({ binding: grant.binding, tool: { name: `kit_${protocolDigest(grant.binding).slice(0, 56)}`, description: 'Managed Desktop plugin operation', inputSchema: operation.input_schema } });
        }
        const observations = [];
        for (const resource of registration.resources) {
          const plugin = plugins.find(p => observed.some(o => o.resource_ref === resource.native_resource_ref && o.native_name.startsWith(p.id + '.')))!;
          const prior = snapshot.usage?.observations.find((o: any) => o.native_resource_ref === resource.native_resource_ref);
          const actual = await this.physicalObservation(plugin.id, (prior?.revision || 0) + 1);
          if (!prior || prior.source_digest !== actual.source_digest || protocolDigest(prior.operations) !== protocolDigest(actual.operations)) observations.push({ expected_revision: prior?.revision || 0, expected_source_digest: prior?.source_digest || null, observation: actual });
          for (const binding of Object.values(resource.entries)) grants.push({ authority: resource.authority, native_resource_ref: resource.native_resource_ref, source_digest: actual.source_digest, binding, enabled: resource.enabled });
        }
        records.push(...registration.records);
        await usage.publish('kit/native/grants', { expected_revision: registration.expected_revision, installation_id: registration.installation_id, grants, records, observations });
      } else await this.controller.register(registration, observed);
      const changedComponents = new Set(registration.resources.map(r => r.component_id));
      const next = this.entries.filter(v => v.installationId !== registration.installation_id || !v.componentId || !changedComponents.has(v.componentId)).concat(entries);
      await durablePrivateJson(this.file, { formatVersion: 1, scope: this.scope, entries: next });
      this.entries = next;
    });
    this.queue = operation.catch(() => {}); return operation;
  }
  async call(name: string, args: Record<string, unknown>, context: { endpoint: string; sessionId: string; rpcId: number | string; sceneId?: string }): Promise<McpNativeResult> {
    requireManagedDesktop();
    await this.queue;
    const entry = this.entries.find(v => v.alias === name);
    if (!context.sessionId || !(typeof context.rpcId === 'string' ? context.rpcId.length > 0 && context.rpcId.length <= 128 : Number.isSafeInteger(context.rpcId) && context.rpcId >= 0)) throw new Error('invalid_managed_plugin_session');
    if (!entry || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('managed_desktop_binding_unavailable');
    const source = (await this.observation(entry.pluginId)).find(v => v.native_name === entry.source.native_name);
    if (!source || JSON.stringify(source) !== JSON.stringify(entry.source)) throw new Error('managed_desktop_source_changed');
    if ((await this.registry.nativeObservation(entry.pluginId)).managementEpoch !== (entry.managementEpoch || 0)) throw new Error('managed_desktop_registration_revoked');
    const admission = await this.controller.begin(source, context.sessionId, context.rpcId, args, name);
    if (admission.state === 'existing') return admission.result;
    if (admission.state !== 'dispatch' || typeof admission.record_id !== 'string' || !admission.record_id) throw new Error('managed_desktop_invalid_admission');
    let result: McpNativeResult;
    try {
      const text = await this.registry.managedAgentCommand(context.endpoint, JSON.stringify({ ...args, plugin: entry.pluginId, op: entry.operation }), source.source_digest, context.sceneId);
      result = { content: [{ type: 'text', text }] };
    } catch (error) {
      // Preserve the original MCP tool error. Rust treats every unconfirmed
      // write error as unknown, so this cannot authorize a business retry.
      const text = error instanceof Error && !('code' in error) ? error.message : 'plugin_operation_failed';
      result = { content: [{ type: 'text', text }], isError: true };
    }
    try { await this.controller.complete(admission.record_id, result); }
    catch { this.controller.close(); throw new Error('managed_desktop_result_unknown'); }
    return result;
  }
  close() { this.controller.close(); }
}
