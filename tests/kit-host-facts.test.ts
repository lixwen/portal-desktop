import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DesktopHostFacts, desktopCapabilities, type HostRegistration, type HomeNativeSession } from '../desktop/main/kits/host-facts';
const originalPlatform = process.platform;
const roots: string[] = [];
afterEach(async () => { Object.defineProperty(process, 'platform', { value: originalPlatform }); vi.restoreAllMocks(); vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-kit-host-')); roots.push(root); const file = path.join(root, 'host.json'); return { root, file, facts: new DesktopHostFacts(file) }; }
function session(register: HomeNativeSession['register']): HomeNativeSession { return { ownerId: 'owner', clientId: 'native-client', homeOrigin: 'https://home.fixture.invalid', register }; }
const receipt = { target_id: 'owned-target', revision: 1, generation: 1, lease_expires_at: new Date(Date.now() + 60_000).toISOString() };
it('uses actual native platform and stable private identity across restart without asserting MCP or App readiness', async () => {
  const { file, facts } = await fixture();
  const one = await facts.identity(), two = await new DesktopHostFacts(file).identity();
  expect(two).toEqual(one);
  const capabilities = desktopCapabilities('desktop_plugin_host');
  expect(capabilities.operating_system).toBe(({ darwin: 'macos', win32: 'windows', linux: 'linux' } as Record<string, string>)[process.platform]);
  expect(capabilities.architecture).toBe(({ x64: 'x86_64', arm64: 'aarch64', arm: 'armv7' } as Record<string, string>)[process.arch]);
  expect(capabilities).toMatchObject({ features: [], transports: [], external: {}, trusts: ['user_computer'] });
  expect(capabilities).not.toHaveProperty('target_id'); expect(capabilities).not.toHaveProperty('online');
  if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
});
it('binds registration to owner/session/executor, increments revision expectation and replaces process incarnation on restart', async () => {
  const { file, facts } = await fixture(); const requests: HostRegistration[] = [];
  const transport = session(async request => { requests.push(request); const generation = requests.length < 3 ? 1 : 2; return { ...receipt, revision: generation, generation }; });
  await facts.enroll(transport, 'desktop_plugin_host'); await facts.enroll(transport, 'desktop_plugin_host');
  expect(requests[0]).not.toHaveProperty('expected_revision'); expect(requests[1].expected_revision).toBe(1);
  expect(requests[1].incarnation_id).toBe(requests[0].incarnation_id);
  await new DesktopHostFacts(file).enroll(transport, 'desktop_plugin_host');
  expect(requests[2].device_id).toBe(requests[0].device_id); expect(requests[2].incarnation_id).not.toBe(requests[0].incarnation_id);
  await facts.enroll({ ...transport, ownerId: 'other-owner' }, 'os_app');
  expect(requests[3]).not.toHaveProperty('expected_revision'); expect(requests[3].capabilities.executor).toBe('os_app');
  expect(await readFile(file, 'utf8')).not.toContain('Bearer');
});
it('keeps device after lost response and rejects target substitution/stale or expired registration receipts', async () => {
  const { file, facts } = await fixture();
  let lost: HostRegistration | undefined;
  await expect(facts.enroll(session(async request => { lost = request; throw new Error('offline'); }), 'os_app')).rejects.toThrow('offline');
  const identity = await new DesktopHostFacts(file).identity();
  const replayed: HostRegistration[] = [];
  await new DesktopHostFacts(file).enroll(session(async req => { replayed.push(req); expect(req.device_id).toBe(identity.deviceId); if (replayed.length === 1) expect(req).toEqual(lost); return { ...receipt, revision: replayed.length, generation: replayed.length }; }), 'os_app');
  expect(replayed).toHaveLength(2); expect(replayed[1].incarnation_id).not.toBe(lost!.incarnation_id); expect(replayed[1].expected_revision).toBe(1);
  await expect(facts.enroll(session(async () => ({ ...receipt, target_id: 'other' })), 'os_app')).rejects.toThrow('invalid_host_registration_receipt');
  await expect(facts.enroll(session(async () => ({ ...receipt, lease_expires_at: '2000-01-01T00:00:00Z' })), 'os_app')).rejects.toThrow('invalid_host_registration_receipt');
  await expect(facts.enroll({ ...session(async () => receipt), homeOrigin: 'https://user:password@home.fixture.invalid' }, 'os_app')).rejects.toThrow('invalid_home_native_session');
});
it('keeps Home realms on the same origin separate without reusing enrollment revisions or pending requests', async () => {
  const { facts } = await fixture(); const requests: HostRegistration[] = [];
  const transport = session(async request => { requests.push(request); return { ...receipt, target_id: `realm-${requests.length}` }; });
  await facts.enroll({ ...transport, homeRealm: 'https://home.fixture.invalid/first/' }, 'os_app');
  await facts.enroll({ ...transport, homeRealm: 'https://home.fixture.invalid/second/' }, 'os_app');
  expect(requests[0].expected_revision).toBeUndefined(); expect(requests[1].expected_revision).toBeUndefined(); expect(requests[1].device_id).toBe(requests[0].device_id); expect(requests[1].request_id).not.toBe(requests[0].request_id);
  await expect(facts.enroll({ ...transport, homeRealm: 'https://foreign.invalid/' }, 'os_app')).rejects.toThrow('invalid_home_native_realm');
});

it('observes a bounded native name only after fixed Home feature negotiation and omits it for old Home', async () => {
  vi.spyOn(os, 'hostname').mockReturnValue('  Synthetic Mac  ');
  const { facts } = await fixture(); const requests: HostRegistration[] = [];
  const transport = session(async request => { requests.push(request); return receipt; });
  await facts.enroll(transport, 'os_app');
  expect(requests[0]).not.toHaveProperty('device_display_name');
  await facts.enroll({ ...transport, serverFeatures: ['kit.host-device-display-name.v1'] }, 'os_app');
  expect(requests[1].device_display_name).toBe('Synthetic Mac');
  expect(requests[1].device_id).toBe(requests[0].device_id);
  expect(requests[1].incarnation_id).toBe(requests[0].incarnation_id);
  expect(requests[1].capabilities).toEqual(requests[0].capabilities);
});
it('falls back to target identity for blank, control or oversized actual hostname observations', async () => {
  for (const value of ['  ', 'fixture\nname', 'fixture\u0085name', 'x'.repeat(129), '\u7535'.repeat(43)]) {
    vi.spyOn(os, 'hostname').mockReturnValue(value);
    const { facts } = await fixture(); let sent: HostRegistration | undefined;
    await facts.enroll({ ...session(async request => { sent = request; return receipt; }), serverFeatures: ['kit.host-device-display-name.v1'] }, 'os_app');
    expect(sent).not.toHaveProperty('device_display_name');
    vi.restoreAllMocks();
  }
});
it('does not alter a persisted pending request or send new fields if negotiated Home support disappears', async () => {
  vi.spyOn(os, 'hostname').mockReturnValue('Synthetic Device'); const { facts, file } = await fixture();
  const capable = { ...session(async () => { throw new Error('lost_response'); }), serverFeatures: ['kit.host-device-display-name.v1'] };
  await expect(facts.enroll(capable, 'os_app')).rejects.toThrow('lost_response');
  const before = await readFile(file, 'utf8'); const register = vi.fn(async () => receipt);
  await expect(new DesktopHostFacts(file).enroll(session(register), 'os_app')).rejects.toThrow('host_registration_feature_lost');
  expect(register).not.toHaveBeenCalled(); expect(await readFile(file, 'utf8')).toBe(before);
});

it('rejects new managed B/C on Linux before native registration or identity writes', async () => {
  const { facts, file } = await fixture(); const register = vi.fn(async () => receipt);
  Object.defineProperty(process, 'platform', { value: 'linux' }); vi.spyOn(os, 'platform').mockReturnValue('linux');
  for (const executor of ['desktop_plugin_host', 'os_app'] as const) await expect(facts.enroll(session(register), executor)).rejects.toThrow('unsupported_managed_desktop_platform');
  expect(register).not.toHaveBeenCalled(); await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('keeps Linux stable identity and MCP A enrollment independent of unsupported B/C', async () => {
  const { facts } = await fixture(); Object.defineProperty(process, 'platform', { value: 'linux' }); vi.spyOn(os, 'platform').mockReturnValue('linux');
  const identity = await facts.identity(); expect(identity.capabilities).toEqual([]);
  const register = vi.fn(async () => receipt);
  const enrolled = await facts.enrollObserved(session(register), { ...desktopCapabilities('os_app'), executor: 'portal_mcp', features: ['home.authority-channel.v1'] });
  expect(enrolled.target_id).toBe(receipt.target_id); expect(register).toHaveBeenCalledTimes(1); expect(register.mock.calls[0]).toBeDefined();
});
