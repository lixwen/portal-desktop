import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseUniqueJson } from './json';
import type { DesktopTargetPolicy } from './desktop-host-contract';
import { reference } from './desktop-host-contract';
import { PLUGIN_CAPABILITIES, type PluginCapability } from '../../shared/plugins';
import { privateStateParent } from './durable-file';
export interface DesktopHostConfiguration { format_version: 1; port: number; targets: DesktopTargetPolicy[] }
/** Private native provisioning only. Never load paths or secrets from a Kit. */
export async function readDesktopHostConfiguration(file: string): Promise<DesktopHostConfiguration | null> {
  try {
    await privateStateParent(file);
    const info = await lstat(file);
    if (process.platform === 'win32') throw new Error('desktop_controller_private_acl_not_verified');
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65536 || ((info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.())) throw new Error('desktop_controller_file_permissions_invalid');
    let raw: any; try { raw = parseUniqueJson(await readFile(file, 'utf8')); } catch { throw new Error('desktop_controller_configuration_invalid'); }
    if (!raw || raw.format_version !== 1 || !Number.isSafeInteger(raw.port) || raw.port < 0 || raw.port > 65535 || !Array.isArray(raw.targets) || !raw.targets.length || raw.targets.length > 8) throw new Error('desktop_controller_configuration_invalid');
    const seen = new Set<string>(), secrets = new Set<string>();
    for (const target of raw.targets) {
      if (!target?.context || target.context.authority !== 'local' || ![target.context.owner_id, target.context.heart_id, target.context.target_id].every(reference) ||
          seen.has(target.context.target_id) || !['desktop_plugin_host', 'os_app'].includes(target.executor) || !Number.isSafeInteger(target.generation) || target.generation < 1 || !Number.isSafeInteger(target.policyRevision) || target.policyRevision < 1 ||
          !target.roots || typeof target.roots !== 'object' || !Object.entries(target.roots).every(([id, value]) => reference(id) && typeof value === 'string' && path.isAbsolute(value) && path.parse(value).root !== value) ||
          !Array.isArray(target.allowedPluginCapabilities) || target.allowedPluginCapabilities.some((v: string) => !Object.hasOwn(PLUGIN_CAPABILITIES, v)) ||
          !['readRoots', 'writeRoots', 'networkHosts'].every(key => Array.isArray(target[key]) && target[key].every((v: unknown) => typeof v === 'string')) ||
          target.readRoots.some((id: string) => !Object.hasOwn(target.roots, id)) || target.writeRoots.some((id: string) => !Object.hasOwn(target.roots, id))) throw new Error('desktop_controller_configuration_invalid');
      seen.add(target.context.target_id);
      for (const token of [target.controllerToken, target.consumerToken].filter(Boolean)) {
        if (typeof token !== 'string' || Buffer.byteLength(token) < 32 || Buffer.byteLength(token) > 1024 || Buffer.from(token).toString('utf8') !== token || /[\r\n\0]/.test(token) || secrets.has(Buffer.from(token).toString('hex'))) throw new Error('desktop_controller_secret_audience_conflict'); secrets.add(Buffer.from(token).toString('hex'));
      }
      if (!target.controllerToken || (target.executor === 'os_app' && target.consumerToken)) throw new Error('desktop_controller_configuration_invalid');
      if (target.beingEndpoint !== undefined) {
        try { const endpoint = new URL(target.beingEndpoint); if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash || endpoint.search || endpoint.href !== target.beingEndpoint) throw new Error(); }
        catch { throw new Error('desktop_controller_endpoint_invalid'); }
      }
      target.allowedPluginCapabilities = target.allowedPluginCapabilities as PluginCapability[];
    }
    return raw as DesktopHostConfiguration;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
