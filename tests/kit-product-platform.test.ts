import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bootstrapKitProduct } from "../desktop/main/kits/product-bootstrap";
import { parseConnection } from "../desktop/main/chat/connection";
const boundary = vi.hoisted(() => ({ calls: [] as string[][], desktop: false }));
vi.mock("../desktop/main/kits/market-native", async (original) => {
	const actual = await original<typeof import("../desktop/main/kits/market-native")>();
	return { ...actual, runInstaller: vi.fn(async (_file: string, args: string[]) => {
		boundary.calls.push(args);
		return { format_version: 1, control_protocol: "kit-control-hmac-v1", features: ["market.pinned-source.v1", "runtime.plan.v1", "native_entry.admission.v1", "host.spawn-proof.v1", ...(boundary.desktop ? ["desktop.original-sdk.v1"] : [])] };
	}) };
});
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); boundary.calls.length = 0; boundary.desktop = false; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
	const root = await mkdtemp(path.join(os.tmpdir(), "product-platform-")); roots.push(root);
	const installer = path.join(root, "installer"), portal = path.join(root, "portal");
	const bytes = "trusted CLI boundary fixture; never executed"; const sha = createHash("sha256").update(bytes).digest("hex");
	await writeFile(installer, bytes, { mode: 0o700 }); await writeFile(portal, bytes, { mode: 0o700 });
	await writeFile(path.join(root, "kit-product.json"), JSON.stringify({ format_version: 1, markets: [{ id: "private", label: "Private", base_url: "https://market.fixture.invalid/", root: { fixture: true }, root_digest: "a".repeat(64) }], development_runtime: { installer, installer_sha256: sha, portal, portal_sha256: sha } }), { mode: 0o600 });
	return root;
}
it("bootstraps Linux MCP A without Desktop feature, controller or BC bindings", async () => {
	const root = await fixture(); vi.spyOn(os, "platform").mockReturnValue("linux");
	const product = await bootstrapKitProduct(root, root, false, parseConnection("https://heart.fixture.invalid/being/?token=synthetic"));
	expect(product).not.toBeNull(); await product?.bind();
	const profile = JSON.parse(await readFile(path.join(root, "kit-portal-profile.json"), "utf8"));
	expect(profile.fragment).toContain("[kit_runtime.host_policy]"); expect(profile.fragment).not.toContain("native_targets");
	for (const name of ["kit-controller.json", "desktop-controller.json"]) await expect(readFile(path.join(root, name))).rejects.toMatchObject({ code: "ENOENT" });
	expect(boundary.calls.some(args => args.includes("bind-controller"))).toBe(true);
	expect(boundary.calls.some(args => args.includes("bind-desktop-controller"))).toBe(false);
});
it("retains existing owned Linux BC cleanup configuration byte-for-byte without rebinding it", async () => {
	const root = await fixture(); boundary.desktop = true; const platform = vi.spyOn(os, "platform").mockReturnValue("darwin");
	const link = parseConnection("https://heart.fixture.invalid/being/?token=synthetic");
	await bootstrapKitProduct(root, root, false, link);
	const prior = await Promise.all(["kit-controller.json", "desktop-controller.json"].map(name => readFile(path.join(root, name))));
	platform.mockReturnValue("linux"); boundary.desktop = false; boundary.calls.length = 0;
	const product = await bootstrapKitProduct(root, root, false, link); await product?.bind();
	for (const [index,name] of ["kit-controller.json", "desktop-controller.json"].entries()) expect(await readFile(path.join(root, name))).toEqual(prior[index]);
	expect(boundary.calls.some(args => args.includes("bind-desktop-controller"))).toBe(false);
	expect(JSON.parse(await readFile(path.join(root, "kit-portal-profile.json"), "utf8")).fragment).toContain("native_targets");
});
