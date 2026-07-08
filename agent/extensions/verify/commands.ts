/**
 * `/verify` command — manual entry to scope a verification.
 *
 * The tool is auto-invocable (primary); this command gives the user an
 * explicit, discoverable trigger and a place to type out a claim + evidence
 * interactively. It runs the same spawn path as the tool.
 *
 * Usage:
 *   /verify <claim>
 *
 * Evidence/focus/strict are gathered via prompts (or omitted). For a quick
 * claim-only verify, just pass it inline.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { loadVerifierConfig, runVerifier } from "./lib/spawn.ts";
import { renderContent as renderVerifierContent } from "./tools.ts";
import type { VerifierResult } from "./lib/verdict.ts";

export function registerVerifyCommand(pi: ExtensionAPI): void {
	pi.registerCommand("verify", {
		description: "Independently verify a claim by spawning an isolated adversarial verifier.",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const config = loadVerifierConfig();
			if (config.disabled) {
				ctx.ui.notify("verify extension is disabled (PI_VERIFY_DISABLED).", "warning");
				return;
			}

			let claim = args.trim();
			if (!claim) {
				const input = await ctx.ui.input("Claim to verify:");
				if (!input) return;
				claim = input.trim();
			}
			if (!claim) return;

			// Gather optional evidence interactively. Keep it lightweight.
			const evidenceRaw = await ctx.ui.input("Evidence (optional): file paths or commands, comma- or newline-separated. Leave empty for reasoning-only:");
			const evidence = parseEvidence(evidenceRaw);

			const focus = await ctx.ui.input("Focus (optional, e.g. 'error paths'):");
			const strict = await ctx.ui.confirm("Strict mode", "Attempt explicit counterfactuals?");

			ctx.ui.setStatus("verify", "verifying...");

			const result: VerifierResult = await runVerifier(
				{ claim, evidence, focus: focus || undefined, strict, cwd: ctx.cwd },
				config,
			);

			ctx.ui.setStatus("verify", undefined);

			// Notify the verdict, and surface the full rendered text via notify
			// so the user sees findings/counterfactuals without re-running.
			if (result.error) {
				ctx.ui.notify(`verify failed: ${result.error.reason} — ${result.error.message}`, "warning");
			} else {
				const v = result.verdict;
				const level = v === "confirmed" ? "info" : "warning";
				ctx.ui.notify(`verify: ${v?.toUpperCase()} — ${result.summary}`, level);
			}
			ctx.ui.notify(renderVerifierContent(result), "info");
		},
	});
}

type EvidenceItem =
	| { type: "file"; path: string; note?: string }
	| { type: "command"; command: string; expect?: string }
	| { type: "test"; command: string };

/** Parse a freeform evidence string into typed items. */
function parseEvidence(raw: string | undefined): EvidenceItem[] | undefined {
	if (!raw || !raw.trim()) return undefined;
	const tokens = raw
		.split(/[\n,]/)
		.map((s) => s.trim())
		.filter(Boolean);
	const items: EvidenceItem[] = [];
	for (const t of tokens) {
		// Heuristic: looks like a test command if it starts with common test runners.
		const isTest = /^(npm|yarn|pnpm|bun|pytest|cargo|go|make)\s+(test|ci)/.test(t) || /\btest\b/.test(t);
		// Looks like a command if it has shell metacharacters or starts with a known binary.
		const isCommand = /[\s|&;><$]/.test(t) && !t.startsWith("/");
		if (isTest) items.push({ type: "test", command: t });
		else if (isCommand) items.push({ type: "command", command: t });
		else items.push({ type: "file", path: t });
	}
	return items.length > 0 ? items : undefined;
}
