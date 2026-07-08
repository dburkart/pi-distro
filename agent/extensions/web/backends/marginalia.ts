import type { SearchBackend, SearchHit, SearchOptions } from "../types.ts";

const ENDPOINT = "https://api2.marginalia-search.com/search";

function apiKey(): string {
	return process.env.MARGINALIA_API_KEY ?? "public";
}

interface MarginaliaResult {
	url?: string;
	title?: string;
	description?: string;
}

interface MarginaliaResponse {
	results?: MarginaliaResult[];
}

/**
 * Marginalia Search backend.
 *
 * Uses the new api2.marginalia-search.com endpoint. The API key is sent in the
 * `API-Key` header; the `public` key is used when MARGINALIA_API_KEY is unset.
 *
 * Docs: https://about.marginalia-search.com/article/api/
 */
export const marginaliaBackend: SearchBackend = {
	name: "marginalia",

	async search(query: string, options?: SearchOptions): Promise<SearchHit[]> {
		const params = new URLSearchParams({ query });
		if (options?.count) {
			// Marginalia accepts count in 1..100
			params.set("count", String(Math.min(100, Math.max(1, options.count))));
		}

		const url = `${ENDPOINT}?${params.toString()}`;
		let rsp: Response;
		try {
			rsp = await fetch(url, {
				method: "GET",
				headers: { "API-Key": apiKey() },
				signal: options?.signal,
			});
		} catch (err) {
			throw new Error(`Marginalia search request failed: ${(err as Error).message}`);
		}

		if (!rsp.ok) {
			throw new Error(
				`Marginalia search failed (HTTP ${rsp.status} ${rsp.statusText}): ${await safeText(rsp)}`,
			);
		}

		const data = (await rsp.json()) as MarginaliaResponse;
		return (data.results ?? []).map((r) => ({
			title: r.title ?? r.url ?? "(untitled)",
			url: r.url ?? "",
			description: r.description,
		}));
	},
};

async function safeText(rsp: Response): Promise<string> {
	try {
		return (await rsp.text()).slice(0, 500);
	} catch {
		return "";
	}
}
