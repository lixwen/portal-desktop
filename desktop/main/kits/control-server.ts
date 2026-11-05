import { parseUniqueJson } from './json';
import { createServer, type Server, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { SecureControlChannel, type ControlContext } from './control-channel';
export interface DesktopControlTarget {
  context: ControlContext;
  controllerToken: string;
  consumerToken?: string;
}
export interface DesktopControlPeer { context: ControlContext; role: 'kit-controller' | 'kit-consumer'; channelId: string; rpcId: number | string }
/** Native main-process control only. No HTTP or unauthenticated business path. */
export class DesktopControlServer {
  private server?: Server;
  private sockets = new Set<Socket>();
  constructor(private targets: DesktopControlTarget[], private dispatch: (peer: DesktopControlPeer, method: string, params: unknown) => Promise<unknown>) {}
  async listen(port: number) {
    const server = createServer(socket => this.connection(socket)); this.server = server;
    await new Promise<void>((resolve, reject) => { server.once('error', () => reject(new Error('desktop_control_bind_failed'))); server.listen(port, '127.0.0.1', resolve); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('desktop_control_bind_failed'); return address.port;
  }
  private connection(socket: Socket) {
    if (this.sockets.size >= 8) { socket.destroy(); return; }
    this.sockets.add(socket); socket.setEncoding('utf8'); socket.setTimeout(35000, () => socket.destroy());
    const channelId = randomUUID();
    let queued = 0;
    let buffer = '', secure: SecureControlChannel | undefined, pending: ReturnType<typeof SecureControlChannel.server> | undefined;
    let target: DesktopControlTarget | undefined, role: DesktopControlPeer['role'] | undefined, queue = Promise.resolve();
    const send = (value: unknown) => { if (!socket.destroyed) socket.write(JSON.stringify(secure ? secure.encode(value) : value) + '\n'); };
    const request = async (line: string) => {
      try {
        let raw: any = parseUniqueJson(line, 6 * 1024 * 1024);
        if (secure) raw = secure.decode(raw);
        if (!raw || raw.jsonrpc !== '2.0' || !(typeof raw.id === 'string' || (Number.isSafeInteger(raw.id) && raw.id >= 0)) || typeof raw.method !== 'string') throw new Error('invalid_control_request');
        if (!secure) {
          if (raw.method === 'auth' && !pending) {
            const params = raw.params;
            role = params?.role;
            if (role !== 'kit-controller' && role !== 'kit-consumer') throw new Error('control_role_rejected');
            const { role: _, ...hello } = params;
            target = this.targets.find(v => v.context.target_id === hello.context?.target_id);
            const secret = role === 'kit-controller' ? target?.controllerToken : target?.consumerToken;
            if (!target || !secret) throw new Error('control_scope_rejected');
            pending = SecureControlChannel.server(secret, target.context, hello);
            send({ jsonrpc: '2.0', id: raw.id, result: pending.challenge }); return;
          }
          if (raw.method !== 'auth/finish' || !pending || !target || !role) throw new Error('control_authentication_required');
          secure = pending.finish(raw.params); pending = undefined;
          send({ jsonrpc: '2.0', id: raw.id, result: { authenticated: true } }); return;
        }
        if (!target || !role) throw new Error('control_authentication_required');
        if (role === 'kit-consumer' && !['desktop/plugins/catalog', 'desktop/plugins/call'].includes(raw.method)) throw new Error('control_role_rejected');
        try {
          const result = await this.dispatch({ context: target.context, role, channelId, rpcId: raw.id }, raw.method, raw.params ?? {});
          send({ jsonrpc: '2.0', id: raw.id, result });
        } catch (error) {
          const code = error instanceof Error && /^[a-z0-9_.:-]{1,160}$/.test(error.message) ? error.message : 'desktop_host_operation_failed';
          send({ jsonrpc: '2.0', id: raw.id, error: { code: -32000, message: code } });
        }
      } catch { socket.destroy(); }
    };
    socket.on('data', data => {
      buffer += data;
      if (Buffer.byteLength(buffer) > 6 * 1024 * 1024) { socket.destroy(); return; }
      for (;;) { const n = buffer.indexOf('\n'); if (n < 0) break; const line = buffer.slice(0, n); buffer = buffer.slice(n + 1); if (++queued > 4) { socket.destroy(); return; } queue = queue.then(() => request(line)).finally(() => { queued--; }); }
    });
    socket.on('error', () => socket.destroy()); socket.once('close', () => this.sockets.delete(socket));
  }
  async close() { for (const socket of this.sockets) socket.destroy(); this.sockets.clear(); if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve())); }
}
