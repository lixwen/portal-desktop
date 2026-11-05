import os from "node:os";

/** New managed Desktop B/C is accepted only on the actually validated OS.
 * MCP A and legacy user-owned plugin/App paths have independent support. */
export function managedDesktopSupported(platform: string = os.platform()): boolean {
	return platform === "darwin";
}

export function requireManagedDesktop(): void {
	if (!managedDesktopSupported()) {
		throw new Error("unsupported_managed_desktop_platform");
	}
}
