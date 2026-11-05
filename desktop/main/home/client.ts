import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { durablePrivateJson, privateStateParent } from '../kits/durable-file';
import path from 'node:path';
import type { SecretStorage } from '../app/settings';
import type { HomeConfig, HomeState } from '../../shared/home';

const REDIRECT = 'http://127.0.0.1:47831/oauth/callback';
const SCOPES = 'openid offline_access being:read being:write account:write files:read files:write computer:read computer:write computer:connect';
interface Tokens { access_token: string; refresh_token?: string; expires_at: number }
interface Discovery { client_id: string; redirect_uris: string[]; authorization_endpoint: string; token_endpoint: string; revocation_endpoint: string; audience: string; features?: string[] }
export class HomeError extends Error {
  constructor(public status: number, public code: string) { super(`Home：${code}（${status}）`); }
}

function normalize(config: HomeConfig): HomeConfig {
  const url = new URL(config.baseUrl);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error('Home 地址须为 HTTPS 或本机回环 HTTP，且不含账号、查询或片段。');
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(config.clientId)) throw new Error('请输入有效的 Home 客户端标识。');
  url.pathname = url.pathname.replace(/\/+$/, '') + '/';
  return { baseUrl: url.href, clientId: config.clientId };
}

function validTokens(value: Tokens): boolean {
  return value && typeof value.access_token === 'string' && /^[\x21-\x7e]{1,16384}$/.test(value.access_token) &&
    (value.refresh_token === undefined || typeof value.refresh_token === 'string' && /^[\x21-\x7e]{1,16384}$/.test(value.refresh_token)) &&
    Number.isSafeInteger(value.expires_at) && value.expires_at > 0;
}
async function boundedJson(response: Response, limit: number): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw new Error('Home 返回了空响应。');
  const chunks: Uint8Array[] = []; let length = 0;
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; length += value.length; if (length > limit) throw new Error('Home 响应超过大小限制。'); chunks.push(value); } }
  finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export class HomeClient {
  private config: HomeConfig = normalize({ baseUrl: process.env.PORTAL_DESKTOP_HOME_URL || 'https://dev.beings.town/being-home/', clientId: process.env.PORTAL_DESKTOP_HOME_CLIENT_ID || 'being-desktop' });
  private tokens?: Tokens;
  private discovered?: Discovery;
  private refreshing?: Promise<void>;
  private pending?: { cancel: () => void };
  private generation = 0;
  private warning?: string;
  private invalidations = new Set<() => void>();
  onSessionInvalidated(listener: () => void) { this.invalidations.add(listener); return () => { this.invalidations.delete(listener); }; }
  private invalidate() { this.generation++; for (const listener of this.invalidations) { try { listener(); } catch { /* A disconnected consumer cannot retain session authority. */ } } }
  constructor(private directory: string, private storage: SecretStorage, private open: (url: string) => Promise<void>) {}
  state(): HomeState { return { ...this.config, signedIn: Boolean(this.tokens), loginPending: Boolean(this.pending), warning: this.warning }; }
  private sessionFile() { return path.join(this.directory, 'home-session.json'); }
  async load() {
    try {
      if (process.platform === 'win32') throw new Error('home_private_acl_unavailable');
      const file = this.sessionFile(); await privateStateParent(file);
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let saved;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 65536) throw new Error('home_session_not_private');
        saved = JSON.parse(await handle.readFile('utf8'));
      } finally { await handle.close(); }
      const config = normalize(saved.config);
      let tokens: Tokens | undefined;
      if (saved.credential) {
        if (saved.formatVersion !== 2 || !this.storage.isEncryptionAvailable() || typeof saved.credential !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(saved.credential)) throw new Error('home_session_migration_required');
        const secret = JSON.parse(this.storage.decryptString(Buffer.from(saved.credential, 'base64')));
        if (secret.authority?.baseUrl !== config.baseUrl || secret.authority?.clientId !== config.clientId || !validTokens(secret.tokens)) throw new Error('home_session_authority_mismatch');
        tokens = secret.tokens;
      }
      this.config = config; this.tokens = tokens;
    } catch (error) {
      this.tokens = undefined;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.warning = 'Home 会话读取失败或需要安全迁移，请退出 Home 后重新登录。';
    }
  }
  private async persist(tokens = this.tokens, epoch = this.generation) {
    if (process.platform === 'win32') throw new Error('Home 私有会话的 Windows ACL 尚未支持。');
    if (tokens && !this.storage.isEncryptionAvailable()) throw new Error('系统密钥库不可用，无法保存 Home 会话。');
    const config = { ...this.config };
    await durablePrivateJson(this.sessionFile(), { formatVersion: 2, config, credential: tokens ? this.storage.encryptString(JSON.stringify({ authority: config, tokens })).toString('base64') : undefined }, () => {
      if (epoch !== this.generation) throw new Error('Home 会话已切换。');
    });
  }
  async configure(config: HomeConfig) {
    if (this.tokens || this.pending) throw new Error('请先退出 Home 或取消登录，再修改服务器。');
    this.invalidate(); this.config = normalize(config); this.discovered = undefined; this.warning = undefined;
    await this.persist(); return this.state();
  }
  private url(relative: string) {
    if (typeof relative !== 'string' || !relative.startsWith('/') || relative.startsWith('//') || /[\\\r\n#]/.test(relative)) throw new Error('invalid_home_relative_path');
    const base = new URL(this.config.baseUrl); const url = new URL(relative.slice(1), base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || /(?:^|\/)(?:%2e|%2f|%5c)/i.test(relative)) throw new Error('invalid_home_relative_path');
    return url.href;
  }
  private endpoint(value: string) {
    const url = new URL(value, new URL(this.config.baseUrl).origin);
    const base = new URL(this.config.baseUrl);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.username || url.password || url.hash || url.search) throw new Error('Home 返回了无效的 OAuth 地址。');
    return url.href;
  }
  private async response(url: string, init?: RequestInit) {
    let response: Response;
    if (process.env.NODE_USE_ENV_PROXY === '1') throw new Error('Home 原生会话不支持环境代理，请使用直接连接。');
    try { response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
    catch { throw new Error('无法连接 Home，请检查服务器地址和网络后重试。'); }
    if (!response.ok) {
      const error = await boundedJson(response, 16384).catch(() => null) as { error?: unknown } | null;
      // Never relay upstream bodies, OAuth descriptions, URLs or credentials to logs.
      const code = typeof error?.error === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(error.error) ? error.error : 'request_failed';
      throw new HomeError(response.status, code);
    }
    return response;
  }
  private async discovery() {
    if (!this.discovered) {
      const epoch = this.generation;
      const data = await boundedJson(await this.response(this.url(`/native/client-config/${encodeURIComponent(this.config.clientId)}`)), 65536) as Discovery;
      if (data.client_id !== this.config.clientId || !Array.isArray(data.redirect_uris) || data.redirect_uris.length > 32 || !data.redirect_uris.includes(REDIRECT) || data.audience !== 'urn:being:home') throw new Error(`Home 尚未登记此客户端的回调 ${REDIRECT}，请按对接文档配置服务端。`);
      this.endpoint(data.token_endpoint); this.endpoint(data.revocation_endpoint);
      const auth = new URL(data.authorization_endpoint);
      if ((auth.protocol !== 'https:' && !(auth.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(auth.hostname))) || auth.username || auth.password || auth.hash || auth.search) throw new Error('Home 返回了无效的授权入口。');
      if (data.features !== undefined && (!Array.isArray(data.features) || data.features.length > 64 || data.features.some(value => typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 128 || /[\x00-\x1f\x7f]/.test(value)))) throw new Error('invalid_home_native_features');
      if (epoch !== this.generation) throw new Error('home_native_context_changed');
      this.discovered = data;
    }
    return this.discovered;
  }
  /** Main-only software negotiation from the fixed configured Home discovery.
   * Never accept capability support from a renderer, package or installation URL. */
  async nativeFeatures(): Promise<readonly string[]> { return [...((await this.discovery()).features || [])]; }
  private async token(form: URLSearchParams, epoch: number) {
    const config = await this.discovery();
    form.set('client_id', this.config.clientId);
    // Node fetch is intentionally independent of Electron's browser Cookie jar.
    const response = await this.response(this.endpoint(config.token_endpoint), { method: 'POST', body: form });
    const data = await boundedJson(response, 65536).catch(() => { throw new Error('Home 返回了无效的登录结果。'); }) as { access_token: string; refresh_token?: string; expires_in: number; token_type: string };
    if (epoch !== this.generation) {
      // Cancellation can race a successful exchange. Revoke any newly issued
      // credentials instead of keeping an unseen session alive remotely.
      let revokeFailed = false;
      for (const [hint, token] of [['access_token', data?.access_token], ['refresh_token', data?.refresh_token]]) {
        if (!token) continue;
        try { await this.response(this.endpoint(config.revocation_endpoint), { method: 'POST', body: new URLSearchParams({ client_id: config.client_id, token, token_type_hint: hint! }) }); }
        catch { revokeFailed = true; }
      }
      if (revokeFailed) this.warning = '登录已取消；刚签发凭据的远端撤销未确认，请联系管理员检查。';
      throw new Error(revokeFailed ? this.warning : 'Home 会话已切换，请重新操作。');
    }
    const previous = this.tokens;
    const next = { access_token: data.access_token, refresh_token: data.refresh_token || previous?.refresh_token, expires_at: Date.now() + data.expires_in * 1000 };
    if (data.token_type?.toLowerCase() !== 'bearer' || !Number.isSafeInteger(data.expires_in) || data.expires_in <= 0 || data.expires_in > 31 * 86400 || !validTokens(next)) throw new Error('Home 返回了无效的登录结果。');
    try {
      await this.persist(next, epoch);
      if (epoch !== this.generation) throw new Error('Home 会话已切换。');
      this.tokens = next;
    } catch (error) {
      // Never retain a remotely issued session that could not be durably owned.
      for (const [hint, value] of [['access_token', data.access_token], ['refresh_token', data.refresh_token]]) {
        if (!value) continue;
        try { await this.response(this.endpoint(config.revocation_endpoint), { method: 'POST', body: new URLSearchParams({ client_id: config.client_id, token: value, token_type_hint: hint! }) }); }
        catch { this.warning = 'Home 会话未保存；远端撤销未确认，请重新登录前检查。'; }
      }
      throw error;
    }
    this.warning = undefined;
  }
  async login() {
    if (this.pending || this.tokens) throw new Error('Home 已登录或正在登录。');
    if (!this.storage.isEncryptionAvailable()) throw new Error('系统密钥库当前不可用，暂时无法登录 Home。请检查密钥库或使用已签名客户端后重试。');
    this.invalidate();
    const epoch = this.generation;
    // Reserve the login before discovery so simultaneous clicks cannot start two flows.
    let cancelled = false;
    this.pending = { cancel: () => { cancelled = true; } };
    try {
      const config = await this.discovery();
      if (cancelled) throw new Error('已取消 Home 登录。');
      const state = randomBytes(32).toString('base64url');
      const verifier = randomBytes(48).toString('base64url');
      const code = await new Promise<string>((resolve, reject) => {
        let settled = false;
        const server = createServer((request, response) => {
          response.setHeader('Cache-Control', 'no-store');
          response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
          response.setHeader('Referrer-Policy', 'no-referrer');
          let callback: URL;
          try {
            if (request.headers.host !== '127.0.0.1:47831' || request.headers.origin !== undefined || !request.url?.startsWith('/oauth/callback?') || request.url.length > 8192) throw new Error('invalid_callback');
            callback = new URL(request.url, REDIRECT);
          }
          catch { response.writeHead(400); response.end('Invalid login callback.'); return; }
          if (request.method !== 'GET' || callback.origin !== new URL(REDIRECT).origin || callback.pathname !== '/oauth/callback' || callback.searchParams.getAll('state').length !== 1 || callback.searchParams.get('state') !== state) {
            response.writeHead(400); response.end('Invalid login callback.'); return;
          }
          const value = callback.searchParams.get('code');
          response.setHeader('Content-Type', 'text/plain; charset=utf-8');
          response.end('已收到 Home 登录结果，请返回 Portal Desktop。');
          finish(value && callback.searchParams.getAll('code').length === 1 && !callback.searchParams.has('error') ? undefined : new Error('Home 登录未完成或授权被拒绝。'), value || '');
        });
        const finish = (error?: Error, value = '') => { if (settled) return; settled = true; clearTimeout(timer); server.close(); server.closeIdleConnections(); if (error) reject(error); else resolve(value); };
        const timer = setTimeout(() => finish(new Error('Home 登录已超时，请重新登录。')), 5 * 60_000);
        this.pending = { cancel: () => finish(new Error('已取消 Home 登录。')) };
        server.requestTimeout = 10000; server.headersTimeout = 10000; server.keepAliveTimeout = 1000; server.maxHeadersCount = 16; server.maxRequestsPerSocket = 1;
        server.once('error', () => finish(new Error('无法监听 Home 登录回调端口 47831，请关闭占用该端口的程序后重试。')));
        server.listen(47831, '127.0.0.1', () => {
          const url = new URL(config.authorization_endpoint);
          for (const [key, value] of Object.entries({ response_type: 'code', client_id: config.client_id, redirect_uri: REDIRECT, scope: SCOPES, audience: config.audience, state, nonce: randomBytes(32).toString('base64url'), code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), prompt: 'login' })) url.searchParams.set(key, value);
          void this.open(url.href).catch(() => finish(new Error('无法打开系统浏览器，请检查默认浏览器设置。')));
        });
      });
      await this.token(new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT }), epoch);
    } finally { this.pending = undefined; }
  }
  cancelLogin() { this.invalidate(); this.pending?.cancel(); }
  private async access() {
    if (this.refreshing) await this.refreshing;
    if (!this.tokens) throw new Error('请先登录 Home。');
    if (this.tokens.expires_at <= Date.now() + 30_000) {
      const token = this.tokens.refresh_token;
      if (!token) throw new Error('Home 登录已过期，请退出后重新登录。');
      const epoch = this.generation;
      this.refreshing = this.token(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token }), epoch);
      try { await this.refreshing; } finally { this.refreshing = undefined; }
    }
    if (!this.tokens) throw new Error('Home 会话已退出。');
    return this.tokens.access_token;
  }
  async request<T>(relative: string, method = 'GET', body?: unknown, headers?: Record<string, string>): Promise<T> {
    const response = await this.raw(relative, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' } });
    return (response.status === 204 ? undefined : await boundedJson(response, 8 * 1024 * 1024)) as T;
  }
  async raw(relative: string, init?: RequestInit) {
    const epoch = this.generation;
    const token = await this.access();
    if (epoch !== this.generation) throw new Error('Home 会话已切换。');
    const headers = new Headers(init?.headers);
    for (const key of ['cookie', 'origin', 'authorization', 'proxy-authorization']) if (headers.has(key)) throw new Error('invalid_native_home_header');
    headers.set('Authorization', `Bearer ${token}`);
    const response = await this.response(this.url(relative), { ...init, headers });
    if (epoch !== this.generation) throw new Error('Home 会话已切换。');
    return response;
  }
  async logout() {
    this.cancelLogin();
    await this.refreshing?.catch(() => {});
    const tokens = this.tokens;
    let revokeFailed = false;
    try {
      if (tokens) {
        const config = await this.discovery();
        for (const [hint, token] of [['access_token', tokens.access_token], ['refresh_token', tokens.refresh_token]]) {
          if (!token) continue;
          try { await this.response(this.endpoint(config.revocation_endpoint), { method: 'POST', body: new URLSearchParams({ client_id: this.config.clientId, token, token_type_hint: hint! }) }); }
          catch { revokeFailed = true; }
        }
      }
    } catch { revokeFailed = true; }
    finally {
      this.tokens = undefined; this.discovered = undefined; this.warning = undefined;
      await this.persist();
    }
    if (revokeFailed) throw new Error('本机 Home 会话已清除；远端撤销未确认，请联系管理员检查。');
  }
  async withAccessToken<T>(operation: (session: { accessToken: string; baseUrl: string; clientId: string }) => Promise<T>): Promise<T> {
    const epoch = this.generation; const accessToken = await this.access();
    if (epoch !== this.generation) throw new Error('Home 会话已切换。');
    const result = await operation({ accessToken, baseUrl: this.config.baseUrl, clientId: this.config.clientId });
    if (epoch !== this.generation) throw new Error('Home 会话已切换。');
    return result;
  }
  async openComputer() {
    const ticket = await this.request<{ connect_url: string }>('/v1/me/computer/desktop-ticket', 'POST', {});
    const base = new URL(this.config.baseUrl); const destination = new URL(ticket.connect_url, base.origin);
    if (destination.origin !== base.origin || destination.username || destination.password || destination.hash || destination.pathname !== new URL('desktop/connect', base).pathname || destination.searchParams.size !== 1 || destination.searchParams.getAll('ticket').length !== 1 || !/^[a-f0-9]{64}$/.test(destination.searchParams.get('ticket') || '')) throw new Error('Home 返回了无效的电脑连接地址。');
    await this.open(destination.href);
  }
}
