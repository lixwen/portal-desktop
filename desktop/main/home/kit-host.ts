import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { access, lstat, mkdir, readFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { HomeClient } from './client';
import { reserveHomePlugins } from './reservations';
import type { HomeMe } from '../../shared/home';
import type { HomeKitHostState } from '../../shared/home-kit';
import type { Connection } from '../chat/connection';
import type { Settings } from '../../shared/types';
import { permissionMode } from '../../shared/security';
import { privateJson, runInstaller } from '../kits/market-native';
import { durablePrivateJson, durablePrivateText, privateStateParent } from '../kits/durable-file';
import { protocolDigest, reference, digest } from '../kits/desktop-host-contract';
import type { DesktopHostFacts, HomeNativeSession, HostCapabilityDescription } from '../kits/host-facts';

interface RuntimeConfiguration { format_version: 1; policy_revision: number; runtimes: Record<string, { file: string; sha256: string }>; development_portal?: { file: string; sha256: string }; ca_file?: string }
interface Options { directory: string; resources: string; packaged: boolean; home: HomeClient; facts: DesktopHostFacts; settings(): Settings; connection(): Connection | null; confirm(message: string, detail: string): Promise<boolean> }
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function pin(file: string, expected: string) {
  if (!path.isAbsolute(file) || !digest(expected)) throw new Error('home_host_runtime_pin_invalid');
  await privateStateParent(file); const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o022) || ![0, process.getuid?.()].includes(info.uid)) throw new Error('home_host_runtime_not_protected');
  await access(file, constants.X_OK); if (sha(await readFile(file)) !== expected) throw new Error('home_host_runtime_pin_changed');
}
/** A separate Home authority process and private token file. This never binds a
 * Home installation to the Pure Local ledger or gives tokens to a child Kit. */
export class NativeHomeKitHost {
  private starting?: Promise<HomeKitHostState>; private child?: ChildProcess; private epoch = 0; private timer?: ReturnType<typeof setInterval>; private refreshing = false;
  private tokenFile?: string; private context?: string; private stopping?: Promise<void>;
  private value: HomeKitHostState = { phase: 'stopped', message: 'Home 本机宿主尚未启用。' };
  constructor(private options: Options) { options.home.onSessionInvalidated(() => { void this.stop().catch(() => { this.value = { phase: 'failed', message: 'Home 通道已失效；宿主停止尚未确认。' }; }); }); }
  state(): HomeKitHostState { return { ...this.value }; }
  private currentContext() { const s = this.options.settings(), h = this.options.home.state(), c = this.options.connection(); return protocolDigest({ home: h.baseUrl, client: h.clientId, endpoint: c?.endpoint || '', link: c?.link || '', mode: permissionMode(s.permissionMode), kits: s.kitsEnabled, binary: s.portalBinary }); }
  async contextChanged() { if (this.context && this.context !== this.currentContext()) await this.stop(); }
  private async configuration() {
    const config = await privateJson(path.join(this.options.directory, 'kit-home-host.json')) as RuntimeConfiguration;
    if (config?.format_version !== 1 || !Number.isSafeInteger(config.policy_revision) || config.policy_revision < 1 || !config.runtimes || typeof config.runtimes !== 'object' || Array.isArray(config.runtimes) || !Object.keys(config.runtimes).length || Object.keys(config.runtimes).length > 16) throw new Error('home_host_configuration_invalid');
    for (const [id, runtime] of Object.entries(config.runtimes)) { if (!reference(id) || !runtime) throw new Error('home_host_runtime_invalid'); await pin(runtime.file, runtime.sha256); }
    let file = this.options.settings().portalBinary, expected: string;
    if (!this.options.packaged && config.development_portal) { file = config.development_portal.file; expected = config.development_portal.sha256; }
    else { const bundle = JSON.parse(await readFile(path.join(this.options.resources, 'runtime-bundle.json'), 'utf8')); if (bundle.schema !== 2 || bundle.platform !== process.platform || bundle.arch !== process.arch) throw new Error('home_host_runtime_bundle_invalid'); expected = bundle.sha256; }
    await pin(file, expected);
    const caps = await runInstaller(file, ['--kit-runtime-capabilities']);
    if (caps.format_version !== 1 || caps.executor !== 'portal_mcp' || caps.control_protocol !== 'kit-control-hmac-v1' || !['home.authority-channel.v1', 'runtime.plan.v1', 'native_entry.admission.v1', 'host.spawn-proof.v1'].every(f => caps.features?.includes(f))) throw new Error('home_host_feature_unsupported');
    if (config.ca_file) { if (!path.isAbsolute(config.ca_file)) throw new Error('home_host_ca_invalid'); await privateStateParent(config.ca_file); const info = await lstat(config.ca_file); if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024 || (info.mode & 0o022)) throw new Error('home_host_ca_invalid'); }
    return { config, binary: file };
  }
  start(): Promise<HomeKitHostState> {
    if (this.starting) return this.starting;
    this.starting = this.launch().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private async launch(): Promise<HomeKitHostState> {
    if (this.stopping) await this.stopping;
    if (this.child) return this.state();
    const epoch = ++this.epoch, current = this.currentContext(), home = this.options.home.state(), connection = this.options.connection();
    this.value = { phase: 'starting', message: '正在核对独立 Home 身份和实际本机运行配置。' };
    try {
      if (!home.signedIn || !connection) throw new Error('请先独立登录 Home，并保存现有 Heart 连接。');
      if (permissionMode(this.options.settings().permissionMode) !== 'full-access' || !this.options.settings().kitsEnabled) throw new Error('Home MCP Host 需要当前已启用 Kit 的 FullAccess 策略；此操作不会更改权限设置。');
      const me = await this.options.home.request<HomeMe>('/v1/me');
      if (me.user.status !== 'active' || !me.being || me.being.owner_user_id !== me.user.id) throw new Error('请先在 Home 初始化当前账号的 Being 空间。');
      const { config, binary } = await this.configuration();
      if (!await this.options.confirm('启用独立 Home 本机宿主？', `Home：${home.baseUrl}\n账号：${me.username || me.user.id}\n现有 Heart：${connection.endpoint}\n\n将由 Home 在线验证并关联此完整 Heart；不会改绑已有的不同目标。运行时：\n${Object.entries(config.runtimes).map(([id, r]) => `${id}: ${r.file}`).join('\n')}\n\n将更新本机 Portal 的旧插件入口保护并重启其受管实例。代码只在 Home 已确认计划和真实宿主回执下启用。纯本机安装权威与此实例保持独立。`)) { this.value = { phase: 'stopped', message: '已取消启用。' }; return this.state(); }
      if (epoch !== this.epoch || current !== this.currentContext()) throw new Error('home_host_context_changed');
      await this.options.home.request('/v1/me/heart/import', 'POST', { link: connection.link, acknowledge_binding: true });
      const latest = await this.options.home.request<HomeMe>('/v1/me');
      if (latest.user.id !== me.user.id || latest.being?.id !== me.being.id || latest.being?.owner_user_id !== me.user.id) throw new Error('home_host_owner_changed');
      const identity = protocolDigest({ home: home.baseUrl, client: home.clientId, owner: me.user.id, profile: me.being.id, endpoint: connection.endpoint });
      const root = path.join(this.options.directory, 'kit-home', identity), components = path.join(root, 'components'), portalHome = path.join(root, 'home');
      await mkdir(components, { recursive: true, mode: 0o700 }); await mkdir(portalHome, { recursive: true, mode: 0o700 });
      const credential = path.join(root, 'authority.json'); let authority: { secret: string; port: number };
      try { authority = await privateJson(credential); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; const { createServer } = await import('node:net'); const probe = createServer(); await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); }); const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve())); authority = { secret: randomBytes(48).toString('hex'), port }; await durablePrivateJson(credential, authority); }
      if (!/^[a-f0-9]{96}$/.test(authority.secret) || !Number.isInteger(authority.port) || authority.port < 1 || authority.port > 65535) throw new Error('home_host_authority_invalid');
      const incarnation = randomUUID(), heartOrigin = new URL(connection.endpoint).origin, heartId = `heart_${protocolDigest({ domain: 'home-kit-heart-v1', origin: heartOrigin, being_id: connection.being })}`;
      const configFile = path.join(root, 'portal.toml'), tokenFile = path.join(root, 'home-access.json'); this.tokenFile = tokenFile;
      await reserveHomePlugins(this.options.directory, []);
      const q = JSON.stringify;
      const toml = (target: string, generation: number) => `home_native_reservations=${q(path.join(this.options.directory, 'home-native-reservations.json'))}\nname=${q(`home-${me.being!.id}`)}\nconnect=${q(connection.link)}\nworkspace=${q(components)}\nkits_dir=${q(components)}\nkits_enabled=true\nbind="127.0.0.1:9100"\n[tools]\nexec=${this.options.settings().allowExec}\ncustom_tools_enabled=true\n[security]\npermission_mode=${q(permissionMode(this.options.settings().permissionMode))}\n[subagent]\nenabled=false\nauto_install=false\n[kit_runtime]\nowner_id=${q(me.user.id)}\nheart_id=${q(heartId)}\ntarget_id=${q(target)}\nauthority="home"\nstate_dir=${q(path.join(root, 'runtime'))}\ncontroller_token=${q(authority.secret)}\ncontroller_bind=${q(`127.0.0.1:${authority.port}`)}\nrelay_origin=${q(heartOrigin)}\n[kit_runtime.home_authority]\nhome_url=${q(home.baseUrl)}\nprofile_id=${q(me.being!.id)}\nheart_origin=${q(heartOrigin)}\nheart_slug=${q(connection.being)}\nincarnation_id=${q(incarnation)}\ntoken_file=${q(tokenFile)}\nruntime="local"\n${config.ca_file ? `ca_file=${q(config.ca_file)}\n` : ''}[kit_runtime.host_policy]\ngeneration=${generation}\npolicy_revision=${config.policy_revision}\n[kit_runtime.host_policy.roots]\n"home-components"=${q(components)}\n[kit_runtime.host_policy.runtimes]\n${Object.entries(config.runtimes).map(([id, r]) => `${q(id)}=${q(r.file)}`).join('\n')}\n[kit_runtime.host_policy.permission_ceiling]\nread_roots=["home-components"]\nwrite_roots=[]\nnetwork_hosts=[]\n`;
      const atomicConfig = (text: string) => durablePrivateText(configFile, text, () => { if (epoch !== this.epoch || current !== this.currentContext()) throw new Error('home_host_context_changed'); });
      await atomicConfig(toml('pending-target', 1));
      const observed = await runInstaller(binary, ['--config', configFile, '--kit-configured-host-facts']) as HostCapabilityDescription;
      if (observed.runtime !== 'local' || observed.executor !== 'portal_mcp' || !observed.features.includes('home.authority-channel.v1') || ['target_id', 'generation', 'online'].some(key => Object.hasOwn(observed, key))) throw new Error('home_host_observation_invalid');
      const session: HomeNativeSession = { ownerId: me.user.id, homeOrigin: new URL(home.baseUrl).origin, homeRealm: home.baseUrl, clientId: home.clientId, serverFeatures: await this.options.home.nativeFeatures(), register: async body => {
        if (epoch !== this.epoch || current !== this.currentContext()) throw new Error('home_host_context_changed');
        return this.options.home.request('/v1/me/kit-hosts/registrations', 'POST', body);
      } };
      const receipt = await this.options.facts.enrollObserved(session, observed, incarnation);
      await atomicConfig(toml(receipt.target_id, receipt.generation));
      const refresh = async () => {
        if (epoch !== this.epoch || current !== this.currentContext()) throw new Error('home_host_context_changed');
        const owner = await this.options.home.request<HomeMe>('/v1/me'); if (owner.user.id !== me.user.id || owner.being?.id !== me.being!.id) throw new Error('home_host_owner_changed');
        await this.options.home.withAccessToken(async access => {
          if (access.baseUrl !== home.baseUrl || access.clientId !== home.clientId) throw new Error('home_host_context_changed');
          await durablePrivateJson(tokenFile, { format_version: 1, home_url: home.baseUrl, owner_id: me.user.id, access_token: access.accessToken }, () => { if (epoch !== this.epoch || current !== this.currentContext()) throw new Error('home_host_context_changed'); });
        });
        const renewed = await this.options.facts.enrollObserved(session, observed, incarnation);
        if (renewed.target_id !== receipt.target_id || renewed.generation !== receipt.generation) throw new Error('home_host_enrollment_changed');
      };
      await refresh();
      if (epoch !== this.epoch || current !== this.currentContext()) throw new Error('home_host_context_changed');
      const env: NodeJS.ProcessEnv = {};
      for (const key of ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key];
      Object.assign(env, { HOME: portalHome, HEART_PORTAL_SUPERVISED: '1', HEART_PORTAL_CLIENT_MANAGED: '1', NO_COLOR: '1', RUST_LOG: 'warn' });
      const child = spawn(binary, ['--config', configFile], { env, cwd: components, stdio: 'ignore', windowsHide: true }); this.child = child; this.context = current;
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new Error('home_host_spawn_failed'))); });
      child.once('exit', () => { if (this.child !== child) return; this.child = undefined; if (this.timer) clearInterval(this.timer); this.value = { phase: 'failed', message: 'Home 宿主进程已退出；未声明组件停止或业务成功。' }; void rm(tokenFile, { force: true }); });
      this.timer = setInterval(() => { if (this.refreshing) return; this.refreshing = true; void refresh().catch(() => this.stop()).catch(() => { this.value = { phase: 'failed', message: 'Home 认证失效；宿主停止尚未确认。' }; }).finally(() => { this.refreshing = false; }); }, 20000); this.timer.unref?.();
      this.value = { phase: 'running', message: '独立 Home 宿主进程运行中；通道和组件就绪以 Home 真实回执为准。', targetId: receipt.target_id, generation: receipt.generation };
      return this.state();
    } catch (error) { await this.stop(); this.value = { phase: 'failed', message: error instanceof Error ? error.message : 'home_host_start_failed' }; throw error; }
  }
  async stop(): Promise<void> {
    this.epoch++; this.context = undefined; if (this.timer) clearInterval(this.timer); this.timer = undefined;
    if (this.stopping) return this.stopping;
    const child = this.child, token = this.tokenFile; this.tokenFile = undefined;
    this.value = { phase: 'stopping', message: '正在关闭 Home 宿主进程和认证通道。' };
    this.stopping = (async () => {
      // Revoke the private credential even if process termination cannot be observed.
      let removalError: unknown; if (token) try { await rm(token, { force: true }); } catch (error) { removalError = error; }
      if (child?.pid && child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { child.kill('SIGKILL'); }, 5000); const deadline = setTimeout(() => { clearTimeout(timer); reject(new Error('home_host_stop_unconfirmed')); }, 15000); child.once('exit', () => { clearTimeout(timer); clearTimeout(deadline); resolve(); }); child.kill('SIGTERM'); });
      if (this.child === child) this.child = undefined;
      if (removalError) throw new Error('home_host_credential_removal_failed');
      this.value = { phase: 'stopped', message: 'Home 宿主进程与通道已关闭；组件停止以 Home 回执为准。' };
    })().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }
}
