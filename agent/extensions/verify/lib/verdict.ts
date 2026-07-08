/**
 * Verdict types and parsing.
 *
 * The headless verifier run emits a JSON transcript (pi --mode json). Its
 * final assistant message must be a single JSON object matching
 * {@link VerifierJsonOutput}. {@link parseVerdict} extracts it leniently
 * (strips code fences, finds the first balanced object) and validates the
 * verdict against the allowed enum.
 *
 * Operational failures (timeout, cost cap, non-zero exit, parse failure) are
 * kept OUT of the verdict enum — they produce a distinct {@link VerifierError}
 * state. Conflating "the verifier couldn't run" with "the verifier ran and
 * was uncertain" would invite a sycophancy trap ("verifier failed → claim is
 * probably fine"). Errors render to the primary model as "unverified — do
 * not treat as confirmation".
 */

/** The three epistemic verdicts. Operational failures are NOT here. */
export type Verdict = "confirmed" | "refuted" | "uncertain";

export interface Finding {
	evidence: string;
	result: string;
	supports: boolean | null;
}

/** The JSON shape the verifier is instructed to emit as its final message. */
export interface VerifierJsonOutput {
	verdict: string;
	summary: string;
	findings: Finding[];
	counterfactuals: string[];
}

/** Operational failure state — distinct from the epistemic verdict. */
export interface VerifierError {
	reason: "timeout" | "cost_cap" | "aborted" | "exit_nonzero" | "parse" | "spawn";
	message: string;
}

/** Accumulated token usage from the headless run's assistant messages. */
export interface VerifierUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

/** The parsed result handed back to the verify tool. */
export interface VerifierResult {
	/** Present only when the verifier ran and produced a valid verdict. */
	verdict?: Verdict;
	summary: string;
	findings: Finding[];
	counterfactuals: string[];
	usage: VerifierUsage;
	/** The verifier's final raw text (for debugging / details). */
	rawOutput: string;
	/** Present when the run failed operationally (no verdict). */
	error?: VerifierError;
	model?: string;
}

const VERDICTS: ReadonlySet<string> = new Set(["confirmed", "refuted", "uncertain"]);

/**
 * Extract the first balanced JSON object from text, tolerating leading/trailing
 * prose and ```json fences. Returns null if none parses.
 */
export function extractJsonObject(text: string): unknown | null {
	if (!text) return null;
	let s = text.trim();

	// Strip a leading code fence.
	const fence = s.match(/^```(?:json)?\s*/i);
	if (fence) s = s.slice(fence[0].length);
	s = s.replace(/```\s*$/i, "").trim();

	// Fast path: already valid JSON.
	const fast = tryParse(s);
	if (fast !== undefined) return fast;

	// Slow path: find the first balanced {...} span.
	let depth = 0;
	let start = -1;
	let inStr = false;
	let esc = false;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (inStr) {
			if (esc) esc = false;
			else if (ch === "\\") esc = true;
			else if (ch === '"') inStr = false;
			continue;
		}
		if (ch === '"') {
			inStr = true;
			continue;
		}
		if (ch === "{") {
			if (depth === 0) start = i;
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0 && start >= 0) {
				const candidate = s.slice(start, i + 1);
				const parsed = tryParse(candidate);
				if (parsed !== undefined) return parsed;
				start = -1;
			}
		}
	}
	return null;
}

function tryParse(s: string): unknown | undefined {
	try {
		return JSON.parse(s);
	} catch {
		return undefined;
	}
}

/**
 * Validate and normalize a parsed object into a {@link VerifierResult}.
 * Returns null if the verdict is missing or not in the allowed enum (caller
 * treats that as a parse error).
 */
export function normalizeVerdict(parsed: unknown, usage: VerifierUsage, rawOutput: string, model?: string): VerifierResult | null {
	if (typeof parsed !== "object" || parsed === null) return null;
	const o = parsed as Record<string, unknown>;
	const v = typeof o.verdict === "string" ? o.verdict : "";
	if (!VERDICTS.has(v)) return null;

	const findings: Finding[] = Array.isArray(o.findings)
		? (o.findings as unknown[])
				.map((f) => normalizeFinding(f))
				.filter((f): f is Finding => f !== null)
		: [];

	const counterfactuals: string[] = Array.isArray(o.counterfactuals)
		? (o.counterfactuals as unknown[]).filter((x): x is string => typeof x === "string")
		: [];

	return {
		verdict: v as Verdict,
		summary: typeof o.summary === "string" ? o.summary : "",
		findings,
		counterfactuals,
		usage,
		rawOutput,
		model,
	};
}

function normalizeFinding(f: unknown): Finding | null {
	if (typeof f !== "object" || f === null) return null;
	const o = f as Record<string, unknown>;
	const supports = o.supports;
	return {
		evidence: typeof o.evidence === "string" ? o.evidence : "",
		result: typeof o.result === "string" ? o.result : "",
		supports: supports === true || supports === false || supports === null ? supports : null,
	};
}

export function emptyUsage(): VerifierUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}
