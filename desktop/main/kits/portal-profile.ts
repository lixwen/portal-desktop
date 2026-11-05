import path from 'node:path';
import type { Settings } from '../../shared/types';
import type { Connection } from '../chat/connection';
import { privateJson } from './market-native';
export async function homeReservationPrefix(directory: string): Promise<string> {
  const file = path.join(directory, 'home-native-reservations.json');
  try { const value = await privateJson(file); if (value.format_version !== 1 || !Array.isArray(value.plugin_ids) || value.plugin_ids.length > 4096 || value.plugin_ids.some((id: unknown) => typeof id !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(id))) throw new Error('home_native_reservations_invalid'); return `home_native_reservations = ${JSON.stringify(file)}\n`; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}
/** The private profile belongs to local product bootstrap, never a Kit. */
export async function managedPortalProfile(directory: string, connection: Connection): Promise<{ prefix: string; suffix: string; secrets: string[] }> {
  const reservations = await homeReservationPrefix(directory);
  let value: any;
  try { value = await privateJson(path.join(directory, 'kit-portal-profile.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { prefix: reservations, suffix: '', secrets: [] }; throw error; }
  if (value?.format_version !== 1 || value.beingEndpoint !== connection.endpoint || value.heartId !== connection.being || !path.isAbsolute(value.kitsDir || '') || typeof value.fragment !== 'string' || !Array.isArray(value.secrets) || value.secrets.some((v: unknown) => typeof v !== 'string')) throw new Error('kit_portal_profile_identity_changed');
  return { prefix: reservations + `kits_dir = ${JSON.stringify(value.kitsDir)}\n`, suffix: '\n' + value.fragment, secrets: value.secrets };
}
export async function managedPortalConfig(directory: string, settings: Settings, connection: Connection, base: (settings: Settings) => string): Promise<string> {
  const profile = await managedPortalProfile(directory, connection);
  return profile.prefix + base(settings) + profile.suffix;
}
