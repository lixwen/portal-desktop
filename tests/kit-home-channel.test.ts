import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import type { HomeClient } from '../desktop/main/home/client';
import { HomeExecutorChannel, type HomeChannelContext, type HomeHostHello } from '../desktop/main/home/host-channel';
const dispose: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of dispose.splice(0).reverse()) await close(); });
async function until(test: () => boolean) { const deadline = Date.now() + 3000; while (!test()) { if (Date.now() > deadline) throw new Error('condition_timeout'); await new Promise(r => setTimeout(r, 5)); } }
const hello: HomeHostHello = { protocol: 'kit-home-host-v1', owner_id: 'owner', profile_id: 'profile', heart_id: 'heart', heart_origin: 'https://heart.fixture.invalid', heart_slug: 'existing', target_id: 'target-B', generation: 1, incarnation_id: randomUUID() };
const context: HomeChannelContext = { ...Object.fromEntries(Object.entries(hello).filter(([key]) => !['protocol', 'incarnation_id'].includes(key))), channel_id: randomUUID(), fence: 1 } as HomeChannelContext;
async function fixture(onMessage: (message: any, peer: WebSocket) => void, welcome: unknown = context) {
  const server = createServer(), wss = new WebSocketServer({ server }); const peers: WebSocket[] = [], headers: any[] = [], paths: string[] = [];
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/prefix/`;
  wss.on('connection', (peer, request) => { peers.push(peer); headers.push(request.headers); paths.push(request.url!); peer.on('message', data => { const message = JSON.parse(data.toString()); if (message.type === 'hello') peer.send(JSON.stringify({ type: 'welcome', context: welcome })); onMessage(message, peer); }); });
  dispose.push(async () => { for (const peer of peers) peer.terminate(); await new Promise<void>(r => wss.close(() => r())); await new Promise<void>(r => server.close(() => r())); });
  let invalidated = () => {}, calls = 0, disconnected = 0;
  const home = { state: () => ({ signedIn: true, baseUrl, clientId: 'native' }), onSessionInvalidated: (fn: () => void) => { invalidated = fn; return () => {}; }, withAccessToken: (fn: any) => fn({ baseUrl, clientId: 'native', accessToken: 'private-native-home' }) } as unknown as HomeClient;
  const channel = new HomeExecutorChannel({ home, baseUrl, clientId: 'native', hello, execute: async () => { calls++; return { result: 'tool_result', value: { content: [{ type: 'text', text: 'actual SDK adapted result' }] } }; }, disconnected: async () => { disconnected++; } });
  dispose.push(() => channel.close());
  return { channel, peers, headers, paths, calls: () => calls, disconnected: () => disconnected, invalidated: () => invalidated() };
}
it('uses native bearer without Origin/Cookie, exact base prefix and fixed owner/Heart/target context before dispatch', async () => {
  const messages: any[] = []; const f = await fixture(message => messages.push(message)); await f.channel.connect();
  expect(f.headers[0].authorization).toBe('Bearer private-native-home'); expect(f.headers[0].origin).toBeUndefined(); expect(f.headers[0].cookie).toBeUndefined(); expect(f.paths).toEqual(['/prefix/v1/me/kit-hosts/channel']);
  expect(messages[0]).toEqual({ type: 'hello', hello }); expect(JSON.stringify(messages)).not.toContain('private-native-home');
  const request = randomUUID(); f.peers[0].send(JSON.stringify({ type: 'command', sequence: 1, request_id: request, command: { command: 'dispatch', dispatch: { call_id: 'fixed-home-call' } } }));
  await until(() => messages.some(m => m.type === 'reply')); expect(f.calls()).toBe(1); expect(messages.find(m => m.type === 'reply')).toMatchObject({ sequence: 1, request_id: request, outcome: { status: 'completed', result: { result: 'tool_result' } } });
});
it.each([{ ...context, owner_id: 'foreign' }, { ...context, target_id: 'foreign' }, { ...context, heart_origin: 'https://foreign.invalid' }, { ...context, fence: Number.MAX_SAFE_INTEGER + 1 }])('rejects mismatched or unsafe welcome without executor calls (%j)', async wrong => {
  const f = await fixture(() => {}, wrong); await expect(f.channel.connect()).rejects.toThrow('home_executor_channel_unavailable'); expect(f.calls()).toBe(0); expect(f.channel.state()).toBeUndefined();
});
it('replayed sequence closes the channel without repeating business and invalidation revokes the authenticated peer', async () => {
  const replies: any[] = []; const f = await fixture(message => replies.push(message)); await f.channel.connect();
  const frame = { type: 'command', sequence: 1, request_id: randomUUID(), command: { command: 'dispatch', dispatch: { call_id: 'same-write' } } };
  f.peers[0].send(JSON.stringify(frame)); await until(() => replies.some(m => m.type === 'reply')); f.peers[0].send(JSON.stringify(frame)); await until(() => !f.channel.state()); expect(f.calls()).toBe(1); expect(f.disconnected()).toBeGreaterThan(0);
  await f.channel.connect(); f.invalidated(); await until(() => !f.channel.state()); expect(f.calls()).toBe(1);
});
it('does not follow a redirect or disclose bearer to another listener', async () => {
  let targetRequests = 0; const target = createServer((_req, res) => { targetRequests++; res.end(); }); await new Promise<void>(r => target.listen(0, '127.0.0.1', r)); dispose.push(() => new Promise<void>(r => target.close(() => r())));
  const server = createServer((_req, res) => { res.writeHead(302, { Location: `http://127.0.0.1:${(target.address() as any).port}/forged` }); res.end(); }); await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); dispose.push(() => new Promise<void>(r => server.close(() => r())));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/`; const home = { state: () => ({ signedIn: true, baseUrl, clientId: 'native' }), onSessionInvalidated: () => () => {}, withAccessToken: (fn: any) => fn({ baseUrl, clientId: 'native', accessToken: 'private-home' }) } as unknown as HomeClient;
  const channel = new HomeExecutorChannel({ home, baseUrl, clientId: 'native', hello, execute: async () => { throw new Error('must_not_run'); }, disconnected: async () => {} }); dispose.push(() => channel.close());
  await expect(channel.connect()).rejects.toThrow('home_executor_channel_unavailable'); expect(targetRequests).toBe(0);
});
