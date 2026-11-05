import { execFileSync } from 'node:child_process';
export function checkKitRuntimePair(portal, installer) {
  const read = (file, flag) => JSON.parse(execFileSync(file, [flag], { encoding: 'utf8', timeout: 15000, windowsHide: true }));
  const host = read(portal, '--kit-runtime-capabilities'), cli = read(installer, '--capabilities');
  for (const caps of [host, cli]) if (caps.format_version !== 1 || caps.control_protocol !== 'kit-control-hmac-v1' || !['runtime.plan.v1', 'native_entry.admission.v1', 'host.spawn-proof.v1'].every(f => caps.features?.includes(f))) throw new Error('Bundled Kit runtime lacks required managed admission/spawn-proof support.');
  if (!cli.features.includes('market.pinned-source.v1') || !cli.features.includes('desktop.original-sdk.v1') || host.executor !== 'portal_mcp' || !host.features.includes('mcp.stdio.v1') || !host.trusts?.includes('user_computer')) throw new Error('Bundled Kit market/host runtime is incompatible.');
  return { portal: host, installer: cli };
}
