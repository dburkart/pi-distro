# Web Search & Fetch Extension

`agent/extensions/web/` provides two LLM-callable tools:

- **`web_search`** — query a pluggable search backend, get back normalized
  hits (title, URL, description).
- **`web_fetch`** — fetch an `http(s)` URL and return its text, with HTML
  converted to plain text and output truncated to fit the context window.

## Tools

### `web_search`

| Param    | Type     | Description                                            |
|----------|----------|--------------------------------------------------------|
| `query`  | string   | Search query (required)                                |
| `count`  | integer  | Max results to return (optional, backend-specific)    |
| `backend`| string   | Override the active search backend (optional)          |

Returns a numbered list of `title / url / description` lines.

### `web_fetch`

| Param | Type   | Description                          |
|-------|--------|--------------------------------------|
| `url` | string | Absolute `http(s)` URL (required)    |

Returns the page title, final URL, and body text. When the body exceeds the
built-in truncation limits (2000 lines or 50KB), the full text is saved to a
temp file and the path is noted so the agent can `read` it for more.

## Configuration

All configuration is environment-variable based, so the extension is portable
across users and machines with no shared state files:

| Env var                   | Default     | Purpose                                            |
|---------------------------|-------------|----------------------------------------------------|
| `PI_WEB_SEARCH_BACKEND`  | `marginalia`| Active search backend name                         |
| `PI_WEB_FETCH_TIMEOUT`   | `30000`     | `web_fetch` timeout in milliseconds                |
| `PI_WEB_FETCH_MAX_BYTES` | `2000000`   | Hard cap on fetched body size (before text conv.)  |
| `MARGINALIA_API_KEY`     | `public`    | API key for the Marginalia backend                 |

`web_search` also accepts a per-call `backend` argument that overrides
`PI_WEB_SEARCH_BACKEND` for that one call.

## Pluggable Search Backends

Backends implement the `SearchBackend` interface in `types.ts`:

```typescript
interface SearchBackend {
  readonly name: string;
  search(query: string, options?: SearchOptions): Promise<SearchHit[]>;
}
```

To add a backend:

1. Implement `SearchBackend` in a new file under `backends/` (e.g.
   `backends/mojeek.ts`).
2. Register it in the `backends` map in `backends/registry.ts`.
3. Select it via `PI_WEB_SEARCH_BACKEND=<name>` or the per-call `backend`
   argument.

The registry is the single place that ties a backend name to its
implementation, so adding a backend is a one-line registration with no changes
to the tools themselves.

### Marginalia backend

Uses the new `api2.marginalia-search.com` endpoint. The API key is sent in the
`API-Key` header; when `MARGINALIA_API_KEY` is unset the documented `public`
key is used (rate-limited). The `count` parameter is clamped to Marginalia's
1–100 range.

Docs: <https://about.marginalia-search.com/article/api/>

## Design Notes

- **HTML to text** (`lib/html.ts`) is a small, dependency-free converter:
  drops `script`/`style`/`noscript`/`template`/`svg`/`head`, turns block tags
  into newlines, strips remaining tags, decodes common entities, and collapses
  whitespace. It is good enough for reading articles/docs; swap in a real
  library (`@mozilla/readability` + `turndown`) if richer extraction is needed.
- **Output truncation** uses pi's built-in `truncateHead` / `DEFAULT_MAX_*`
  utilities and saves full output to a temp file when truncated, matching the
  convention built-in tools follow.
- **Fetch safety**: only `http(s)` URLs; respects the agent's abort `signal`
  (so cancellation/timeout work mid-fetch); a hard byte cap prevents huge pages
  from exhausting memory before text conversion.

## File Layout

```
agent/extensions/web/
├── index.ts                 factory: registers the tools
├── tools.ts                 web_search + web_fetch tool definitions
├── config.ts                env-var based configuration
├── types.ts                 shared SearchBackend / SearchHit types
├── backends/
│   ├── registry.ts          name -> SearchBackend map
│   └── marginalia.ts        Marginalia search backend
└── lib/
    ├── html.ts              HTML -> plain text (dependency-free)
    └── fetch.ts             HTTP fetch + HTML conversion
```
