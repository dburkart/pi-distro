import type { SearchBackend } from "../types.ts";
import { marginaliaBackend } from "./marginalia.ts";

/**
 * Registry of available search backends.
 *
 * To add a backend: implement {@link SearchBackend} in a new file under
 * `backends/`, then add it to the map below. It becomes selectable via the
 * `PI_WEB_SEARCH_BACKEND` env var or the per-call `backend` tool argument.
 */
const backends: Record<string, SearchBackend> = {
	marginalia: marginaliaBackend,
};

export function getSearchBackend(name: string): SearchBackend {
	const backend = backends[name.toLowerCase()];
	if (!backend) {
		throw new Error(
			`Unknown web search backend "${name}". Known backends: ${listSearchBackends().join(", ")}.`,
		);
	}
	return backend;
}

export function listSearchBackends(): string[] {
	return Object.keys(backends);
}
