import type { NativeHomeDesktopHosts } from "./desktop-hosts";
import type { NativeHomeKitHost } from "./kit-host";

/** A platform without B/C still starts its independently supported MCP host. */
export async function startHomeKitHosts(
	portal: Pick<NativeHomeKitHost, "start" | "stop">,
	desktop?: Pick<NativeHomeDesktopHosts, "start" | "stop">,
): Promise<void> {
	try {
		const state = await portal.start();
		if (state.phase === "running") await desktop?.start();
	} catch (error) {
		await desktop?.stop();
		await portal.stop();
		throw error;
	}
}
