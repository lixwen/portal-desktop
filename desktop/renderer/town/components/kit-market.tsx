import { useEffect, useState } from 'react';
import type { KitMarketAPI } from '../../../shared/kit-market';
import type { DesktopAPI } from '../../../shared/types';
import type { KitMarket, KitMarketInstallation, KitMarketPreview } from '../../../shared/kit-market';
import { kitMarketMessage, nativeReviewLines, permissionReviewLines } from '../../../shared/kit-review';
import './kit-market.css';
export function KitMarketPanel({ api, changed }: { api: Partial<KitMarketAPI> & Pick<DesktopAPI, 'onMarketRelease'>; changed: () => Promise<unknown> }) {
  const [markets, setMarkets] = useState<KitMarket[]>([]), [marketId, setMarket] = useState(''), [releaseId, setRelease] = useState('');
  const [profiles, setProfiles] = useState<string[]>([]), [profile, setProfile] = useState(''), [preview, setPreview] = useState<KitMarketPreview>();
  const [installed, setInstalled] = useState<KitMarketInstallation[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function refresh() { setInstalled((await api.marketInstallations?.() || []).filter(i => !i.removed)); }
  useEffect(() => api.onMarketRelease?.(() => { void api.pendingMarketRelease?.().then(selection => { if (!selection) return; if (!markets.some(m => m.id === selection.marketId)) { setError('链接中的市场尚未独立配置。'); return; } setMarket(selection.marketId); setRelease(selection.releaseId); setPreview(undefined); setProfiles([]); setProfile(''); }); }), [api, markets]);
  useEffect(() => { let active = true; void api.kitMarkets?.().then(async values => { if (active) { setMarkets(values); setMarket(values[0]?.id || ''); const pending = await api.pendingMarketRelease?.(); if (pending) { if (!values.some(m => m.id === pending.marketId)) setError('链接中的市场尚未独立配置。'); else { setMarket(pending.marketId); setRelease(pending.releaseId); } } if (values.length) await refresh(); } }).catch(e => { if (active) setError(String(e.message || e)); }); return () => { active = false; }; }, [api]);
  async function run(task: () => Promise<void>) { setBusy(true); setError(''); try { await task(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } }
  if (!markets.length && !error) return null;
  return <section className="kit-market-panel" aria-label="安装完整 Kit">
    <h3>从已配置市场安装 Kit</h3>
    <p className="field-help">市场与信任 Root 由本机独立配置。选择精确发布版本，预览后确认安装。</p>
    {error && <p role="alert">{kitMarketMessage(error)}</p>}
    <label>市场 <select aria-label="Kit 市场" value={marketId} disabled={busy} onChange={e => { setMarket(e.target.value); setPreview(undefined); setProfiles([]); }}>{markets.map(m => <option key={m.id} value={m.id}>{m.label} · 独立 Root</option>)}</select></label>
    <label>发布 UUID <input aria-label="Kit 发布 UUID" value={releaseId} disabled={busy} onChange={e => { setRelease(e.target.value.trim()); setPreview(undefined); setProfiles([]); setProfile(''); }} placeholder="精确发布 UUID" /></label>
    {profiles.length > 1 && <label>Profile <select aria-label="Kit Profile" value={profile} disabled={busy} onChange={e => { setProfile(e.target.value); setPreview(undefined); }}><option value="">选择 Profile</option>{profiles.map(p => <option key={p}>{p}</option>)}</select></label>}
    <button className="secondary" disabled={busy || !marketId || !releaseId} onClick={() => void run(async () => { const result = await api.previewMarketRelease!({ marketId, releaseId, ...(profile ? { profile } : {}) }); setProfiles(result.profiles); if ('ticket' in result) setPreview(result); })}>预览安装计划</button>
    {api.recoverMarket && <button className="text-button" disabled={busy || !marketId} onClick={() => void run(async () => { await api.recoverMarket!(marketId); await refresh(); await changed(); })}>恢复已确认的未完成安装</button>}
    {preview && <div role="region" aria-label="Kit 安装预览">
      <h4>{preview.kitId} {preview.version}</h4><p>Profile：{preview.profile} · {preview.skills} 项内容 · {preview.components.length} 个本机组件</p>
      {preview.components.map((c, i) => <div key={i}><strong>{c.name}</strong> · {({ portal_mcp: '本机 MCP', desktop_plugin_host: '原生插件', os_app: '已有 App' } as Record<string, string>)[c.executor] || c.executor} · {c.eligible ? '可用' : c.reason || '不可用'}{c.preview !== undefined && <details open><summary>SDK、能力与现有资源确认</summary><ul>{nativeReviewLines(c.preview).map(line => <li key={line}>{line}</li>)}</ul></details>}</div>)}
      <details open><summary>请求权限</summary><ul>{permissionReviewLines(preview.permissions).map(line => <li key={line}>{line}</li>)}</ul></details>
      {!preview.canInstall && <p role="alert">当前无法启用：{kitMarketMessage(preview.blockedReason || 'unknown')}</p>}
      <p className="field-help">本机组件以当前用户权限运行。确认后才开始安装；停用与卸载保留用户数据。</p>
      <button disabled={busy || !preview.canInstall} onClick={() => void run(async () => { const result = await api.confirmMarketRelease!(preview.ticket); if (result.installed) { setPreview(undefined); await refresh(); await changed(); } })}>确认安装</button>
    </div>}
    {installed.map(i => <div className="kit-actions" key={`${i.marketId}:${i.id}`}><span>{i.kitId} {i.version} · {i.pendingPhase ? '待恢复或核对' : i.enabled ? '已启用' : '已停用'} · 修订 {i.revision}</span>{([i.enabled ? 'disable' : 'enable', 'uninstall'] as const).map(action => <button className="secondary" key={action} disabled={busy || !!i.pendingPhase} onClick={() => void run(async () => { await api.manageMarketInstallation!(i.marketId, i.id, action); await refresh(); await changed(); })}>{action === 'disable' ? '停用' : action === 'enable' ? '启用' : '卸载'}</button>)}</div>)}
  </section>;
}
