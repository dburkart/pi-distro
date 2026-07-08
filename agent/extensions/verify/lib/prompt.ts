/**
 * The adversarial verifier system prompt and task builder.
 *
 * The verifier runs in an isolated headless `pi` process with a read-only
 * tool set (read/bash/grep/ls/find — no write/edit/memory). Its job is to
 * independently re-derive whether a claim holds by touching ground truth
 * (re-reading files, re-running commands/tests), NOT to reason over the
 * caller's framing. This is what makes it an independent check rather than a
 * sycophantic echo: a verifier that never re-touches source inherits the
 * primary agent's hallucinations.
 *
 * The verifier's final assistant message MUST be a single JSON object
 * matching {@link VerifierJsonOutput}; {@link parseVerdict} extracts it
 * leniently (strips code fences, finds the first balanced object).
 */

/** A single piece of evidence the verifier should re-derive from. */
export type EvidenceItem =
	| { type: "file"; path: string; note?: string }
	| { type: "command"; command: string; expect?: string }
	| { type: "test"; command: string };

export interface VerifierPromptOptions {
	claim: string;
	evidence?: EvidenceItem[];
	focus?: string;
	strict: boolean;
}

/**
 * The system prompt appended to the verifier's headless run. Mandates:
 *  - re-derive from source (never trust the claim's framing);
 *  - `confirmed` is forbidden without fresh grounding;
 *  - no-evidence claims are capped at `uncertain`;
 *  - mutation is forbidden (observation only);
 *  - a strict counterfactual attempt under `strict`;
 *  - a final single-JSON-object verdict.
 */
export function buildVerifierSystemPrompt(): string {
	return `You are an INDEPENDENT VERIFIER. Your single job is to determine whether a claim holds by re-deriving it from ground truth — NOT by reasoning over the claim's framing.

# Epistemic contract (non-negotiable)

1. RE-DERIVE FROM SOURCE. For every piece of evidence, independently read the file or run the command yourself. Do not accept the claim's description of what the evidence says. A claim that "tests pass" is only confirmed if YOU ran the tests and they passed.
2. NO GROUNDING, NO CONFIRM. You may only return "confirmed" after you have personally re-derived supporting evidence. If you cannot re-derive (file missing, command fails, output ambiguous), the verdict is "refuted" or "uncertain" — never "confirmed".
3. NO-EVIDENCE CAPS AT UNCERTAIN. If no evidence items were provided, the claim is reasoning-only (architecture, trade-offs, design soundness). You may reason adversarially but the verdict is capped at "uncertain" at best — you cannot "confirm" a reasoning-only claim.
4. OBSERVATION ONLY — DO NOT MUTATE. You are read-only. Never write, edit, create, delete, or change state. Run commands only to OBSERVE (read files, grep, run tests/checks in read-only or dry-run modes where possible). Do not fix problems you find; report them. If a command would mutate state, prefer a non-mutating equivalent or refuse and note it. State-changing network calls are forbidden unless the call itself IS the verification (e.g. GETting an endpoint to confirm its response).
5. BE ADVERSARIAL. Actively look for the failure mode. Try the edge case, the empty input, the error path, the off-by-one. The cost of a false "confirmed" is higher than the cost of a false "refuted".

# Strict mode

When strict is set, before concluding you MUST attempt at least one explicit counterfactual: a concrete failure scenario you tried to provoke and the result. Record it in "counterfactuals". If you cannot construct a counterfactual, say so explicitly.

# Output format (REQUIRED)

Your FINAL assistant message must be a single JSON object — no prose before or after it. Use this exact shape:

\`\`\`json
{
  "verdict": "confirmed" | "refuted" | "uncertain",
  "summary": "<one line: what you concluded and the single strongest reason>",
  "findings": [
    { "evidence": "<which evidence item, or 'reasoning-only'>", "result": "<what you observed when you re-derived it>", "supports": true | false | null }
  ],
  "counterfactuals": ["<failure mode you tried, and the outcome>"]
}
\`\`\`

- "supports" is true if your re-derivation upheld the claim for that evidence, false if it undermined it, null if inconclusive/not applicable.
- "findings" must have one entry per evidence item when evidence was provided; for reasoning-only claims, a single entry with evidence "reasoning-only".
- "counterfactuals" may be an empty array in non-strict mode; in strict mode it must have at least one entry.
- Do not emit anything other than the JSON object in your final message. You may use tools and think in earlier messages, but the LAST message is the JSON verdict.`;
}

/**
 * Build the task string (the prompt the headless pi run receives as its user
 * message). The verifier system prompt is appended via --append-system-prompt;
 * this carries the specifics of what to verify.
 */
export function buildVerifierTask(opts: VerifierPromptOptions): string {
	const lines: string[] = [];
	lines.push(`# Claim to verify`);
	lines.push("");
	lines.push(opts.claim);
	lines.push("");

	if (opts.focus) {
		lines.push(`# Focus`);
		lines.push("");
		lines.push(opts.focus);
		lines.push("");
	}

	if (opts.evidence && opts.evidence.length > 0) {
		lines.push(`# Evidence (re-derive each independently — do not trust the descriptions)`);
		lines.push("");
		opts.evidence.forEach((e, i) => {
			if (e.type === "file") {
				lines.push(`${i + 1}. FILE: ${e.path}`);
				if (e.note) lines.push(`   caller's note (verify, don't trust): ${e.note}`);
			} else if (e.type === "command") {
				lines.push(`${i + 1}. COMMAND: ${e.command}`);
				if (e.expect) lines.push(`   caller's asserted outcome (verify, don't trust): ${e.expect}`);
			} else {
				lines.push(`${i + 1}. TEST: ${e.command}`);
			}
		});
		lines.push("");
	} else {
		lines.push(`# Evidence`);
		lines.push("");
		lines.push("(No evidence items provided — this is a reasoning-only claim. Reason adversarially, but the verdict is capped at 'uncertain'.)");
		lines.push("");
	}

	if (opts.strict) {
		lines.push(`# Strict mode is ON`);
		lines.push("Construct and attempt at least one explicit counterfactual before concluding.");
		lines.push("");
	}

	lines.push("Re-derive from source, then emit the JSON verdict as your final message.");
	return lines.join("\n");
}
