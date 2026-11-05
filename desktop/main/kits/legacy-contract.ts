import { createHash } from 'node:crypto';
import { groveEntryKind, parsePluginManifest, pluginId } from '../../shared/plugins';
import type { InstalledPlugin } from '../../shared/plugins';
import type { LocalApp } from '../../shared/types';

/** In-process Host inputs only. Never populate identity from @plugins arguments. */
export interface LegacyDesktopScope { profileId: string; beingEndpoint?: string }
export type LegacyExecutor = 'portal_mcp' | 'desktop_plugin_host' | 'os_app';
export function legacyExecutor(entry: Record<string, unknown>): LegacyExecutor {
  if (entry.kind !== undefined && !['kit', 'app', 'plugin'].includes(String(entry.kind))) throw new Error('unsupported_legacy_kind');
  return { kit: 'portal_mcp', plugin: 'desktop_plugin_host', app: 'os_app' }[groveEntryKind(entry)] as LegacyExecutor;
}
function reference(value: string) { return /^[a-zA-Z0-9_.-]{1,160}$/.test(value) && value !== '.' && value !== '..'; }
function digest(value: string) { return /^[a-f0-9]{64}$/.test(value); }

export interface InPlacePlugin {
  executor: 'desktop_plugin_host';
  profileId: string;
  original: InstalledPlugin;
  privateData: string;
  collaborationData?: string;
  state: 'present' | 'disabled';
  owner: 'legacy_host';
}
/** Read-only mapping. Host validation/hash checks precede this call; this
 * function preserves the original record and never imports it as an MCP kit. */
export function captureInPlacePlugin(plugin: InstalledPlugin, scope: LegacyDesktopScope): InPlacePlugin {
  if (!reference(scope.profileId)) throw new Error('invalid_desktop_scope');
  parsePluginManifest(plugin.manifest);
  pluginId(plugin.manifest.id);
  if (!digest(plugin.sha256) || typeof plugin.enabled !== 'boolean' || !Number.isFinite(Date.parse(plugin.installedAt)) ||
      !['local', 'grove', 'kit'].includes(plugin.source?.kind) ||
      (plugin.source.kind !== 'local' && (!plugin.source.id || !reference(plugin.source.id)))) throw new Error('invalid_legacy_plugin_record');
  for (const [view, placement] of Object.entries(plugin.placements || {})) {
    if (!plugin.manifest.contributes.views.some(v => v.id === view) || !['page', 'navigation', 'window'].includes(placement)) throw new Error('invalid_legacy_placement');
  }
  const id = plugin.manifest.id;
  return { executor: 'desktop_plugin_host', profileId: scope.profileId, original: structuredClone(plugin),
    privateData: `data/${id}.json`,
    ...(scope.beingEndpoint ? { collaborationData: `agent-data/${id}/${createHash('sha256').update(scope.beingEndpoint).digest('hex')}.json` } : {}),
    state: plugin.enabled ? 'present' : 'disabled', owner: 'legacy_host' };
}

/** Supplied by the trusted source-verification/explicit local-adoption flow,
 * not a package's self-asserted publisher/name/official label. */
export interface LegacyPluginEvidence {
  pluginId: string;
  source: InstalledPlugin['source'];
  sha256: string;
  originalSourceConfirmed: boolean;
}
export function planExternalPluginReference(snapshot: InPlacePlugin, evidence: LegacyPluginEvidence) {
  const old = snapshot.original;
  if (!evidence.originalSourceConfirmed) throw new Error('legacy_source_confirmation_required');
  if (old.manifest.id !== evidence.pluginId || old.source.kind !== evidence.source.kind || old.source.id !== evidence.source.id ||
      old.sha256 !== evidence.sha256) throw new Error('legacy_source_conflict');
  return { pluginId: old.manifest.id, profileId: snapshot.profileId, executor: snapshot.executor,
    expectedDigest: old.sha256, state: snapshot.state, ownsInstallation: false as const,
    enableOnReference: false as const, unlink: 'keep_installation_and_data' as const };
}

export interface InPlaceApp {
  executor: 'os_app';
  profileId: string;
  original: LocalApp;
  state: 'associated' | 'missing';
  unlink: 'keep_program_and_data';
}
export function captureInPlaceApp(app: LocalApp, scope: LegacyDesktopScope): InPlaceApp {
  if (!reference(scope.profileId) || !reference(app.id) || !app.name.trim() || !app.path || typeof app.exists !== 'boolean') throw new Error('invalid_legacy_app_record');
  return { executor: 'os_app', profileId: scope.profileId, original: structuredClone(app),
    state: app.exists ? 'associated' : 'missing', unlink: 'keep_program_and_data' };
}
