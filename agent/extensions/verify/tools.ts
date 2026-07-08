/**
 * The `verify` tool — an independent, adversarial verifier.
 *
 * Spawns an isolated headless pi run that re-derives whether a claim holds
 * from ground truth (re-reading files, re-running commands/tests) and returns
 * a structured verdict. See lib/spawn.ts for why spawn (not ctx.newSession).
 *
 * The tool is model-auto-invocable (primary — passive sycophancy catch) AND
 * available as the /verify command. The description carries positive +
 * exclusion signals to bound auto-firing: fire after risky/high-stakes work
 * or when a claim's correctness is load-bearing; NOT for trivial edits or
 * routine reads.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { loadVerifierConfig, runVerifier } from "./lib/spawn.ts";
import type { VerifierResult, VerifierUsage } from "./lib/verdict.ts";
import type { EvidenceItem } from "./lib/prompt.ts";

const EvidenceItem = Type.Object({
	type: StringEnum(["file", "command", "test"] as const, {
		description: "'file' = read & judge; 'command' = run & check; 'test' = run, pass/fail is the claim.",
	}),
	path: Type.Optional(Type.String({ description: "Path for type 'file'." })),
	command: Type.Optional(Type.String({ description: "Shell command for 'command'/'test'." })),
	note: Type.Optional(Type.String({ description: "Caller's note about a file (verify, don't trust)." })),
	expect: Type.Optional(Type.String({ description: "Caller's asserted command outcome (verify, don't trust)." })),
});

export function registerVerifyTool(pi: ExtensionAPI): void {
	const config = loadVerifierConfig();

	const verify = defineTool({
		name: "verify",
		label: "Verify",
		description: [
			"Independently verify a claim by spawning an isolated adversarial verifier that re-derives it from source (re-reads files, re-runs commands/tests) and returns a verdict: confirmed, refuted, or uncertain.",
			"Use after risky or high-stakes work — multi-file refactors, security/auth changes, correctness claims, 'is this done/correct?' moments — or whenever a claim's correctness is load-bearing.",
			"Do NOT use for trivial edits, routine reads, or claims you can check with a single bash/read call yourself. The verifier is a full isolated agent run; it costs tokens and latency, so reserve it for claims worth an independent check.",
			"Provide 'evidence' (file paths, commands, test commands) so the verifier can re-derive; without evidence the claim is reasoning-only and the verdict is capped at 'uncertain'.",
		].join(" "),
		promptSnippet: "Independently verify a claim by re-deriving it from source",
		promptGuidelines: [
			"Use verify when a claim's correctness is load-bearing and worth an independent check — after risky changes, security/auth work, or 'is this done/correct?' moments. Not for trivial edits.",
			"Always supply evidence (file paths, commands, tests) when available; a reasoning-only verify is capped at 'uncertain'.",
			"Treat a 'refuted' or 'uncertain' verdict as a signal to revisit the claim or evidence — the verifier re-derived from source rather than trusting your framing. Treat an 'error' verdict as 'no verification happened', never as confirmation.",
		],
		parameters: Type.Object({
			claim: Type.String({
				description: "The assertion to verify, stated plainly. e.g. 'expired tokens are rejected by the auth middleware' or 'the test suite passes'.",
			}),
			evidence: Type.Optional(
				Type.Array(EvidenceItem, {
					description: "Pointers the verifier must re-derive from (it executes/reads them — it does NOT trust the descriptions).",
				}),
			),
			focus: Type.Optional(
				Type.String({ description: "A specific lens/concern, e.g. 'race conditions' or 'error paths'. Shapes the adversarial check." }),
			),
			strict: Type.Optional(
				Type.Boolean({
					description: "When true, the verifier must attempt at least one explicit counterfactual before concluding. Default false.",
				}),
			),
		}),

		async execute(_id, params, signal, onUpdate, ctx) {
			if (config.disabled) {
				return {
					content: [{ type: "text", text: "verify extension is disabled (PI_VERIFY_DISABLED)." }],
					details: { disabled: true },
				};
			}

			const result = await runVerifier(
				{
					claim: params.claim,
					evidence: (params.evidence as unknown as EvidenceItem[] | undefined) ?? undefined,
					focus: params.focus,
					strict: params.strict ?? false,
					cwd: ctx.cwd,
					signal: signal ?? undefined,
					onUpdate: onUpdate
						? (partial) => {
								onUpdate({
									content: [{ type: "text", text: renderContent(partial) || "(verifier running...)" }],
									details: partial,
								});
							}
						: undefined,
				},
				config,
			);

			return {
				content: [{ type: "text", text: renderContent(result) }],
				details: result,
			};
		},

		renderCall(args, theme, _ctx) {
			let text = theme.fg("toolTitle", theme.bold("verify "));
			const preview = args.claim && args.claim.length > 60 ? `${args.claim.slice(0, 60)}...` : args.claim;
			text += theme.fg("accent", `"${preview}"`);
			if (args.strict) text += theme.fg("warning", " [strict]");
			return new Text(text, 0, 0);
		},

		renderResult(result, { isPartial }, theme, _ctx) {
			if (isPartial) return new Text(theme.fg("warning", "verifying..."), 0, 0);
			const details = result.details as VerifierResult | undefined;
			if (!details) return new Text(theme.fg("dim", "(no result)"), 0, 0);
			if (details.error) return new Text(theme.fg("warning", `⚠ ${details.error.reason}`), 0, 0);
			const v = details.verdict;
			const label = v === "confirmed"
				? theme.fg("success", `✓ ${v}`)
				: v === "refuted"
					? theme.fg("error", `✗ ${v}`)
					: theme.fg("warning", `? ${v ?? "(no verdict)"}`);
			return new Text(label, 0, 0);
		},
	});

	pi.registerTool(verify);
}

/** Compact text the primary model sees (full transcript stays in `details`). */
export function renderContent(r: VerifierResult): string {
	if (r.error) {
		return [
			`⚠ Verifier did not complete: ${r.error.reason} — ${r.error.message}`,
			"",
			"The claim is UNVERIFIED. Do not treat this as confirmation (or refutation).",
			...usageLines(r.usage),
		].join("\n");
	}

	const v = r.verdict ?? "uncertain";
	const lines: string[] = [];
	const flag = v === "confirmed" ? "✓" : v === "refuted" ? "✗" : "?";
	lines.push(`${flag} Verdict: ${v.toUpperCase()}`);
	if (r.summary) lines.push(`summary: ${r.summary}`);

	if (r.findings.length > 0) {
		lines.push("", "findings:");
		for (const f of r.findings) {
			const mark = f.supports === true ? "+" : f.supports === false ? "-" : "?";
			lines.push(`  ${mark} ${f.evidence}`);
			if (f.result) lines.push(`      ${f.result.replace(/\n+/g, " ").slice(0, 300)}`);
		}
	}
	if (r.counterfactuals.length > 0) {
		lines.push("", "counterfactuals:");
		for (const c of r.counterfactuals) lines.push(`  - ${c.replace(/\n+/g, " ").slice(0, 200)}`);
	}

	// Mild nudge on non-confirmed verdicts (overcomes sycophancy).
	if (v === "refuted") {
		lines.push("", "⚠ Claim REFUTED by independent re-derivation — revisit the claim or evidence.");
	} else if (v === "uncertain") {
		lines.push("", "⚠ Claim could not be confirmed — treat as uncertain, do not assume it holds.");
	}

	lines.push("", ...usageLines(r.usage));
	return lines.join("\n");
}

function usageLines(u: VerifierUsage): string[] {
	const parts: string[] = [];
	if (u.turns) parts.push(`${u.turns} turn${u.turns > 1 ? "s" : ""}`);
	if (u.input) parts.push(`↑${fmt(u.input)}`);
	if (u.output) parts.push(`↓${fmt(u.output)}`);
	if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
	if (parts.length === 0) return [];
	return [`(${parts.join(" ")})`];
}

function fmt(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}
