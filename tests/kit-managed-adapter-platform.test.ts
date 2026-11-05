import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ManagedDesktopPlugins } from "../desktop/main/kits/managed-plugins";
import type { NativeRegistration } from "../desktop/main/kits/native-controller";
import { PluginRegistry } from "../desktop/main/plugins/registry";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("rejects Linux managed adapter registration and business before Registry or ledger effects", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "managed-adapter-platform-"));
	roots.push(root);
	const registry = new PluginRegistry(path.join(root, "plugins"));
	const observed = vi.spyOn(registry, "nativeObservation");
	const denied = vi.fn(async (): Promise<never> => { throw new Error("unexpected ledger effect"); });
	const controller = { register: denied, begin: denied, complete: denied, close: vi.fn() };
	const file = path.join(root, "managed.json");
	const adapter = new ManagedDesktopPlugins(registry, controller, { owner_id: "owner", heart_id: "heart", target_id: "desktop-B", authority: "local" }, file);
	vi.spyOn(os, "platform").mockReturnValue("linux");
	await expect(adapter.register({} as NativeRegistration, [])).rejects.toThrow("unsupported_managed_desktop_platform");
	await expect(adapter.call("alias", {}, { endpoint: "https://heart.fixture.invalid/being", sessionId: "session", rpcId: 1 })).rejects.toThrow("unsupported_managed_desktop_platform");
	expect(await adapter.catalog(() => true)).toEqual({ tools: [] });
	expect(observed).not.toHaveBeenCalled();
	expect(denied).not.toHaveBeenCalled();
	await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
	// Existing local withdrawal stays available, and grants no business access.
	await adapter.withdraw("old-installation", "old-component");
	expect(JSON.parse(await readFile(file, "utf8")).entries).toEqual([]);
});
