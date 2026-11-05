import { afterEach, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readKitControllerConfiguration } from '../desktop/main/kits/controller-config';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it('allows absence, validates bounded native provisioner config and rejects credentials from symlinks or loose permissions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kit-controller-config-')); roots.push(root);
  const file = path.join(root, 'controller.json');
  expect(await readKitControllerConfiguration(file)).toBeNull();
  const config = { port: 12345, controller_token: 'fixture-private-controller-token-0000', owner_id: 'owner', heart_id: 'being', target_id: 'target', authority: 'local' };
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  expect(await readKitControllerConfiguration(file)).toEqual(config);
  const link = path.join(root, 'link.json'); await symlink(file, link);
  await expect(readKitControllerConfiguration(link)).rejects.toThrow('invalid_kit_controller_file_permissions');
  if (process.platform !== 'win32') { await chmod(file, 0o644); await expect(readKitControllerConfiguration(file)).rejects.toThrow('invalid_kit_controller_file_permissions'); await chmod(file, 0o600); }
  await writeFile(file, '{"controller_token":"must-never-appear-in-error"');
  await expect(readKitControllerConfiguration(file)).rejects.toThrow('invalid_kit_controller_configuration');
  await writeFile(file, 'x'.repeat(8193));
  await expect(readKitControllerConfiguration(file)).rejects.toThrow('invalid_kit_controller_file_permissions');
});
