import WebSocket from 'ws';
import { createHash, randomUUID } from 'node:crypto';
import type { HomeClient } from './client';
import { parseUniqueJson } from '../kits/json';
import { protocolDigest } from '../kits/desktop-host-contract';
export interface HomeHostHello {
  protocol: 'kit-home-host-v1'; owner_id: string; profile_id: string; heart_id: string;
  heart_origin: string; heart_slug: string; target_id: string; generation: number; incarnation_id: string;
}
export interface HomeChannelContext {
  channel_id: string; owner_id: string; profile_id: string; heart_id: string; heart_origin: string;
  heart_slug: string; target_id: string; generation: number; fence: number;
}
export type HomeExecutorCommand =
  | { command: 'app_associations'; query: string | null; offset: number; limit: number }
  | { command: 'stage'; preparation: unknown }
  | { command: 'file_chunk'; operation_id: string; component_instance_id: string; file_id: string; offset: number; bytes_base64: string }
  | { command: 'prepare'; operation_id: string; component_instance_id: string }
  | { command: 'dispatch'; dispatch: unknown }
  | { command: 'stop'; host: unknown }
  | { command: 'observe_owned' | 'stop_owned'; preparation: unknown };
interface Options {
  home: HomeClient; baseUrl: string; clientId: string; hello: HomeHostHello; ca?: Buffer;
  connected?(context: HomeChannelContext): void;
  execute(command: HomeExecutorCommand, context: HomeChannelContext): Promise<unknown>;
  disconnected(context: HomeChannelContext | undefined): Promise<void>;
}
const MAX_FRAME = 16 * 1024 * 1024 + 256 * 1024;
const positive = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
const uuid = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
const keys = (v: unknown, allowed: string[]): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => allowed.includes(k));
/** Outbound native OAuth transport only. An authenticated Home DB lease/fence,
 * not an installer-provided permit or Local ledger, admits every business call.
 * Reconnect never replays commands and requires fresh Home observation. */
export class HomeExecutorChannel {
  private socket?: WebSocket; private context?: HomeChannelContext; private epoch = 0; private sequence = 0;
  private queue: Promise<void> = Promise.resolve(); private queued = 0; private timer?: ReturnType<typeof setInterval>;
  private refreshBusy = false; private tokenDigest = ''; private authentication?: { id: string; timeout: ReturnType<typeof setTimeout> };
  private stopping: Promise<void> = Promise.resolve(); private connectPromise?: Promise<HomeChannelContext>;
  constructor(private options: Options) { options.home.onSessionInvalidated(() => { void this.close().catch(() => {}); }); }
  state() { return this.context ? { ...this.context } : undefined; }
  connect(): Promise<HomeChannelContext> {
    if (this.context) return Promise.resolve({ ...this.context });
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.open().finally(() => { this.connectPromise = undefined; }); return this.connectPromise;
  }
  private session() {
    const state = this.options.home.state();
    if (!state.signedIn || state.baseUrl !== this.options.baseUrl || state.clientId !== this.options.clientId) throw new Error('home_executor_session_changed');
  }
  private async open(): Promise<HomeChannelContext> {
    await this.close(); await this.stopping; this.session(); const epoch = ++this.epoch;
    const base = new URL(this.options.baseUrl), hello = structuredClone(this.options.hello);
    if (base.href !== this.options.baseUrl || base.username || base.password || base.search || base.hash || !base.pathname.endsWith('/') ||
      !(base.protocol === 'https:' || (base.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(base.hostname))) || hello.protocol !== 'kit-home-host-v1' || !positive(hello.generation) || !uuid(hello.incarnation_id)) throw new Error('home_executor_authority_invalid');
    const url = new URL('v1/me/kit-hosts/channel', base); url.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    return this.options.home.withAccessToken(async access => {
      this.session(); if (epoch !== this.epoch || access.baseUrl !== base.href || access.clientId !== this.options.clientId) throw new Error('home_executor_session_changed');
      this.tokenDigest = createHash('sha256').update(access.accessToken).digest('hex');
      return new Promise<HomeChannelContext>((resolve, reject) => {
        const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${access.accessToken}` }, ca: this.options.ca, rejectUnauthorized: true,
          handshakeTimeout: 10000, maxPayload: MAX_FRAME, followRedirects: false, perMessageDeflate: false });
        this.socket = socket; this.sequence = 0; let welcomed = false;
        const timeout = setTimeout(() => fail(), 12000);
        const fail = () => { clearTimeout(timeout); if (!welcomed) reject(new Error('home_executor_channel_unavailable')); void this.disconnect(socket).catch(() => {}); };
        socket.on('unexpected-response', (_request, response) => { response.resume(); fail(); });
        socket.on('error', fail); socket.on('close', fail);
        socket.on('open', () => { try { this.session(); if (epoch !== this.epoch) throw new Error('stale'); this.send({ type: 'hello', hello }); } catch { fail(); } });
        socket.on('message', (bytes, binary) => {
          try {
            this.session(); if (binary || bytes.length > MAX_FRAME || epoch !== this.epoch || this.socket !== socket) throw new Error('home_executor_frame_invalid');
            const message = parseUniqueJson(bytes.toString('utf8'), MAX_FRAME) as any;
            if (!welcomed) {
              if (!keys(message, ['type', 'context']) || message.type !== 'welcome' || !this.matches(message.context, hello)) throw new Error('home_executor_context_invalid');
              this.options.connected?.(message.context); welcomed = true; clearTimeout(timeout); this.context = structuredClone(message.context); resolve({ ...this.context! });
              this.timer = setInterval(() => { if (this.refreshBusy) return; this.refreshBusy = true; void this.refresh(epoch).catch(fail).finally(() => { this.refreshBusy = false; }); }, 20000); this.timer.unref?.(); return;
            }
            if (keys(message, ['type', 'nonce']) && message.type === 'ping' && uuid(message.nonce)) { this.send({ type: 'pong', nonce: message.nonce }); return; }
            if (keys(message, ['type', 'request_id']) && message.type === 'authenticated' && this.authentication && message.request_id === this.authentication.id) { clearTimeout(this.authentication.timeout); this.authentication = undefined; return; }
            if (!keys(message, ['type', 'sequence', 'request_id', 'command']) || message.type !== 'command' || !positive(message.sequence) || message.sequence !== this.sequence + 1 || !uuid(message.request_id) || !this.command(message.command) || ++this.queued > 16) throw new Error('home_executor_command_invalid');
            this.sequence = message.sequence;
            const context = this.context!, sequence = message.sequence, requestId = message.request_id, command = message.command as HomeExecutorCommand;
            const task = this.queue.then(async () => {
              this.session(); if (epoch !== this.epoch || this.socket !== socket || protocolDigest(this.context) !== protocolDigest(context)) return;
              let outcome;
              try { outcome = { status: 'completed', result: await this.options.execute(command, context) }; }
              catch (error) { const code = error instanceof Error && /^[a-z][a-z0-9_]{0,119}$/.test(error.message) ? error.message : 'home_executor_command_rejected'; outcome = { status: 'rejected', code }; }
              if (epoch === this.epoch && this.socket === socket) this.send({ type: 'reply', sequence, request_id: requestId, outcome });
            });
            this.queue = task.catch(fail).finally(() => { this.queued--; });
          } catch { fail(); }
        });
      });
    });
  }
  private matches(value: any, hello: HomeHostHello): value is HomeChannelContext {
    return keys(value, ['channel_id', 'owner_id', 'profile_id', 'heart_id', 'heart_origin', 'heart_slug', 'target_id', 'generation', 'fence']) && uuid(value.channel_id) && positive(value.fence) && positive(value.generation) &&
      ['owner_id', 'profile_id', 'heart_id', 'heart_origin', 'heart_slug', 'target_id', 'generation'].every(key => value[key] === hello[key as keyof HomeHostHello]);
  }
  private command(value: any): value is HomeExecutorCommand {
    switch (value?.command) {
      case 'app_associations': return keys(value, ['command', 'query', 'offset', 'limit']) && (value.query === null || (typeof value.query === 'string' && Buffer.byteLength(value.query) <= 256 && !/[\x00-\x1f]/.test(value.query))) && Number.isSafeInteger(value.offset) && value.offset >= 0 && value.offset <= 4096 && Number.isSafeInteger(value.limit) && value.limit > 0 && value.limit <= 100;
      case 'stage': case 'observe_owned': case 'stop_owned': return keys(value, ['command', 'preparation']) && !!value.preparation;
      case 'prepare': return keys(value, ['command', 'operation_id', 'component_instance_id']) && typeof value.operation_id === 'string' && typeof value.component_instance_id === 'string';
      case 'file_chunk': return keys(value, ['command', 'operation_id', 'component_instance_id', 'file_id', 'offset', 'bytes_base64']) && typeof value.operation_id === 'string' && typeof value.component_instance_id === 'string' && typeof value.file_id === 'string' && Number.isSafeInteger(value.offset) && value.offset >= 0 && typeof value.bytes_base64 === 'string' && value.bytes_base64.length <= 87384;
      case 'dispatch': return keys(value, ['command', 'dispatch']) && !!value.dispatch;
      case 'stop': return keys(value, ['command', 'host']) && !!value.host;
      default: return false;
    }
  }
  private send(message: unknown) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('home_executor_channel_closed');
    const text = JSON.stringify(message); if (Buffer.byteLength(text) > MAX_FRAME) throw new Error('home_executor_result_too_large'); this.socket.send(text, error => { if (error) void this.close().catch(() => {}); });
  }
  private async refresh(epoch: number) {
    this.session(); await this.options.home.withAccessToken(async access => {
      if (epoch !== this.epoch || access.baseUrl !== this.options.baseUrl || access.clientId !== this.options.clientId) throw new Error('home_executor_session_changed');
      const digest = createHash('sha256').update(access.accessToken).digest('hex'); if (digest === this.tokenDigest) return;
      if (this.authentication) throw new Error('home_executor_reauthentication_pending');
      const id = randomUUID(), timeout = setTimeout(() => { void this.close().catch(() => {}); }, 10000); this.authentication = { id, timeout };
      this.send({ type: 'reauthenticate', request_id: id, access_token: access.accessToken }); this.tokenDigest = digest;
    });
  }
  private disconnect(socket: WebSocket) {
    if (this.socket !== socket) return this.stopping;
    this.epoch++; this.socket = undefined; const context = this.context; this.context = undefined;
    if (this.timer) clearInterval(this.timer); this.timer = undefined;
    if (this.authentication) clearTimeout(this.authentication.timeout); this.authentication = undefined; this.tokenDigest = '';
    socket.terminate(); this.stopping = this.stopping.then(() => this.options.disconnected(context)); return this.stopping;
  }
  close() { return this.socket ? this.disconnect(this.socket) : this.stopping; }
}
