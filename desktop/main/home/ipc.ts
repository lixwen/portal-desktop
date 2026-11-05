import { dialog } from 'electron';
import { open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SettingsStore } from '../app/settings';
import { HomeClient, HomeError } from './client';
import type { HomeConfig, HomeMe, HomeProfile, HomeComputer, HomeFile, HomeOperation } from '../../shared/home';

const LIMIT = 8 * 1024 * 1024;
function filePath(value: unknown, root = false): string {
  if (typeof value !== 'string' || value.length > 4096 || /[\\\x00-\x1f]/.test(value) || value.startsWith('/') || value.split('/').some(part => ['.', '..'].includes(part)) || (!root && !value)) throw new Error('请输入工作区内的相对路径。');
  return value;
}
export function registerHomeIpc(handle: (channel: string, callback: (...args: any[]) => unknown) => void, home: HomeClient, store: SettingsStore) {
  handle('beings:home-state', () => home.state());
  handle('beings:home-configure', (config: HomeConfig) => home.configure(config));
  handle('beings:home-login', () => home.login());
  handle('beings:home-cancel', () => home.cancelLogin());
  handle('beings:home-logout', () => home.logout());
  handle('beings:home-me', () => home.request<HomeMe>('/v1/me'));
  handle('beings:home-bootstrap', () => home.request<HomeProfile>('/v1/me/bootstrap', 'POST', {}));
  handle('beings:home-profile', (patch: { display_name: string; bio: string }) => {
    if (typeof patch?.display_name !== 'string' || typeof patch.bio !== 'string' || !patch.display_name.trim() || Array.from(patch.display_name).length > 80 || Array.from(patch.bio).length > 2000) throw new Error('显示名需为 1–80 个字符，简介最多 2000 个字符。');
    return home.request<HomeProfile>('/v1/me/being', 'PATCH', { display_name: patch.display_name, bio: patch.bio });
  });
  handle('beings:home-import', async () => {
    const link = store.connection?.link;
    if (!link) throw new Error('请先在 Being 连接设置中保存现有 Heart 链接。');
    const me = await home.request<HomeMe>('/v1/me');
    const result = await dialog.showMessageBox({ type: 'question', title: '关联现有 Heart', message: `将当前客户端连接的 Heart 关联到 Home 账号 ${me.username || me.user.id}？`, detail: 'Home 将验证并加密保存链接。此操作不会替换已有的不同 Heart，也不会更改本机 Portal 连接。', buttons: ['取消', '确认关联'], defaultId: 0, cancelId: 0 });
    if (result.response !== 1) return;
    const current = await home.request<HomeMe>('/v1/me');
    if (current.user.id !== me.user.id || link !== store.connection?.link) throw new Error('账号或 Heart 已切换，请重新确认关联。');
    await home.request('/v1/me/heart/import', 'POST', { link, acknowledge_binding: true });
  });
  handle('beings:home-computer', async () => {
    try { return await home.request<HomeComputer>('/v1/me/computer'); }
    catch (error) { if (error instanceof HomeError && error.status === 404 && error.code === 'computer_not_initialized') return null; throw error; }
  });
  handle('beings:home-computer-action', (kind: string, key: string) => {
    if (!['ensure', 'stop', 'recreate'].includes(kind) || typeof key !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(key)) throw new Error('无效的云电脑操作。');
    return home.request<{ computer: HomeComputer; operation: HomeOperation }>(`/v1/me/computer/${kind}`, 'POST', {}, { 'Idempotency-Key': key });
  });
  handle('beings:home-operation', (id: string) => {
    if (typeof id !== 'string' || !/^[a-fA-F0-9-]{36}$/.test(id)) throw new Error('无效的云电脑操作编号。');
    return home.request<HomeOperation>(`/v1/me/computer/operations/${id}`);
  });
  handle('beings:home-open-computer', () => home.openComputer());
  handle('beings:home-files', (directory: string) => home.request<{ entries: HomeFile[] }>(`/v1/me/files?path=${encodeURIComponent(filePath(directory, true))}`));
  handle('beings:home-mkdir', async (directory: string) => { await home.request('/v1/me/files/directories', 'POST', { path: filePath(directory) }); });
  handle('beings:home-upload', async (directory: string) => {
    filePath(directory, true);
    const owner = (await home.request<HomeMe>('/v1/me')).user.id;
    const selected = await dialog.showOpenDialog({ title: '上传至 Home 工作区（最多 8 MiB）', properties: ['openFile'] });
    if (selected.canceled || !selected.filePaths[0]) return false;
    const filename = selected.filePaths[0];
    const file = await open(filename, 'r');
    let bytes: Buffer;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > LIMIT) throw new Error('请选择不超过 8 MiB 的普通文件。');
      bytes = Buffer.alloc(LIMIT + 1);
      let length = 0;
      while (length < bytes.length) { const result = await file.read(bytes, length, bytes.length - length, null); if (!result.bytesRead) break; length += result.bytesRead; }
      if (length > LIMIT) throw new Error('文件超过 8 MiB。');
      bytes = bytes.subarray(0, length);
    } finally { await file.close(); }
    if ((await home.request<HomeMe>('/v1/me')).user.id !== owner) throw new Error('Home 账号已切换，请重新上传。');
    const target = filePath([directory, path.basename(filename)].filter(Boolean).join('/'));
    await home.raw(`/v1/me/files/content?path=${encodeURIComponent(target)}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(bytes) });
    return true;
  });
  handle('beings:home-download', async (value: string) => {
    const target = filePath(value);
    const owner = (await home.request<HomeMe>('/v1/me')).user.id;
    const selected = await dialog.showSaveDialog({ title: '下载 Home 文件', defaultPath: path.posix.basename(target) });
    if (selected.canceled || !selected.filePath) return false;
    if ((await home.request<HomeMe>('/v1/me')).user.id !== owner) throw new Error('Home 账号已切换，请重新下载。');
    const response = await home.raw(`/v1/me/files/content?path=${encodeURIComponent(target)}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Home 未返回文件内容。');
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) { const next = await reader.read(); if (next.done) break; length += next.value.length; if (length > LIMIT) throw new Error('文件超过当前 8 MiB 下载上限。'); chunks.push(next.value); }
    } finally { await reader.cancel(); }
    await writeFile(selected.filePath, Buffer.concat(chunks));
    return true;
  });
}
