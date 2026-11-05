import { dialog, type BrowserWindow } from 'electron';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { downloadBundle, downloadKit, unpackKit } from '../kits/install';
import { TownClient } from '../town/client';
import { groveEntryKind, pluginReleaseUrl, PLUGIN_CAPABILITIES } from '../../shared/plugins';
import { PluginRegistry, readPlugin } from './registry';

export function registerPluginsIpc(options: {
  handle: (channel: string, callback: (...args: any[]) => unknown) => void;
  exclusive: <T>(operation: () => Promise<T>) => Promise<T>;
  window: () => BrowserWindow | null;
  registry: PluginRegistry;
  fetcher: typeof fetch;
  closeWindows?: (id: string) => void;
}) {
  const { handle, exclusive, registry, fetcher } = options;
  const review = async (bundle: Awaited<ReturnType<typeof readPlugin>>, source: string) => {
    const window = options.window(); if (!window) return false;
    const m = bundle.manifest;
    return (await dialog.showMessageBox(window, {
      type: 'question', title: '安装客户端插件', message: `安装并启用 ${m.name} v${m.version}？`,
      detail: `${m.description}\n\n作者：${m.author}\n来源：${source}\n页面：${m.contributes.views.map(v => v.title).join('、')}\n插槽：${m.contributes.slots?.map(s => `${s.location === 'right-sidebar' ? '侧栏' : '资源操作'} · ${s.title}`).join('、') || '无'}\n能力：${m.capabilities.map(capability => PLUGIN_CAPABILITIES[capability]).join('、') || '仅界面'}\n\n插件将在隔离页面中运行 JavaScript。安装只写入插件目录，无需修改客户端源码。\n内容 SHA-256：${bundle.sha256}\n摘要用于内容校验，不代表作者身份已验证。`,
      buttons: ['取消', '安装并启用'], defaultId: 0, cancelId: 0,
    })).response === 1;
  };
  handle('beings:plugins-list', () => registry.list());
  handle('beings:plugins-import', () => exclusive(async () => {
    const window = options.window(); if (!window) return false;
    const choice = await dialog.showOpenDialog(window, { title: '选择包含 desktop.plugin.json 的插件目录', properties: ['openDirectory'] });
    if (choice.canceled || !choice.filePaths[0]) return false;
    const bundle = await readPlugin(choice.filePaths[0]);
    if (!await review(bundle, '本地目录')) return false;
    await registry.install(bundle, { kind: 'local' }); return true;
  }));
  handle('beings:plugins-install', (id: string) => exclusive(async () => {
    const detail = await new TownClient(() => '', fetcher).query({ kind: 'kit', id });
    if (!detail.ok) throw new Error(detail.message);
    if (detail.data.ambiguous || groveEntryKind(detail.data) !== 'plugin') throw new Error('请选择具体的 Grove Plugin 条目（兼容带 plugin 标签的旧 App）。');
    const release = pluginReleaseUrl(detail.data);
    const data = release ? await downloadBundle(release, fetcher)
      : detail.data.has_bundle === true || detail.data.source_url ? await downloadKit(id, fetcher)
      : (() => { throw new Error('条目缺少插件下载包或固定的 GitHub Release。'); })();
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'grove-plugin-'));
    try {
      const source = await unpackKit(data, path.join(temporary, 'unpacked'), 'desktop.plugin.json');
      const bundle = await readPlugin(source);
      if (bundle.manifest.name !== detail.data.name || bundle.manifest.version !== detail.data.version) throw new Error('插件名称或版本与 Grove 条目不一致。');
      if (!await review(bundle, `Grove / ${id}`)) return false;
      await registry.install(bundle, { kind: 'grove', id }); return true;
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }));
  handle('beings:plugins-update', (id: string) => exclusive(async () => {
    const window = options.window(); if (!window) return false;
    const installed = (await registry.list()).plugins.find(p => p.manifest.id === id);
    if (!installed) throw new Error('插件不存在。');
    if (installed.source.kind === 'kit') throw new Error('受管 Kit 插件请通过所属安装计划更新。');
    let temporary: string | undefined;
    try {
      let directory: string;
      if (installed.source.kind === 'local') {
        const choice = await dialog.showOpenDialog(window, { title: '选择此插件的新版本目录', properties: ['openDirectory'] });
        if (choice.canceled || !choice.filePaths[0]) return false;
        directory = choice.filePaths[0];
      } else {
        if (!installed.source.id) throw new Error('插件来源缺失，无法更新。');
        const detail = await new TownClient(() => '', fetcher).query({ kind: 'kit', id: installed.source.id });
        if (!detail.ok) throw new Error(detail.message);
        if (detail.data.ambiguous || groveEntryKind(detail.data) !== 'plugin') throw new Error('插件来源不匹配。');
        const release = pluginReleaseUrl(detail.data);
        const data = release ? await downloadBundle(release, fetcher) : await downloadKit(installed.source.id, fetcher);
        temporary = await mkdtemp(path.join(os.tmpdir(), 'grove-plugin-update-'));
        directory = await unpackKit(data, path.join(temporary, 'unpacked'), 'desktop.plugin.json');
        const candidate = await readPlugin(directory);
        if (candidate.manifest.name !== detail.data.name || candidate.manifest.version !== detail.data.version) throw new Error('插件版本与来源不一致。');
      }
      const bundle = await readPlugin(directory);
      if (bundle.manifest.id !== id) throw new Error('插件 ID 与原安装不一致。');
      const added = bundle.manifest.capabilities.filter(c => !installed.manifest.capabilities.includes(c));
      const result = await dialog.showMessageBox(window, { type: 'question', title: '更新客户端插件',
        message: `${installed.manifest.name}：${installed.manifest.version} → ${bundle.manifest.version}`,
        detail: `来源：${installed.source.kind === 'grove' ? `Grove / ${installed.source.id}` : '用户选择的本地目录'}\n新增权限：${added.map(c => PLUGIN_CAPABILITIES[c]).join('、') || '无'}\n全部权限：${bundle.manifest.capabilities.map(c => PLUGIN_CAPABILITIES[c]).join('、') || '仅界面'}\nSHA-256：${bundle.sha256}\n\n更新会关闭插件页面。保留启用状态、仍存在的布局和私有/Being 分区数据；保存上一版本备份。此更新不执行数据迁移。请核实来源；本地目录选择表示确认此包为原插件的更新。`,
        buttons: ['取消', '确认更新'], defaultId: 0, cancelId: 0 });
      if (result.response !== 1) return false;
      await registry.update(bundle, installed.source, installed.sha256); options.closeWindows?.(id); return true;
    } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
  }));
  handle('beings:plugins-restore-update', (id: string) => exclusive(async () => {
    const window = options.window(); if (!window) return false;
    if ((await dialog.showMessageBox(window, { type: 'warning', title: '恢复插件上一版本', message: '恢复上次更新前的插件包和布局？',
      detail: '当前页面会关闭，恢复旧版启用状态；私有和 Being 分区数据保留当前内容。若新版已通过 SDK 写入不兼容数据，二进制恢复不能撤销这些写入。', buttons: ['取消', '恢复上一版本'], defaultId: 0, cancelId: 0 })).response !== 1) return false;
    await registry.restoreUpdate(id); options.closeWindows?.(id); return true;
  }));
  handle('beings:plugins-sidebar-slot-visible', (id, slot, visible) => registry.setSidebarSlotVisible(id, slot, visible));
  handle('beings:plugins-icon', (id, view, icon) => registry.setIcon(id, view, icon));
  handle('beings:plugins-placement', (id, view, placement) => registry.setPlacement(id, view, placement));
  handle('beings:plugins-enable', async (id: string, enabled: boolean) => { await registry.setEnabled(id, enabled); options.closeWindows?.(id); });
  handle('beings:plugins-remove', (id: string) => exclusive(async () => {
    const window = options.window(); if (!window) return false;
    const plugin = (await registry.list()).plugins.find(p => p.manifest.id === id);
    if (!plugin) throw new Error('插件不存在。');
    const choice = await dialog.showMessageBox(window, { type: 'question', title: '卸载插件', message: `卸载 ${plugin.manifest.name}？`, detail: '页面入口将移除。插件私有数据保留，通过来源核验后可恢复；同 ID 不代表相同来源。', buttons: ['取消', '卸载'], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return false;
    await registry.remove(id); options.closeWindows?.(id); return true;
  }));
  handle('beings:plugins-open', (id: string, view: string, command?: string, slot?: string) => registry.open(id, view, command, slot));
  handle('beings:plugins-ready', (token: string) => registry.markReady(token));
  handle('beings:plugins-close', (token: string) => registry.close(token));
  handle('beings:plugins-call', (token: string, method: string, value?: unknown) => registry.call(token, method, value));
}
