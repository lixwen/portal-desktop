import { parseUniqueJson } from './json';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
export interface ControlContext { owner_id: string; heart_id: string; target_id: string; authority: 'local' | 'home' }
interface ControlChallenge { protocol: string; client_nonce: string; server_nonce: string; expires_at_unix_ms: number; context: ControlContext; server_proof: string }
interface ControlFrame { protocol: string; sequence: string; payload: string; mac: string }
export const CONTROL_PROTOCOL = 'kit-control-hmac-v1';
const fields = ['owner_id', 'heart_id', 'target_id', 'authority'] as const;
const u32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
const u64 = (value: bigint) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(value); return bytes; };
const hex = (value: string) => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('invalid_control_channel'); return Buffer.from(value, 'hex'); };
const hmac = (key: Buffer, prefix: string, bytes: Buffer) => createHmac('sha256', key).update(prefix + '\0').update(bytes).digest();
function transcript(challenge: ControlChallenge) {
  const chunks = [Buffer.from(CONTROL_PROTOCOL + '\0'), hex(challenge.client_nonce), hex(challenge.server_nonce), u64(BigInt(challenge.expires_at_unix_ms))];
  for (const field of fields) { const bytes = Buffer.from(challenge.context[field]); chunks.push(u32(bytes.length), bytes); }
  return Buffer.concat(chunks);
}
/** Client-side mutual authentication plus exact-byte sequenced frame integrity.
 * Controller secrets are never sent on the TCP channel. */
export class SecureControlChannel {
  private failed = false;
  private send = 0n;
  private received = 0n;
  private constructor(private key: Buffer, private client = true) {}
  static hello(context: ControlContext) { if (!context || !['local', 'home'].includes(context.authority) || ['owner_id', 'heart_id', 'target_id'].some(field => { const value = context[field as keyof ControlContext]; return typeof value !== 'string' || value === '.' || value === '..' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(value); })) throw new Error('invalid_control_context'); return { protocol: CONTROL_PROTOCOL, client_nonce: randomBytes(32).toString('hex'), context }; }
  static authenticate(secret: string, context: ControlContext, nonce: string, raw: unknown, now = Date.now()) {
    const challenge = raw as ControlChallenge;
    if (!challenge || Object.keys(challenge).length !== 6 || Object.keys(challenge).some(key => !['protocol', 'client_nonce', 'server_nonce', 'expires_at_unix_ms', 'context', 'server_proof'].includes(key)) || challenge.protocol !== CONTROL_PROTOCOL || challenge.client_nonce !== nonce ||
        !Number.isSafeInteger(challenge.expires_at_unix_ms) || challenge.expires_at_unix_ms <= now || challenge.expires_at_unix_ms > now + 30000 ||
        !challenge.context || Object.keys(challenge.context).length !== fields.length || fields.some(field => challenge.context[field] !== context[field])) throw new Error('invalid_control_challenge');
    const bytes = transcript(challenge), key = Buffer.from(secret);
    const expected = hmac(key, 'kit-control-server-proof-v1', bytes), proof = hex(challenge.server_proof);
    if (!timingSafeEqual(expected, proof)) throw new Error('control_server_authentication_failed');
    return { finish: { protocol: CONTROL_PROTOCOL, client_proof: hmac(key, 'kit-control-client-proof-v1', bytes).toString('hex') },
      channel: new SecureControlChannel(hmac(key, 'kit-control-session-key-v1', bytes)) };
  }
  static server(secret: string, context: ControlContext, raw: unknown, now = Date.now()) {
    const hello = raw as { protocol: string; client_nonce: string; context: ControlContext };
    if (!hello || hello.protocol !== CONTROL_PROTOCOL || !hello.context || Object.keys(hello).length !== 3 ||
        Object.keys(hello.context).length !== fields.length || fields.some(field => hello.context[field] !== context[field])) throw new Error('invalid_control_hello');
    hex(hello.client_nonce);
    const challenge: ControlChallenge = { protocol: CONTROL_PROTOCOL, client_nonce: hello.client_nonce, server_nonce: randomBytes(32).toString('hex'), expires_at_unix_ms: now + 30000, context, server_proof: '' };
    const bytes = transcript(challenge), key = Buffer.from(secret);
    challenge.server_proof = hmac(key, 'kit-control-server-proof-v1', bytes).toString('hex');
    let consumed = false;
    return { challenge, finish(raw: unknown, at = Date.now()) {
      if (consumed) throw new Error('control_challenge_consumed'); consumed = true;
      const finish = raw as { protocol: string; client_proof: string };
      if (at >= challenge.expires_at_unix_ms || !finish || finish.protocol !== CONTROL_PROTOCOL || Object.keys(finish).length !== 2 ||
          !timingSafeEqual(hex(finish.client_proof), hmac(key, 'kit-control-client-proof-v1', bytes))) throw new Error('control_client_authentication_failed');
      return new SecureControlChannel(hmac(key, 'kit-control-session-key-v1', bytes), false);
    } };
  }
  private frameMac(direction: string, sequence: bigint, bytes: Buffer) {
    const directionBytes = Buffer.from(direction);
    return hmac(this.key, 'kit-control-frame-v1', Buffer.concat([u32(directionBytes.length), directionBytes, u64(sequence), u64(BigInt(bytes.length)), bytes]));
  }
  encode(value: unknown): ControlFrame {
    const bytes = Buffer.from(JSON.stringify(value));
    if (this.failed || bytes.length > 4 * 1024 * 1024 || this.send === 0xffffffffffffffffn) throw new Error('control_frame_limit');
    const sequence = ++this.send;
    return { protocol: CONTROL_PROTOCOL, sequence: sequence.toString(), payload: bytes.toString('base64'), mac: this.frameMac(this.client ? 'client-to-server' : 'server-to-client', sequence, bytes).toString('hex') };
  }
  decode(raw: unknown): unknown {
    if (this.failed) throw new Error('invalid_control_frame');
    try { return this.decodeFrame(raw); } catch { this.failed = true; throw new Error('invalid_control_frame'); }
  }
  private decodeFrame(raw: unknown): unknown {
    const frame = raw as ControlFrame;
    if (!frame || Object.keys(frame).length !== 4 || Object.keys(frame).some(key => !['protocol', 'sequence', 'payload', 'mac'].includes(key)) || frame.protocol !== CONTROL_PROTOCOL || frame.sequence !== (this.received + 1n).toString() ||
        typeof frame.payload !== 'string' || frame.payload.length > Math.ceil(4 * 1024 * 1024 / 3) * 4) throw new Error('invalid_control_frame');
    const bytes = Buffer.from(frame.payload, 'base64');
    if (bytes.length > 4 * 1024 * 1024 || bytes.toString('base64') !== frame.payload || !timingSafeEqual(hex(frame.mac), this.frameMac(this.client ? 'server-to-client' : 'client-to-server', this.received + 1n, bytes))) throw new Error('invalid_control_frame');
    this.received++;
    try { return parseUniqueJson(bytes.toString(), 4 * 1024 * 1024); } catch { throw new Error('invalid_control_payload'); }
  }
}
