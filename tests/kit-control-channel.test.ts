import { expect, it } from 'vitest';
import vector from './fixtures/control-channel-v1.json';
import { SecureControlChannel, type ControlContext } from '../desktop/main/kits/control-channel';
const context = vector.context as ControlContext;
function handshake() { return SecureControlChannel.authenticate(vector.secret_utf8, context, vector.hello.client_nonce, vector.challenge, vector.now_unix_ms); }
it('matches canonical Rust handshake and exact payload frame vectors including fractional business JSON', () => {
  const { finish, channel } = handshake();
  expect(finish).toEqual(vector.finish);
  expect(channel.encode(JSON.parse(vector.client_payload_utf8))).toEqual(vector.client_frame);
  expect(channel.decode(vector.server_frame)).toEqual(JSON.parse(vector.server_payload_utf8));
});
it('rejects a fake server, foreign fixed owner/target, nonce substitution and expired challenges without sending a secret', () => {
  expect(() => SecureControlChannel.authenticate('different-fixture-controller-secret', context, vector.hello.client_nonce, vector.challenge, vector.now_unix_ms)).toThrow('authentication_failed');
  expect(() => SecureControlChannel.authenticate(vector.secret_utf8, { ...context, owner_id: 'foreign' }, vector.hello.client_nonce, vector.challenge, vector.now_unix_ms)).toThrow('invalid_control_challenge');
  expect(() => SecureControlChannel.authenticate(vector.secret_utf8, context, '33'.repeat(32), vector.challenge, vector.now_unix_ms)).toThrow('invalid_control_challenge');
  expect(() => SecureControlChannel.authenticate(vector.secret_utf8, context, vector.hello.client_nonce, vector.challenge, vector.now_unix_ms + 30001)).toThrow('invalid_control_challenge');
  expect(JSON.stringify(SecureControlChannel.hello(context))).not.toContain(vector.secret_utf8);
});
it('rejects captured frames, wrong direction, modified payload and replayed sequence and poisons failed sessions', () => {
  const { channel } = handshake(); channel.decode(vector.server_frame);
  expect(() => channel.decode(vector.server_frame)).toThrow('invalid_control_frame');
  expect(() => channel.encode({})).toThrow('control_frame_limit');
  expect(() => handshake().channel.decode(vector.client_frame)).toThrow('invalid_control_frame');
  expect(() => handshake().channel.decode({ ...vector.server_frame, payload: Buffer.from('{"result":"forged dispatch"}').toString('base64') })).toThrow('invalid_control_frame');
});
