import { parseUniqueJson } from './json';
import { lstat, readFile } from 'node:fs/promises';
import type { DesktopManagedScope } from './managed-plugins';
import { privateStateParent } from './durable-file';
export interface KitControllerConfiguration extends DesktopManagedScope { port: number; controller_token: string }
/** Trusted provisioner-owned file only. Never load this through renderer settings
 * or a Kit package. No credentials are returned by public desktop snapshots. */
export async function readKitControllerConfiguration(file: string): Promise<KitControllerConfiguration | null> {
  try {
    await privateStateParent(file);
    const info = await lstat(file);
    if (process.platform === 'win32') throw new Error('kit_controller_private_acl_not_verified');
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8192 ||
        ((info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.())) throw new Error('invalid_kit_controller_file_permissions');
    let value: KitControllerConfiguration;
    try { value = parseUniqueJson(await readFile(file, 'utf8')) as KitControllerConfiguration; } catch { throw new Error('invalid_kit_controller_configuration'); }
    if (!value || Object.keys(value).some(key => !['owner_id', 'heart_id', 'target_id', 'authority', 'port', 'controller_token'].includes(key)) ||
        ![value.owner_id, value.heart_id, value.target_id].every(v => typeof v === 'string' && /^[a-zA-Z0-9_.-]{1,160}$/.test(v)) ||
        !['local', 'home'].includes(value.authority) || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535 ||
        typeof value.controller_token !== 'string' || Buffer.byteLength(value.controller_token) < 32 || Buffer.byteLength(value.controller_token) > 1024 || Buffer.from(value.controller_token).toString('utf8') !== value.controller_token || /[\r\n\0]/.test(value.controller_token)) throw new Error('invalid_kit_controller_configuration');
    return value;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}
