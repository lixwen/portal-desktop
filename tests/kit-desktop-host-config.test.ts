import { afterEach, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readDesktopHostConfiguration } from '../desktop/main/kits/desktop-host-config';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true }); });
it('loads only protected native policy and rejects role secret reuse, unsafe endpoint and symlink', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-host-policy-')); roots.push(root);
  const file = path.join(root, 'policy.json'); expect(await readDesktopHostConfiguration(file)).toBeNull();
  const policy = { format_version: 1, port: 0, targets: [{ context: { owner_id: 'owner', heart_id: 'heart', target_id: 'B', authority: 'local' }, executor: 'desktop_plugin_host', controllerToken: 'i'.repeat(40), consumerToken: 'p'.repeat(40), generation: 1, policyRevision: 1, roots: { state: root }, allowedPluginCapabilities: ['storage'], readRoots: ['state'], writeRoots: [], networkHosts: [], beingEndpoint: 'https://fixture.invalid/heart' }] };
  await writeFile(file, JSON.stringify(policy), { mode: 0o600 }); expect((await readDesktopHostConfiguration(file))?.targets[0].context.target_id).toBe('B');
  await chmod(file, 0o644); await expect(readDesktopHostConfiguration(file)).rejects.toThrow('permissions_invalid'); await chmod(file, 0o600);
  await symlink(file, path.join(root, 'link.json')); await expect(readDesktopHostConfiguration(path.join(root, 'link.json'))).rejects.toThrow('permissions_invalid');
  const shared = structuredClone(policy); shared.targets[0].consumerToken = shared.targets[0].controllerToken; await writeFile(file, JSON.stringify(shared));
  await expect(readDesktopHostConfiguration(file)).rejects.toThrow('audience_conflict');
  const unsafe = structuredClone(policy); unsafe.targets[0].beingEndpoint = 'https://user:private@fixture.invalid/heart'; await writeFile(file, JSON.stringify(unsafe));
  await expect(readDesktopHostConfiguration(file)).rejects.toThrow('endpoint_invalid');
});
