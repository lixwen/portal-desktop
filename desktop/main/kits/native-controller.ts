import { parseUniqueJson } from './json';
import { SecureControlChannel, type ControlContext } from './control-channel';
import { createConnection, type Socket } from 'node:net';

export interface NativeTool {
  resource_ref: string; native_name: string; remote_tool: string; source_digest: string;
  input_schema: Record<string, unknown>;
}
export interface ExecutionBinding {
  owner_id: string; heart_id: string; installation_id: string; installation_revision: number;
  component_id: string; release_id: string; closure_digest: string; capability_id: string;
  runtime: 'local' | 'shared' | 'cloud'; target_id: string; target_generation: number; remote_tool: string;
  effect: { kind: 'read_only' } | { kind: 'write'; operation_scope: string };
  accounts: Record<string, { connection_id: string; generation: number; resource_scope: string }>;
  workspace_ref: string | null; browser_session_ref: string | null;
  policy_epoch: number; schema_digest: string; expires_at_unix_seconds: number;
}
export interface NativeRegistration {
  expected_revision: number; installation_id: string;
  resources: { owner_id: string; heart_id: string; installation_id: string; component_id: string;
    authority: 'local' | 'home'; target_id: string; native_resource_ref: string; enabled: boolean;
    entries: Record<string, ExecutionBinding>; retired_names: string[] }[];
  records: { tool: { name: string; description: string; inputSchema: Record<string, unknown> }; binding: ExecutionBinding }[];
}
export interface McpNativeResult { content: { type: 'text'; text: string }[]; isError?: boolean }
export type NativeAdmission = { state: 'dispatch'; record_id: string } | { state: 'existing'; result: McpNativeResult };
/** Private main-process connection, separate from MCP/model authentication.
 * Never pass its token or methods through a renderer/plugin preload. A single
 * connection retains the Rust dispatch permit until completion. No reconnect or
 * automatic replay: disconnection is an unknown result after dispatch. */
export class NativeKitController {
  private nextId = 0;
  private buffer = '';
  private secure?: SecureControlChannel;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private constructor(private socket: Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (data: string) => {
      this.buffer += data;
      if (Buffer.byteLength(this.buffer) > 6 * 1024 * 1024) { this.socket.destroy(new Error('kit_controller_response_limit')); return; }
      for (;;) {
        const newline = this.buffer.indexOf('\n'); if (newline < 0) break;
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        let response: any;
        try { response = parseUniqueJson(line, 6 * 1024 * 1024); if (this.secure) response = this.secure.decode(response); } catch { this.socket.destroy(new Error('kit_controller_invalid_response')); return; }
        const pending = this.pending.get(response.id);
        if (!pending) continue;
        this.pending.delete(response.id); clearTimeout(pending.timer);
        if (response.error) { const detail = response.error.message; pending.reject(new Error(typeof detail === 'string' && /^[a-z0-9_.:-]{1,160}$/.test(detail) ? `kit_controller_request_rejected:${detail}` : 'kit_controller_request_rejected')); }
        else if (!Object.hasOwn(response, 'result')) pending.reject(new Error('kit_controller_invalid_response'));
        else pending.resolve(response.result);
      }
    });
    const failed = () => {
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error('kit_controller_disconnected')); }
      this.pending.clear();
    };
    socket.on('error', failed); socket.on('close', failed);
  }
  static async connect(port: number, token: string, scope: ControlContext, role: 'kit-controller' | 'kit-consumer' = 'kit-controller') {
    if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof token !== 'string' || Buffer.byteLength(token) < 32) throw new Error('invalid_kit_controller_configuration');
    const socket = createConnection({ host: '127.0.0.1', port });
    const controller = new NativeKitController(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('kit_controller_connect_timeout')); }, 5000);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.once('error', () => { clearTimeout(timer); reject(new Error('kit_controller_connect_failed')); });
    });
    try {
      const hello = SecureControlChannel.hello(scope);
      const challenge = await controller.request('auth', { role, ...hello });
      const authenticated = SecureControlChannel.authenticate(token, scope, hello.client_nonce, challenge);
      controller.secure = authenticated.channel;
      const accepted = await controller.request<{ authenticated: boolean }>('auth/finish', authenticated.finish, true);
      if (accepted?.authenticated !== true) throw new Error('control_client_authentication_failed');
      return controller;
    }
    catch (e) { controller.close(); throw e; }
  }
  request<T>(method: string, params: unknown, plain = false): Promise<T> {
    if (this.socket.destroyed) return Promise.reject(new Error('kit_controller_disconnected'));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('kit_controller_timeout')); this.socket.destroy(); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      const request = { jsonrpc: '2.0', id, method, params };
      let line: string;
      try { line = JSON.stringify(this.secure && !plain ? this.secure.encode(request) : request) + '\n'; }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('kit_controller_request_invalid')); return; }
      if (Buffer.byteLength(line) > 6 * 1024 * 1024) { clearTimeout(timer); this.pending.delete(id); reject(new Error('kit_controller_request_limit')); return; }
      this.socket.write(line, error => { if (error) this.socket.destroy(); });
    });
  }
  register(registration: NativeRegistration, observed: NativeTool[]) { return this.request('kit/native/register', { registration, observed }); }
  begin(source: NativeTool, sessionId: string, rpcId: number | string, args: Record<string, unknown>, alias?: string): Promise<NativeAdmission> {
    return this.request('kit/native/begin', { source, session_id: sessionId, rpc_id: rpcId, arguments: args, ...(alias ? { alias } : {}) });
  }
  async complete(recordId: string, result: McpNativeResult | null) {
    const receipt = await this.request<{ record_id: string; persisted: boolean }>('kit/native/complete', { record_id: recordId, result });
    if (receipt.record_id !== recordId || receipt.persisted !== true) throw new Error('kit_controller_completion_unconfirmed');
  }
  close() { this.socket.destroy(); }
  /** Establish a connection for the next operation, never replay an operation
   * after failure. Admission completion stays on the same live connection. */
  static lazy(port: number, token: string, scope: ControlContext): Pick<NativeKitController, 'request' | 'register' | 'begin' | 'complete' | 'close'> {
    let current: NativeKitController | undefined, connecting: Promise<NativeKitController> | undefined;
    const connection = async () => {
      if (current && !current.socket.destroyed) return current;
      if (!connecting) connecting = NativeKitController.connect(port, token, scope).then(value => { current = value; return value; }).finally(() => { connecting = undefined; });
      return connecting;
    };
    const request = async <T>(method: string, params: unknown) => (await connection()).request<T>(method, params);
    return { request, register: (registration, observed) => request('kit/native/register', { registration, observed }), begin: (source, sessionId, rpcId, args, alias) => request('kit/native/begin', { source, session_id: sessionId, rpc_id: rpcId, arguments: args, ...(alias ? { alias } : {}) }),
      complete: async (recordId, result) => { if (!current || current.socket.destroyed) throw new Error('kit_controller_disconnected'); await current.complete(recordId, result); }, close: () => { current?.close(); current = undefined; } };
  }
}
