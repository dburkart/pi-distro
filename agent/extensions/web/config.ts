/**
 * Extension configuration, read entirely from environment variables so the
 * extension is portable across users and machines with no shared state files.
 */

export interface WebConfig {
	/** Active search backend name (lower-cased). */
	searchBackend: string;
	/** web_fetch timeout in milliseconds. */
	fetchTimeoutMs: number;
	/** Hard cap on fetched body size in bytes (before text conversion). */
	fetchMaxBytes: number;
}

export function loadConfig(): WebConfig {
	return {
		searchBackend: (process.env.PI_WEB_SEARCH_BACKEND ?? "marginalia").toLowerCase(),
		fetchTimeoutMs: Number(process.env.PI_WEB_FETCH_TIMEOUT ?? 30_000),
		fetchMaxBytes: Number(process.env.PI_WEB_FETCH_MAX_BYTES ?? 2_000_000),
	};
}
