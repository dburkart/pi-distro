/**
 * Normalized types shared across search backends.
 */

/** A single search hit, normalized across backends. */
export interface SearchHit {
	title: string;
	url: string;
	description?: string;
}

export interface SearchOptions {
	count?: number;
	signal?: AbortSignal;
}

/**
 * A pluggable search backend.
 *
 * Backends normalize vendor-specific response shapes into {@link SearchHit}.
 * Add a new backend by implementing this interface and registering it in
 * `backends/registry.ts`.
 */
export interface SearchBackend {
	readonly name: string;
	search(query: string, options?: SearchOptions): Promise<SearchHit[]>;
}
