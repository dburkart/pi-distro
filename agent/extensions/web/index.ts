/**
 * Pluggable web search & web fetch tools.
 *
 * Tools registered:
 *   - web_search   query a configurable search backend, get back hits
 *   - web_fetch    fetch a URL and return its text (HTML stripped to text)
 *
 * Search backends are pluggable: implement the {@link SearchBackend} interface,
 * register it in `backends/registry.ts`, and select it via the
 * `PI_WEB_SEARCH_BACKEND` env var (or the per-call `backend` tool argument).
 *
 * Configuration is entirely environment-variable based so the extension is
 * portable across users and machines with no shared state files:
 *
 *   PI_WEB_SEARCH_BACKEND  active search backend (default: "marginalia")
 *   PI_WEB_FETCH_TIMEOUT   web_fetch timeout in ms (default: 30000)
 *   PI_WEB_FETCH_MAX_BYTES hard cap on fetched body size in bytes (default: 2MB)
 *   MARGINALIA_API_KEY     API key for the marginalia backend (default: "public")
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWebTools } from "./tools.ts";

export default function (pi: ExtensionAPI) {
	registerWebTools(pi);
}
