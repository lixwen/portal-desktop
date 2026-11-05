import { readFile, mkdir, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { durablePrivateJson } from '../kits/durable-file';
import type { LocalApp } from '../../shared/types';
type StoredApp = LocalApp & { associationRevision?: number };

/** User-chosen associations only; never infer an installation from a download or a visit. */
export class LocalApps {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private file: string) {}
  private serialize<T>(fn: () => Promise<T>) { const result = this.queue.then(fn); this.queue = result.catch(() => {}); return result; }
  private validId(id: string) { return typeof id === 'string' && /^[a-zA-Z0-9_.-]{1,160}$/.test(id) && id !== '.' && id !== '..'; }
  private async records(): Promise<StoredApp[]> {
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8'));
      if (!Array.isArray(value)) throw new Error('本机 App 关联记录格式错误。');
      const ids = new Set<string>();
      for (const item of value) {
        if (!item || !this.validId(item.id) || ids.has(item.id) || typeof item.name !== 'string' || !item.name.trim() || typeof item.path !== 'string' || !path.isAbsolute(item.path) || (item.associationRevision !== undefined && (!Number.isSafeInteger(item.associationRevision) || item.associationRevision < 1))) throw new Error('本机 App 关联记录格式错误。');
        ids.add(item.id);
      }
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  async list() {
    return Promise.all((await this.records()).map(async item => ({ ...item, exists: await stat(item.path).then(s => s.isFile() || s.isDirectory()).catch(() => false) })));
  }
  associate(entry: unknown, selectedPath: string) {
    return this.serialize(async () => {
      const value = entry as LocalApp;
      if (!value || !this.validId(value.id) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 300 || !path.isAbsolute(selectedPath)) throw new Error('App 条目无效。');
      const info = await stat(selectedPath);
      if (!info.isFile() && !info.isDirectory()) throw new Error('请选择本机程序。');
      const associationRevision = await this.bumpObservation(value.id);
      await this.save([...(await this.records()).filter(item => item.id !== value.id), { id: value.id, name: value.name, path: selectedPath, exists: true, associationRevision }]);
    });
  }
  remove(id: string) { return this.serialize(async () => { if (!this.validId(id)) throw new Error('App 条目无效。'); await this.bumpObservation(id); await this.save((await this.records()).filter(item => item.id !== id)); }); }
  private async observations(): Promise<Record<string, number>> {
    try { const value = JSON.parse(await readFile(this.file + '.observations', 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([id, revision]) => !this.validId(id) || !Number.isSafeInteger(revision) || (revision as number) < 1)) throw new Error('app_observation_invalid'); return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  }
  private async bumpObservation(id: string) { const observations = await this.observations(), revision = observations[id] || 0; if (revision >= Number.MAX_SAFE_INTEGER) throw new Error('app_observation_exhausted'); observations[id] = revision + 1; await this.atomic(this.file + '.observations', observations); return revision + 1; }
  initializeObservations() { return this.serialize(async () => { const records = await this.records(); let changed = false; for (const app of records) if (!app.associationRevision) { app.associationRevision = await this.bumpObservation(app.id); changed = true; } if (changed) await this.save(records); }); }
  async associationInventory() { return (await this.list()).map(app => ({ id: app.id, revision: app.associationRevision || 0, display_name: app.name, status: app.exists ? 'associated' as const : 'missing' as const })).sort((a, b) => a.id.localeCompare(b.id, 'en')); }
  observeAssociation(id: string) {
    return this.serialize(async () => {
      if (!this.validId(id)) throw new Error('invalid_app_reference');
      const app = (await this.list()).find(item => item.id === id); if (!app?.exists) throw new Error('app_association_not_found');
      let revision = app.associationRevision; if (!revision) { revision = await this.bumpObservation(id); const records = await this.records(); const current = records.find(item => item.id === id)!; current.associationRevision = revision; await this.save(records); }
      return { app, canonicalPath: await realpath(app.path), association_id: id, association_revision: revision };
    });
  }
  private async references(): Promise<{ appId: string; installationId: string; componentId: string }[]> {
    try {
      const value = JSON.parse(await readFile(this.file + '.kit-references', 'utf8'));
      if (!Array.isArray(value) || value.length > 10000 || value.some(v => !this.validId(v.appId) || !this.validId(v.installationId) || !this.validId(v.componentId))) throw new Error('App 引用记录格式错误。');
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  /** Trusted installer references an existing stable ID. No path/name matching,
   * system install receipt, file copy, delete or OS uninstall is performed. */
  referenceInstallation(appId: string, installationId: string, componentId: string) {
    return this.serialize(async () => {
      if (![appId, installationId, componentId].every(v => this.validId(v))) throw new Error('invalid_app_reference');
      const app = (await this.list()).find(v => v.id === appId);
      if (!app) throw new Error('app_association_not_found');
      const refs = await this.references();
      if (!refs.some(v => v.appId === appId && v.installationId === installationId && v.componentId === componentId)) refs.push({ appId, installationId, componentId });
      if (refs.length > 10000) throw new Error('app_reference_limit');
      await this.atomic(this.file + '.kit-references', refs);
      return { appId, state: app.exists ? 'associated' as const : 'missing' as const, versionVerified: false as const };
    });
  }
  unlinkInstallation(installationId: string, componentId: string) {
    return this.serialize(async () => {
      if (![installationId, componentId].every(v => this.validId(v))) throw new Error('invalid_app_reference');
      await this.atomic(this.file + '.kit-references', (await this.references()).filter(v => v.installationId !== installationId || v.componentId !== componentId));
    });
  }
  private async save(records: StoredApp[]) {
    await mkdir(path.dirname(this.file), { recursive: true });
    await this.atomic(this.file, records);
  }
  private atomic(file: string, value: unknown) { return durablePrivateJson(file, value); }
}
