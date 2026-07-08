/**
 * verify extension — independent adversarial verification (roadmap #4).
 *
 * Registers the `verify` tool (model-auto-invocable) and `/verify` command.
 * Spawns an isolated headless pi run with a read-only tool set + adversarial
 * prompt; the verifier re-derives a claim from source and returns a
 * structured verdict. See lib/spawn.ts for the isolation rationale.
 *
 * Configuration (env vars, for portability — matches memory/web extensions):
 *   PI_VERIFY_TIMEOUT          wall-clock cap in seconds (default 120)
 *   PI_VERIFY_COST_CAP_TOKENS  cumulative output-token cap (default 20000)
 *   PI_VERIFY_DISABLED         set to 1/true to disable the extension
 *   PI_VERIFY_SANDBOX          "auto" or a path to a sandbox-exec profile;
 *                              enables OS-level read-only-FS hardening (macOS,
 *                              experimental). Off by default.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerVerifyTool } from "./tools.ts";
import { registerVerifyCommand } from "./commands.ts";

export default function (pi: ExtensionAPI) {
	registerVerifyTool(pi);
	registerVerifyCommand(pi);
}
