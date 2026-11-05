import path from 'node:path';
import { privateJson } from '../kits/market-native';
import { durablePrivateJson } from '../kits/durable-file';
import { reference } from '../kits/desktop-host-contract';
const queues = new Map<string, Promise<unknown>>();
/** Deny-only tombstones survive logout and serialize all native A/B/C writers.
 * No Home identity, source, tool catalog, token or positive grant lives here. */
export function reserveHomePlugins(directory: string, pluginIds: string[]) {
  const file = path.join(directory, 'home-native-reservations.json');
  const operation = (queues.get(file) || Promise.resolve()).then(async () => {
    let old: { format_version: number; plugin_ids: string[] };
    try { old = await privateJson(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; old = { format_version: 1, plugin_ids: [] }; }
    if (old.format_version !== 1 || !Array.isArray(old.plugin_ids) || old.plugin_ids.length > 4096 || [...old.plugin_ids, ...pluginIds].some(id => !reference(id))) throw new Error('home_native_reservations_invalid');
    const ids = [...new Set([...old.plugin_ids, ...pluginIds])].sort(); if (ids.length > 4096) throw new Error('home_native_reservation_limit');
    await durablePrivateJson(file, { format_version: 1, plugin_ids: ids });
  });
  queues.set(file, operation.catch(() => {})); return operation;
}
