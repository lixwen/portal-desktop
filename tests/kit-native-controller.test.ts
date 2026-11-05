import { afterEach, expect, it } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { NativeKitController, type NativeTool } from '../desktop/main/kits/native-controller';
const servers: Server[] = [], sockets: Socket[] = [];
afterEach(async () => { for (const socket of sockets.splice(0)) socket.destroy(); for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve())); });
const scope = { owner_id: 'owner', heart_id: 'heart', target_id: 'device', authority: 'local' as const };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(n); return b; };
const mac = (key: Buffer, prefix: string, bytes: Buffer) => createHmac('sha256', key).update(prefix + '\0').update(bytes).digest();
async function fixture(execute: (request: any, peer: { write(data: string): void; destroy(): void }) => void, fakeProof = false) {
  const requests: any[] = [];
  const server = createServer(socket => {
    sockets.push(socket); let buffer = '', key: Buffer | undefined, challenge: any, transcript: Buffer, sent = 0n, received = 0n;
    const send = (response: any) => {
      const bytes = Buffer.from(JSON.stringify(response)), sequence = ++sent, direction = Buffer.from('server-to-client');
      const frame = { protocol: 'kit-control-hmac-v1', sequence: sequence.toString(), payload: bytes.toString('base64'), mac: mac(key!, 'kit-control-frame-v1', Buffer.concat([u32(direction.length), direction, u64(sequence), u64(BigInt(bytes.length)), bytes])).toString('hex') };
      socket.write(JSON.stringify(frame) + '\n');
    };
    socket.on('data', data => { buffer += data.toString(); for (;;) {
      const n = buffer.indexOf('\n'); if (n < 0) break;
      let request = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1);
      if (request.method === 'auth') {
        requests.push(request); challenge = { protocol: 'kit-control-hmac-v1', client_nonce: request.params.client_nonce, server_nonce: randomBytes(32).toString('hex'), expires_at_unix_ms: Date.now() + 30000, context: scope };
        const pieces = [Buffer.from('kit-control-hmac-v1\0'), Buffer.from(challenge.client_nonce, 'hex'), Buffer.from(challenge.server_nonce, 'hex'), u64(BigInt(challenge.expires_at_unix_ms))];
        for (const field of ['owner_id', 'heart_id', 'target_id', 'authority'] as const) { const b = Buffer.from(scope[field]); pieces.push(u32(b.length), b); }
        transcript = Buffer.concat(pieces); const secret = Buffer.from(token); challenge.server_proof = fakeProof ? '0'.repeat(64) : mac(secret, 'kit-control-server-proof-v1', transcript).toString('hex');
        key = mac(secret, 'kit-control-session-key-v1', transcript); socket.write(JSON.stringify({ id: request.id, result: challenge }) + '\n'); continue;
      }
      if (request.method === 'auth/finish') { requests.push(request); expect(request.params.client_proof).toBe(mac(Buffer.from(token), 'kit-control-client-proof-v1', transcript!).toString('hex')); send({ id: request.id, result: { authenticated: true } }); continue; }
      const bytes = Buffer.from(request.payload, 'base64'), sequence = ++received, direction = Buffer.from('client-to-server');
      expect(request.sequence).toBe(sequence.toString()); expect(request.mac).toBe(mac(key!, 'kit-control-frame-v1', Buffer.concat([u32(direction.length), direction, u64(sequence), u64(BigInt(bytes.length)), bytes])).toString('hex'));
      request = JSON.parse(bytes.toString()); requests.push(request);
      execute(request, { write: data => send(JSON.parse(data.trim())), destroy: () => socket.destroy() });
    } });
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing_address');
  return { port: address.port, requests };
}
const token = 'private-fixture-controller-token-00000';
const source: NativeTool = { resource_ref: 'plugin-fixture', native_name: 'fixture.create', remote_tool: 'fixture.create', source_digest: 'a'.repeat(64), input_schema: { type: 'object' } };
it('authenticates separate controller role and keeps a single connection for dispatch and durable completion', async () => {
  const f = await fixture((req, socket) => {
    const result = req.method === 'auth' ? { authenticated: true } : req.method === 'kit/native/begin' ? { state: 'dispatch', record_id: 'record' } : { record_id: req.params.record_id, persisted: true };
    socket.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n');
  });
  const controller = await NativeKitController.connect(f.port, token, scope);
  const decision = await controller.begin(source, 'trusted-session', 1, { title: 'test' });
  expect(decision).toEqual({ state: 'dispatch', record_id: 'record' });
  await controller.complete('record', { content: [{ type: 'text', text: 'result' }] });
  expect(f.requests.map(v => v.method)).toEqual(['auth', 'auth/finish', 'kit/native/begin', 'kit/native/complete']);
  expect(f.requests[0].params.role).toBe('kit-controller'); expect(f.requests[0].params).not.toHaveProperty('token'); expect(JSON.stringify(f.requests)).not.toContain(token);
  expect(sockets).toHaveLength(1); controller.close();
});
it('never reconnects or repeats dispatch after a controller disconnect or unknown completion receipt', async () => {
  const f = await fixture((req, socket) => {
    if (req.method === 'auth') socket.write(JSON.stringify({ id: req.id, result: true }) + '\n');
    else socket.destroy();
  });
  const controller = await NativeKitController.connect(f.port, token, scope);
  await expect(controller.begin(source, 'trusted-session', 1, {})).rejects.toThrow('kit_controller_disconnected');
  await expect(controller.begin(source, 'trusted-session', 2, {})).rejects.toThrow('kit_controller_disconnected');
  expect(f.requests.filter(v => v.method === 'kit/native/begin')).toHaveLength(1);
});
it('rejects a fake loopback server before sending controller credentials or business calls', async () => {
  const f = await fixture(() => { throw new Error('business must not run'); }, true);
  await expect(NativeKitController.connect(f.port, token, scope)).rejects.toThrow('control_server_authentication_failed');
  expect(f.requests).toHaveLength(1); expect(JSON.stringify(f.requests)).not.toContain(token);
});
