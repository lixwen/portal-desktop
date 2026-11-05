import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ControlContext } from './control-channel';
import type { PluginCapability } from '../../shared/plugins';
export interface BoundPath { root_id: string; relative_path: string }
export interface BoundFile { size_bytes: number; digest: string; path: BoundPath }
export interface DesktopHostPlan {
  format_version: 1; operation_id: string; owner_user_id: string; installation_id: string; component_instance_id: string;
  release_id: string; target_id: string; generation: number; revision: number; policy_revision: number;
  required_features: string[]; trust: 'user_computer'; permissions: { read_roots: string[]; write_roots: string[]; network_hosts: string[] };
  files: Record<string, BoundFile>;
  payload: { executor: 'desktop_plugin_host'; plugin_id: string; manifest: BoundPath } |
    { executor: 'os_app'; target: { mode: 'existing_association'; association_id: string } };
}
export interface DesktopProvenance { root_digest: string; kit_id: string; release_id: string; artifact_digest: string; closure_digest: string; expires_at_unix_seconds: number }
export interface DesktopHostRequest { plan: DesktopHostPlan; expected_plan_digest: string; provenance: DesktopProvenance; expected_plugin_digest?: string; external_reference?: boolean; expected_preview_digest?: string }
export interface DesktopTargetPolicy {
  context: ControlContext; executor: 'desktop_plugin_host' | 'os_app'; controllerToken: string; consumerToken?: string;
  generation: number; policyRevision: number; roots: Record<string, string>; allowedPluginCapabilities: PluginCapability[];
  readRoots: string[]; writeRoots: string[]; networkHosts: string[];
  beingEndpoint?: string;
}
export interface DesktopHostReceipt {
  sequence: number; process_generation: number | null; operation_id: string; owner_user_id: string; installation_id: string;
  component_instance_id: string; target_id: string; generation: number; revision: number; plan_digest: string;
  state: 'prepared' | 'ready' | 'associated' | 'stopped' | 'failed'; resource_refs: string[];
}
export function protocolDigest(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(([key, item]) => [key, canonical(item)])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function reference(value: unknown): value is string { return typeof value === 'string' && value !== '.' && value !== '..' && /^[a-zA-Z0-9_.-]{1,128}$/.test(value); }
export function digest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function keys(value: object, allowed: string[]) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new Error('desktop_host_contract_invalid'); }
export async function boundPath(value: BoundPath, policy: DesktopTargetPolicy): Promise<string> {
  keys(value, ['root_id', 'relative_path']);
  if (!reference(value.root_id) || typeof value.relative_path !== 'string' || value.relative_path.normalize('NFC') !== value.relative_path || value.relative_path.length > 32768 ||
      value.relative_path.includes('\\') || value.relative_path.includes(':') || value.relative_path.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /[\x00-\x1f]/.test(p))) throw new Error('desktop_host_path_invalid');
  const configured = policy.roots[value.root_id];
  if (!configured || !path.isAbsolute(configured)) throw new Error('desktop_host_root_not_delegated');
  const root = await realpath(configured);
  let current = root;
  for (const part of value.relative_path.split('/')) { current = path.join(current, part); if ((await lstat(current)).isSymbolicLink()) throw new Error('desktop_host_link_rejected'); }
  const resolved = await realpath(current);
  if (!resolved.startsWith(root + path.sep)) throw new Error('desktop_host_path_escape');
  return resolved;
}
export async function validateDesktopRequest(raw: unknown, policy: DesktopTargetPolicy): Promise<DesktopHostRequest> {
  const request = raw as DesktopHostRequest;
  keys(request, ['plan', 'expected_plan_digest', 'provenance', 'expected_plugin_digest', 'external_reference', 'expected_preview_digest']);
  const plan = request.plan;
  keys(plan, ['format_version', 'operation_id', 'owner_user_id', 'installation_id', 'component_instance_id', 'release_id', 'target_id', 'generation', 'revision', 'policy_revision', 'required_features', 'trust', 'permissions', 'files', 'payload']);
  if (Buffer.byteLength(JSON.stringify(plan)) > 256 * 1024 || plan.format_version !== 1 ||
      ![plan.operation_id, plan.owner_user_id, plan.installation_id, plan.component_instance_id, plan.release_id, plan.target_id].every(reference) ||
      plan.owner_user_id !== policy.context.owner_id || plan.target_id !== policy.context.target_id || plan.generation !== policy.generation || plan.policy_revision !== policy.policyRevision ||
      !Number.isSafeInteger(plan.revision) || plan.revision < 1 || plan.trust !== 'user_computer' || plan.payload?.executor !== policy.executor ||
      protocolDigest(plan) !== request.expected_plan_digest) throw new Error('desktop_host_plan_scope_or_digest_changed');
  const supported = ['runtime.plan.v1', 'native_entry.admission.v1', 'desktop.plugin.v1', 'desktop.plugin.sdk.v1', 'apps.association.v1'];
  if (!Array.isArray(plan.required_features) || plan.required_features.some(f => !supported.includes(f))) throw new Error('unsupported_desktop_host_feature');
  keys(plan.permissions, ['read_roots', 'write_roots', 'network_hosts']);
  for (const [kind, allowed] of [['read_roots', policy.readRoots], ['write_roots', policy.writeRoots], ['network_hosts', policy.networkHosts]] as const) {
    if (!Array.isArray(plan.permissions[kind]) || plan.permissions[kind].some(v => !allowed.includes(v))) throw new Error('desktop_host_permission_exceeds_ceiling');
  }
  const origin = request.provenance;
  keys(origin, ['root_digest', 'kit_id', 'release_id', 'artifact_digest', 'closure_digest', 'expires_at_unix_seconds']);
  if (!digest(origin.root_digest) || !digest(origin.artifact_digest) || !digest(origin.closure_digest) || origin.release_id !== plan.release_id ||
      typeof origin.kit_id !== 'string' || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(origin.kit_id) || !Number.isSafeInteger(origin.expires_at_unix_seconds) ||
      origin.expires_at_unix_seconds <= Math.floor(Date.now() / 1000)) throw new Error('desktop_host_provenance_invalid');
  keys(plan.files, Object.keys(plan.files));
  if (Object.keys(plan.files).length > 10000) throw new Error('desktop_host_file_limit');
  let total = 0;
  for (const [name, file] of Object.entries(plan.files)) {
    keys(file, ['size_bytes', 'digest', 'path']);
    if (!reference(name) || !digest(file.digest) || !Number.isSafeInteger(file.size_bytes) || file.size_bytes < 0 || file.size_bytes > 16 * 1024 * 1024) throw new Error('desktop_host_file_limit');
    total += file.size_bytes; if (total > 64 * 1024 * 1024) throw new Error('desktop_host_file_limit');
    const resolved = await boundPath(file.path, policy), info = await lstat(resolved);
    if (!info.isFile() || info.size !== file.size_bytes) throw new Error('desktop_host_file_changed');
    const bytes = await readFile(resolved);
    if (bytes.length !== file.size_bytes || createHash('sha256').update(bytes).digest('hex') !== file.digest) throw new Error('desktop_host_file_changed');
  }
  if (plan.payload.executor === 'desktop_plugin_host') {
    keys(plan.payload, ['executor', 'plugin_id', 'manifest']);
    if (!reference(plan.payload.plugin_id) || !Object.values(plan.files).some(f => plan.payload.executor === 'desktop_plugin_host' && f.path.root_id === plan.payload.manifest.root_id && f.path.relative_path === plan.payload.manifest.relative_path)) throw new Error('desktop_plugin_manifest_not_verified');
    const manifest = await boundPath(plan.payload.manifest, policy); if (path.basename(manifest) !== 'desktop.plugin.json') throw new Error('desktop_plugin_original_manifest_required');
  } else {
    keys(plan.payload, ['executor', 'target']); keys(plan.payload.target, ['mode', 'association_id']);
    if (plan.payload.target.mode !== 'existing_association' || !reference(plan.payload.target.association_id)) throw new Error('desktop_app_requires_explicit_association');
  }
  return request;
}
