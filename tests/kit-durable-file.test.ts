import { afterEach, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { durablePrivateJson } from '../desktop/main/kits/durable-file';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it('publishes private synchronized state and preserves the previous record when pre-publication authority is revoked', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kit-durable-file-')); roots.push(root);
  const file = path.join(root, 'new', 'private', 'state.json');
  await durablePrivateJson(file, { revision: 1 });
  await expect(durablePrivateJson(file, { revision: 2 }, () => { throw new Error('revoked'); })).rejects.toThrow('revoked');
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ revision: 1 });
  expect(await readdir(path.dirname(file))).toEqual(['state.json']);
  if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
  const link = path.join(root, 'link'); await symlink(path.dirname(file), link);
  await expect(durablePrivateJson(path.join(link, 'other.json'), {})).rejects.toThrow('private_directory_invalid');
});
it.skipIf(process.platform === 'win32')('rejects a writable non-sticky ancestor even when the record itself has private mode', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kit-private-parent-')); roots.push(root);
  const file = path.join(root, 'private', 'state.json'); await durablePrivateJson(file, { revision: 1 });
  await chmod(root, 0o777);
  try { await expect(durablePrivateJson(file, { revision: 2 })).rejects.toThrow('ancestor_not_protected'); }
  finally { await chmod(root, 0o700); }
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ revision: 1 });
});
