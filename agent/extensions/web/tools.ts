/**
 * Registers the `web_search` and `web_fetch` tools.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineTool,
	formatSize,
	type ExtensionAPI,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { loadConfig } from "./config.ts";
import { getSearchBackend, listSearchBackends } from "./backends/registry.ts";
import { webFetch } from "./lib/fetch.ts";

interface SearchDetails {
	query: string;
	backend: string;
	count: number;
}

interface FetchDetails {
	url: string;
	contentType: string;
	title?: string;
	truncated?: boolean;
	fullOutputPath?: string;
}

export function registerWebTools(pi: ExtensionAPI) {
	const config = loadConfig();
	const knownBackends = listSearchBackends().join(", ");

	// ---- web_search -------------------------------------------------------
	const webSearch = defineTool({
		name: "web_search",
		label: "Web Search",
		description:
			`Search the web for current information. Returns a list of results ` +
			`(title, URL, short description). Active backend: "${config.searchBackend}" ` +
			`(available: ${knownBackends}). Follow up with web_fetch to read a page.`,
		promptSnippet: "Search the web for current information",
		promptGuidelines: [
			"Use web_search when you need current information or URLs you don't already know, then use web_fetch to read a specific result page.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			count: Type.Optional(
				Type.Integer({ description: "Max number of results to return" }),
			),
			backend: Type.Optional(
				Type.String({
					description: `Override the search backend (one of: ${knownBackends})`,
				}),
			),
		}),

		async execute(_id, params, signal, _onUpdate, _ctx) {
			const backendName = (params.backend ?? config.searchBackend).toLowerCase();
			const backend = getSearchBackend(backendName);

			const hits = await backend.search(params.query, {
				count: params.count,
				signal: signal ?? undefined,
			});

			if (hits.length === 0) {
				return {
					content: [{ type: "text", text: `No results for "${params.query}".` }],
					details: {
						query: params.query,
						backend: backend.name,
						count: 0,
					} satisfies SearchDetails,
				};
			}

			const lines: string[] = [];
			hits.forEach((h, i) => {
				lines.push(`${i + 1}. ${h.title}`);
				lines.push(`   ${h.url}`);
				if (h.description) lines.push(`   ${h.description}`);
				lines.push("");
			});

			return {
				content: [{ type: "text", text: lines.join("\n").trimEnd() }],
				details: {
					query: params.query,
					backend: backend.name,
					count: hits.length,
				} satisfies SearchDetails,
			};
		},

		renderCall(args, theme, _ctx) {
			let text = theme.fg("toolTitle", theme.bold("web_search "));
			text += theme.fg("accent", `"${args.query}"`);
			if (args.backend) text += theme.fg("muted", ` [${args.backend}]`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { isPartial }, theme, _ctx) {
			if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);
			const details = result.details as SearchDetails | undefined;
			if (!details || details.count === 0) {
				return new Text(theme.fg("dim", "No results"), 0, 0);
			}
			return new Text(
				theme.fg("success", `${details.count} results`) +
					theme.fg("muted", ` via ${details.backend}`),
				0,
				0,
			);
		},
	});

	// ---- web_fetch --------------------------------------------------------
	const webFetchTool = defineTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			`Fetch a URL and return its text content. HTML pages are converted to ` +
			`plain text. Output is truncated to ${DEFAULT_MAX_LINES} lines or ` +
			`${formatSize(DEFAULT_MAX_BYTES)} (whichever is first); full output is saved ` +
			`to a temp file when truncated. Only http(s) URLs are supported.`,
		promptSnippet: "Fetch a URL and read its text content",
		parameters: Type.Object({
			url: Type.String({ description: "Absolute http(s) URL to fetch" }),
		}),

		async execute(_id, params, signal, _onUpdate, _ctx) {
			const result = await webFetch(params.url, config, signal ?? undefined);

			const truncation = truncateHead(result.text, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			const details: FetchDetails = {
				url: result.url,
				contentType: result.contentType,
				title: result.title,
			};

			let text = truncation.content;
			if (truncation.truncated) {
				const tempDir = await mkdtemp(join(tmpdir(), "pi-web-"));
				const tempFile = join(tempDir, "page.txt");
				await writeFile(tempFile, result.text, "utf8");
				details.truncated = true;
				details.fullOutputPath = tempFile;
				text +=
					`\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines ` +
					`(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ` +
					`Full output saved to: ${tempFile}]`;
			}

			const header = result.title
				? `${result.title}\n${result.url}\n\n`
				: `${result.url}\n\n`;

			return {
				content: [{ type: "text", text: header + text }],
				details,
			};
		},

		renderCall(args, theme, _ctx) {
			let text = theme.fg("toolTitle", theme.bold("web_fetch "));
			text += theme.fg("accent", args.url);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _ctx) {
			if (isPartial) return new Text(theme.fg("warning", "Fetching..."), 0, 0);
			const details = result.details as FetchDetails | undefined;
			if (!details) return new Text("", 0, 0);

			let text = theme.fg("success", "fetched");
			text += theme.fg("muted", ` ${details.contentType}`);
			if (details.truncated) text += theme.fg("warning", " (truncated)");
			if (expanded && details.title) {
				text += `\n${theme.fg("dim", details.title)}`;
			}
			return new Text(text, 0, 0);
		},
	});

	pi.registerTool(webSearch);
	pi.registerTool(webFetchTool);
}
