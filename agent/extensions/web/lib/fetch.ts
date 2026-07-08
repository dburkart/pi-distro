import type { WebConfig } from "../config.ts";
import { htmlToText, extractTitle } from "./html.ts";

export interface FetchResult {
	/** Final URL after redirects. */
	url: string;
	/** Response Content-Type (lower-cased). */
	contentType: string;
	/** Page title extracted from <title>, for HTML responses. */
	title?: string;
	/** Body text (HTML converted to plain text for HTML responses). */
	text: string;
}

const USER_AGENT =
	"Mozilla/5.0 (compatible; pi-web-extension/1.0; +https://github.com/earendil-works/pi)";

/** Combine an optional parent signal with a timeout, returning a usable signal. */
function withTimeout(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal | undefined {
	if (!parent) return AbortSignal.timeout(timeoutMs);
	if (typeof (AbortSignal as unknown as { any?: unknown }).any === "function") {
		return (AbortSignal as unknown as {
			any: (signals: AbortSignal[]) => AbortSignal;
		}).any([parent, AbortSignal.timeout(timeoutMs)]);
	}
	// Fallback for older runtimes: abort a controller when either source aborts.
	const ctrl = new AbortController();
	const fail = () => ctrl.abort();
	if (parent.aborted) ctrl.abort();
	else parent.addEventListener("abort", fail, { once: true });
	const t = setTimeout(() => ctrl.abort(), timeoutMs);
	ctrl.signal.addEventListener("abort", () => clearTimeout(t), { once: true });
	return ctrl.signal;
}

/**
 * Fetch a URL and return its text content. HTML responses are converted to
 * plain text. Only http(s) URLs are supported.
 */
export async function webFetch(
	url: string,
	config: WebConfig,
	parentSignal?: AbortSignal,
): Promise<FetchResult> {
	if (!/^https?:\/\//i.test(url)) {
		throw new Error(`web_fetch only supports http(s) URLs, got: ${url}`);
	}

	const signal = withTimeout(parentSignal, config.fetchTimeoutMs);
	let rsp: Response;
	try {
		rsp = await fetch(url, {
			redirect: "follow",
			signal,
			headers: {
				"User-Agent": USER_AGENT,
				Accept: "text/html,application/xhtml+xml,text/plain,*/*;q=0.8",
			},
		});
	} catch (err) {
		throw new Error(`Fetch failed for ${url}: ${(err as Error).message}`);
	}

	if (!rsp.ok) {
		throw new Error(`Fetch failed for ${url} (HTTP ${rsp.status} ${rsp.statusText})`);
	}

	const contentType = (rsp.headers.get("content-type") ?? "application/octet-stream").toLowerCase();
	const isHtml = contentType.includes("html");

	// Read with a hard size cap so a huge page can't exhaust memory.
	const reader = rsp.body?.getReader();
	const decoder = new TextDecoder();
	let raw = "";
	if (reader) {
		let size = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) {
				size += value.byteLength;
				if (size > config.fetchMaxBytes) {
					raw += decoder.decode(value.subarray(0, config.fetchMaxBytes - (size - value.byteLength)));
					break;
				}
				raw += decoder.decode(value, { stream: true });
			}
		}
		raw += decoder.decode();
	} else {
		raw = await rsp.text();
		if (raw.length > config.fetchMaxBytes) raw = raw.slice(0, config.fetchMaxBytes);
	}

	const title = isHtml ? extractTitle(raw) : undefined;
	const text = isHtml ? htmlToText(raw) : raw;

	return {
		url: rsp.url || url,
		contentType,
		title,
		text,
	};
}
