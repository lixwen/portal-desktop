import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
/** Required for management tombstones: publish only after file and containing
 * directory are synchronized. Unsupported directory synchronization propagates
 * failure; callers must keep managed execution unavailable. */
async function durableDirectory(directory: string): Promise<void> {
  try { const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('private_directory_invalid'); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const parent = path.dirname(directory);
  await durableDirectory(parent);
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('private_directory_invalid');
  const handle = await open(parent, 'r'); try { await handle.sync(); } finally { await handle.close(); }
}
/** A private file mode cannot protect a tombstone if another OS user can
 * rename its parent directory. Root-owned sticky temporary boundaries are safe;
 * writable non-sticky ancestors or foreign-owned ancestors are rejected. */
export async function privateStateParent(file: string): Promise<void> {
  if (process.platform === 'win32') return; // Managed Windows ACL support is unavailable at configuration admission.
  let directory = path.dirname(file);
  for (;;) {
    try { directory = await realpath(directory); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; const parent = path.dirname(directory); if (parent === directory) throw error; directory = parent; }
  }
  for (;;) {
    const info = await lstat(directory);
    if (!info.isDirectory() || ![0, process.getuid?.()].includes(info.uid) || ((info.mode & 0o022) && !(info.mode & 0o1000))) throw new Error('private_state_ancestor_not_protected');
    const parent = path.dirname(directory); if (parent === directory) break; directory = parent;
  }
}
export function durablePrivateJson(file: string, value: unknown, beforePublish?: () => void) {
  return durablePrivateText(file, JSON.stringify(value), beforePublish);
}
export async function durablePrivateText(file: string, value: string, beforePublish?: () => void) {
  const parent = path.dirname(file);
  await durableDirectory(parent);
  await privateStateParent(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  const directory = await open(parent, 'r');
  try {
    // Check directory-sync support before publishing any new state.
    await directory.sync();
    const output = await open(temporary, 'wx', 0o600);
    try { await output.writeFile(value); await output.sync(); }
    finally { await output.close(); }
    beforePublish?.();
    await rename(temporary, file);
    await directory.sync();
  } finally { await directory.close(); await rm(temporary, { force: true }); }
}
