import { managedDesktopSupported } from './managed-platform';
import { execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { KitMarketAPI, KitMarketPreview, KitMarketSelection } from '../../shared/kit-market';
import { privateStateParent } from './durable-file';
import { parseUniqueJson } from './json';
import { digest, reference } from './desktop-host-contract';
import { nativeReviewLines, permissionReviewLines } from '../../shared/kit-review';

export interface NativeMarketConfiguration {
  format_version: 1;
  installer: { file: string; sha256: string };
  markets: { id: string; label: string; state: string }[];
}
/** No link or renderer value can supply a file path, URL, Root, token, account,
 * installation ID, executable, or confirmation digest to this boundary. */
export async function privateJson(file: string, limit = 65536): Promise<any> {
  await privateStateParent(file); const info = await lstat(file);
  if (process.platform === 'win32') throw new Error('market_private_acl_not_verified');
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600) throw new Error('market_private_configuration_invalid');
  return parseUniqueJson(await readFile(file, 'utf8'), limit);
}
export async function runInstaller(file: string, args: string[]): Promise<any> {
  return new Promise((resolve, reject) => execFile(file, args, { timeout: 180000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
    if (error) { const code = /^[a-zA-Z0-9_ ./:-]{1,400}$/.test(stderr.trim()) ? stderr.trim() : 'kit_installer_operation_failed'; reject(new Error(code)); }
    else { try { resolve(JSON.parse(stdout)); } catch { reject(new Error('kit_installer_response_invalid')); } }
  }));
}
export class NativeKitMarkets implements Omit<KitMarketAPI, 'pendingMarketRelease'> {
  private tickets = new Map<string, { preview: KitMarketPreview; operation: string; state: string; configuration: string; context: string; expires: number }>();
  constructor(private file: string, private context: () => string, private confirm: (message: string, detail: string) => Promise<boolean>, private ensureRuntime: () => Promise<void> = async () => {}, private chooseApp: (expected?: string) => Promise<string | null> = async () => null, private choosePlugin: (id: string, digest: string) => Promise<boolean> = async () => false, private activationBlock: (plan: any) => string | undefined = () => undefined) {}
  private async configuration(): Promise<{ config: NativeMarketConfiguration; fingerprint: string }> {
    const config = await privateJson(this.file) as NativeMarketConfiguration;
    if (config?.format_version !== 1 || !path.isAbsolute(config.installer?.file || '') || !digest(config.installer?.sha256) || !Array.isArray(config.markets) || !config.markets.length || config.markets.length > 16 || new Set(config.markets.map(m => m.id)).size !== config.markets.length || config.markets.some(m => !reference(m.id) || typeof m.label !== 'string' || m.label.length > 100 || !path.isAbsolute(m.state))) throw new Error('market_configuration_invalid');
    const info = await lstat(config.installer.file); if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o022)) throw new Error('market_installer_file_invalid');
    await privateStateParent(config.installer.file);
    if (createHash('sha256').update(await readFile(config.installer.file)).digest('hex') !== config.installer.sha256) throw new Error('market_installer_changed');
    const caps = await runInstaller(config.installer.file, ['--capabilities']);
    if (caps.format_version !== 1 || caps.control_protocol !== 'kit-control-hmac-v1' || !['market.pinned-source.v1', 'host.spawn-proof.v1', ...(managedDesktopSupported() ? ['desktop.original-sdk.v1'] : [])].every(f => caps.features?.includes(f))) throw new Error('unsupported_kit_installer_feature');
    return { config, fingerprint: createHash('sha256').update(JSON.stringify(config)).digest('hex') };
  }
  async kitMarkets() {
    try { const { config } = await this.configuration(); return config.markets.map(m => ({ id: m.id, label: m.label, authority: 'operator-configured' as const })); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  async previewMarketRelease(selection: KitMarketSelection) {
    const initialContext = this.context();
    if (!selection || Object.keys(selection).some(k => !['marketId', 'releaseId', 'profile'].includes(k)) || !reference(selection.marketId) || typeof selection.releaseId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(selection.releaseId) || (selection.profile !== undefined && !reference(selection.profile))) throw new Error('market_release_selection_invalid');
    const { config, fingerprint } = await this.configuration(), market = config.markets.find(m => m.id === selection.marketId);
    if (!market) throw new Error('market_not_configured');
    const fetched = await runInstaller(config.installer.file, ['--state', market.state, 'fetch', '--market', market.id, '--release', selection.releaseId]);
    if (!Array.isArray(fetched.profiles) || !fetched.profiles.length || fetched.profiles.some((p: unknown) => !reference(p))) throw new Error('market_profiles_invalid');
    if (!selection.profile && fetched.profiles.length > 1) return { profiles: fetched.profiles as string[] };
    const profile = selection.profile || fetched.profiles[0]; if (!fetched.profiles.includes(profile)) throw new Error('market_profile_not_declared');
    await this.ensureRuntime();
    const installationId = 'market-' + createHash('sha256').update(`${market.id}\0${fetched.kit_id}`).digest('hex').slice(0, 40);
    const args = ['--state', market.state, 'plan', '--bundle', fetched.bundle, '--profile', profile, '--installation', installationId, '--request-id', randomUUID(), '--trust-user-computer'];
    let result: any;
    for (let remaining = 32; remaining > 0; remaining--) {
      try { result = await runInstaller(config.installer.file, args); break; }
      catch (error) {
        const plugin = /^desktop_plugin_explicit_reference_required:([a-zA-Z0-9_.-]{1,128}):([a-f0-9]{64})$/.exec((error as Error).message);
        if (plugin) {
          if (!await this.choosePlugin(plugin[1], plugin[2])) throw new Error('desktop_plugin_reference_cancelled');
          await runInstaller(config.installer.file, ['--state', market.state, 'select-plugin', '--plugin-id', plugin[1], '--expected-digest', plugin[2]]); continue;
        }
        const match = /^desktop_app_explicit_association_required:(component_[a-f0-9]{64}):([a-zA-Z0-9_.-]*)$/.exec((error as Error).message);
        if (!match) throw error;
        const association = await this.chooseApp(match[2] || undefined); if (!association) throw new Error('desktop_app_selection_cancelled');
        await runInstaller(config.installer.file, ['--state', market.state, 'select-app', '--component', match[1], '--association', association]);
      }
    }
    if (!result) throw new Error('desktop_app_selection_limit');
    const plan = result.plan;
    const componentRefs = (plan.install?.components || []).map((c: any) => `component_${createHash('sha256').update(JSON.stringify(c.address)).digest('hex')}`);
    const activationBlock = this.activationBlock(plan);
    const preview: KitMarketPreview = { ticket: randomUUID(), marketId: market.id, releaseId: selection.releaseId, kitId: fetched.kit_id, version: fetched.version, profile, profiles: fetched.profiles, digest: result.digest, canInstall: result.can_commit === true, blockedReason: result.execution_blocked_reason || undefined, permissions: plan.permissions || {}, components: (plan.install?.components || []).map((c: any) => ({ name: [...c.address.dependency_path, c.address.component].join(' / '), executor: c.binding?.executor || 'unavailable', eligible: c.eligible, reason: c.ineligible_reason })), skills: plan.skills.length, installationId };
    // Original SDK/capability and explicit association evidence is produced by
    // the actual native host during plan, and included in the confirmed digest.
    for (const projection of plan.desktop || []) { const component = preview.components[componentRefs.indexOf(projection.component_ref)]; if (component) component.preview = projection.preview; else preview.components.push({ name: projection.component_ref, executor: projection.request.plan.payload.executor, eligible: true, preview: projection.preview }); }
    for (const projection of plan.projections || []) if (!componentRefs.includes(projection.component_ref)) preview.components.push({ name: projection.component_ref, executor: 'portal_mcp', eligible: true });
    if (activationBlock) { preview.canInstall = false; preview.blockedReason = activationBlock; }
    if (initialContext !== this.context()) throw new Error('market_context_changed');
    this.tickets.set(preview.ticket, { preview, operation: plan.id, state: market.state, configuration: fingerprint, context: initialContext, expires: Date.now() + 10 * 60 * 1000 });
    return preview;
  }
  async confirmMarketRelease(ticket: string) {
    if (!reference(ticket)) throw new Error('market_ticket_invalid');
    const saved = this.tickets.get(ticket), { config, fingerprint } = await this.configuration();
    if (!saved || saved.expires < Date.now() || saved.context !== this.context() || saved.configuration !== fingerprint || !saved.preview.canInstall) throw new Error('market_preview_expired_or_changed');
    const p = saved.preview;
    if (!await this.confirm(`安装 ${p.kitId} ${p.version}？`, `市场：${p.marketId}（独立配置的 Root）\nProfile：${p.profile}\n${p.skills} 项内容，${p.components.length} 个本机组件\n\n${p.components.flatMap(c => [c.name, ...nativeReviewLines(c.preview)]).join('\n')}\n${permissionReviewLines(p.permissions).join('\n')}\n\n以当前用户权限运行；现有授权和数据将保留。`)) return { installed: false };
    // The native dialog is not renderer-authorized. Recheck context after it.
    if (saved.context !== this.context() || saved.configuration !== (await this.configuration()).fingerprint) throw new Error('market_context_changed');
    this.tickets.delete(ticket);
    // Reobserve signed market status after confirmation; a newer certificate
    // or status invalidates the frozen old plan rather than silently changing it.
    await runInstaller(config.installer.file, ['--state', saved.state, 'fetch', '--market', p.marketId, '--release', p.releaseId]);
    await runInstaller(config.installer.file, ['--state', saved.state, 'commit', '--operation', saved.operation, '--digest', p.digest]);
    return { installed: true, installationId: p.installationId };
  }
  async marketInstallations() {
    const { config } = await this.configuration(); const all = [];
    for (const market of config.markets) { const values = await runInstaller(config.installer.file, ['--state', market.state, 'list']);
      let operations: any[] = []; try { operations = Object.values((await privateJson(path.join(market.state, 'state.json'), 32 * 1024 * 1024)).operations); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      for (const v of Object.values(values) as any[]) {
      if (!reference(v.id) || !reference(v.active_plan)) throw new Error('market_inventory_invalid');
      const plan = await privateJson(path.join(market.state, 'operations', v.active_plan, 'plan.json'), 16 * 1024 * 1024);
      if (plan.id !== v.active_plan || plan.install?.installation_id !== v.id) throw new Error('market_inventory_invalid');
      const release = plan.bundle?.releases.find((r: any) => r.release.payload.release_id === plan.bundle.root_release_id)?.release.payload;
      if (!release?.kit_id || !release?.version) throw new Error('market_inventory_invalid');
      const pending = operations.find(o => o.installation_id === v.id && ['preparing', 'host_preparing', 'restoring', 'needs_reconciliation'].includes(o.phase));
      all.push({ marketId: market.id, id: v.id, kitId: release.kit_id, version: release.version, enabled: v.enabled, removed: v.removed, revision: v.revision, ...(pending ? { pendingPhase: pending.phase as string } : {}) });
    } }
    return all;
  }
  async recoverMarket(marketId: string) {
    if (!reference(marketId)) throw new Error('market_not_configured');
    const { config } = await this.configuration(), market = config.markets.find(m => m.id === marketId); if (!market) throw new Error('market_not_configured');
    const context = this.context();
    if (!await this.confirm('恢复未完成的 Kit 安装？', `市场：${market.label}\n只对账已确认的安装操作，保留用户改动；未确认的预览不会安装，业务写入不会自动重试。停止或数据恢复未确认时继续保留待核对状态。`)) return false;
    if (context !== this.context()) throw new Error('market_context_changed');
    await this.ensureRuntime(); await runInstaller(config.installer.file, ['--state', market.state, 'recover']); return true;
  }
  async manageMarketInstallation(marketId: string, installationId: string, action: 'enable' | 'disable' | 'uninstall') {
    if (!reference(marketId) || !reference(installationId) || !['enable', 'disable', 'uninstall'].includes(action)) throw new Error('market_management_selection_invalid');
    const { config } = await this.configuration(), market = config.markets.find(m => m.id === marketId);
    const owned = (await this.marketInstallations()).find(i => i.marketId === marketId && i.id === installationId && !i.removed);
    if (!market || !owned) throw new Error('market_owned_installation_missing');
    if (owned.pendingPhase) throw new Error('installation_recovery_required');
    const context = this.context();
    await this.ensureRuntime();
    if (action === 'enable') await runInstaller(config.installer.file, ['--state', market.state, 'refresh-owned', '--market', marketId, installationId]);
    const review = action === 'enable' ? await runInstaller(config.installer.file, ['--state', market.state, 'review-enable', installationId]) : undefined;
    if (!await this.confirm(`${{ enable: '启用', disable: '停用', uninstall: '卸载' }[action]}这个 Kit？`, `安装：${installationId}\n停用或卸载会保留用户数据和已关联的 OS App。${review ? `\n\nSDK、权限和现有资源复核：\n${review.review.desktop.flatMap(nativeReviewLines).join('\n')}\n${permissionReviewLines(review.review.permissions).join('\n')}` : ''}`)) return false;
    if (context !== this.context()) throw new Error('market_context_changed');
    await runInstaller(config.installer.file, ['--state', market.state, ...(review ? ['enable-reviewed', installationId, '--digest', review.digest] : [action, installationId])]); return true;
  }
}
