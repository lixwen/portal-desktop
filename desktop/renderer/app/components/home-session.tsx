import { useEffect, useState } from 'react';
import type { DesktopAPI } from '../../../shared/types';
import type { HomeMe, HomeState } from '../../../shared/home';
import type { HomeKitHostState } from '../../../shared/home-kit';
/** Home login stays visibly independent from the existing Heart connection. */
export function HomeSessionSettings({ api }: { api: DesktopAPI }) {
  const [state, setState] = useState<HomeState>(), [owner, setOwner] = useState<HomeMe>(), [baseUrl, setBase] = useState(''), [clientId, setClient] = useState('');
  const [host, setHost] = useState<HomeKitHostState>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  async function refresh() { const value = await api.home!.state(); setState(value); setBase(value.baseUrl); setClient(value.clientId); setOwner(value.signedIn ? await api.home!.me() : undefined); if (api.homeKitHostState) setHost(await api.homeKitHostState()); }
  useEffect(() => { if (!api.home) return; void refresh().catch(e => setError(String(e.message || e))); }, [api]);
  useEffect(() => { if (!api.homeKitHostState || !state?.signedIn) return; const timer = setInterval(() => { void api.homeKitHostState!().then(setHost).catch(() => {}); }, 3000); return () => clearInterval(timer); }, [api, state?.signedIn]);
  async function run(task: () => Promise<unknown>) { setBusy(true); setError(''); setNotice(''); try { await task(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { try { await refresh(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } setBusy(false); } }
  if (!api.home) return null;
  return <section aria-label="独立 Home 登录" className="home-session-settings">
    <h3>Home · 独立账号</h3><p className="field-help">Home 登录通过系统浏览器授权。现有 Heart 连接不会自动授予 Home 资源权限，纯本机 Kit 可独立使用。</p>
    {error && <p role="alert">{error}</p>}{state?.warning && <p role="alert">{state.warning}</p>}{notice && <p role="status">{notice}</p>}
    <label>Home 地址 <input aria-label="Home 地址" value={baseUrl} disabled={busy || state?.signedIn || state?.loginPending} onChange={e => setBase(e.target.value)} /></label>
    <label>原生客户端 ID <input aria-label="Home 客户端 ID" value={clientId} disabled={busy || state?.signedIn || state?.loginPending} onChange={e => setClient(e.target.value)} /></label>
    {!state?.signedIn ? <>
      <button type="button" disabled={busy || state?.loginPending || !baseUrl || !clientId} onClick={() => { setState(s => s ? { ...s, loginPending: true } : s); void run(async () => { if (baseUrl !== state?.baseUrl || clientId !== state?.clientId) await api.home!.configure({ baseUrl, clientId }); await api.home!.login(); }); }}>在浏览器登录 Home</button>
      {(busy || state?.loginPending) && <button type="button" onClick={() => void api.home!.cancelLogin()}>取消 Home 登录</button>}
    </> : <>
      <p>已登录：{owner?.username || owner?.user.id || '正在核对账号'}</p>
      {api.openHomePortal && <button type="button" disabled={busy} onClick={() => void run(() => api.openHomePortal!())}>打开 Home 管理</button>}
      <button type="button" disabled={busy} onClick={() => void run(() => api.home!.logout())}>退出 Home</button>
      {owner && !owner.being && <button type="button" disabled={busy} onClick={() => void run(() => api.home!.bootstrap())}>初始化 Home 空间</button>}
      {api.startHomeKitHost && <div className="kit-actions">
        <p role="status">{host?.message || 'Home 本机宿主尚未启用。'}{host?.generation ? ` · generation ${host.generation}` : ''}</p>
        <button type="button" disabled={busy || !owner?.being || ['starting', 'stopping'].includes(host?.phase || '') || (host?.phase === 'running' && host.connectedNativeExecutors === 2)} onClick={() => void run(() => api.startHomeKitHost!())}>{host?.phase === 'running' ? '重新连接 Home 执行器' : '启用 Home 本机宿主'}</button>
        <button type="button" className="secondary" disabled={busy || !host || ['stopped', 'unconfigured'].includes(host.phase)} onClick={() => void run(() => api.stopHomeKitHost!())}>停止 Home 本机宿主</button>
      </div>}

    </>}
  </section>;
}
