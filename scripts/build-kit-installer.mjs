import { spawn } from 'node:child_process';
import { mkdir, copyFile, chmod, rename, rm, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
const source = process.env.KIT_INSTALLER_SOURCE;
if (!source || !path.isAbsolute(source)) throw new Error('Set KIT_INSTALLER_SOURCE to the reviewed kit-installer crate before packaging.');
const child = spawn('cargo', ['build', '--release', '--locked', '--manifest-path', path.join(source, 'Cargo.toml')], { stdio: 'inherit', shell: false });
await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Kit installer build exited ${code}`))); });
const name = process.platform === 'win32' ? 'kit-installer.exe' : 'kit-installer';
await mkdir('resources', { recursive: true });
const destination = path.resolve('resources', name), built = path.join(source, 'target/release', name), temporary = `${destination}.${randomUUID()}.tmp`;
const bytes = await readFile(built), old = await readFile(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
if (!old?.equals(bytes)) try { await copyFile(built, temporary); if (process.platform !== 'win32') await chmod(temporary, 0o755); await rename(temporary, destination); } finally { await rm(temporary, { force: true }); }
