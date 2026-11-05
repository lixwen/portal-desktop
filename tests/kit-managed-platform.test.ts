import { afterEach, expect, it, vi } from "vitest";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { managedDesktopSupported } from "../desktop/main/kits/managed-platform";
import { NativeHomeDesktopHosts } from "../desktop/main/home/desktop-hosts";
import { startHomeKitHosts } from "../desktop/main/home/start-hosts";
import type { HomeClient } from "../desktop/main/home/client";
import { DesktopHostFacts } from "../desktop/main/kits/host-facts";
import { PluginRegistry } from "../desktop/main/plugins/registry";
import { LocalApps } from "../desktop/main/app/local-apps";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("accepts only the validated Mac managed B/C platform, independently of OS enums", () => {
	expect(managedDesktopSupported("darwin")).toBe(true);
	for (const platform of ["linux", "win32", "freebsd", "unsupported"]) {
		expect(managedDesktopSupported(platform)).toBe(false);
	}
});

it("keeps Linux Home MCP A running while actual B/C starter skips unsupported enrollment", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "managed-platform-"));
	roots.push(root);
	const effect = vi.fn((): never => { throw new Error("unsupported B/C must do zero work"); });
	// OAuth and MCP A are explicit boundary fixtures; B/C starter is production.
	const home = { onSessionInvalidated: () => () => {}, state: effect, request: effect } as unknown as HomeClient;
	const desktop = new NativeHomeDesktopHosts({
		directory: root, home,
		facts: new DesktopHostFacts(path.join(root, "host.json")),
		registry: new PluginRegistry(path.join(root, "plugins")),
		apps: new LocalApps(path.join(root, "apps.json")),
		connection: effect, settings: effect,
		openPlugin: async () => { effect(); }, closePlugin: effect,
		confirm: async () => effect(), ensureLegacyGate: async () => { effect(); },
	});
	const portal = { start: vi.fn(async () => ({ phase: "running" as const, message: "MCP boundary fixture" })), stop: vi.fn(async () => {}) };
	vi.spyOn(os, "platform").mockReturnValue("linux");
	await startHomeKitHosts(portal, desktop);
	expect(portal.start).toHaveBeenCalledTimes(1);
	expect(portal.stop).not.toHaveBeenCalled();
	expect(effect).not.toHaveBeenCalled();
	expect(desktop.supported()).toBe(false);
	expect(desktop.state()).toEqual([]);
});
