/**
 * Minimal, dependency-free HTML to plain-text conversion.
 *
 * This is intentionally lightweight — good enough for the agent to read article
 * and documentation pages, without pulling in a full HTML parser. It:
 *   - drops <script>/<style>/<noscript>/<template> contents
 *   - turns block-level tags into line breaks
 *   - strips remaining tags
 *   - decodes the common HTML entities
 *   - collapses excessive blank lines
 *
 * Swap in a proper library (e.g. @mozilla/readability + turndown) if richer
 * extraction is ever needed.
 */

const BLOCK_TAGS = new Set([
	"address", "article", "aside", "blockquote", "br", "div", "dl", "dt", "dd",
	"fieldset", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
	"header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table",
	"tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
	copy: "\u00a9", reg: "\u00ae", trade: "\u2122", hellip: "\u2026",
	mdash: "\u2014", ndash: "\u2013", lsquo: "\u2018", rsquo: "\u2019",
	ldquo: "\u201c", rdquo: "\u201d", laquo: "\u00ab", raquo: "\u00bb",
	bull: "\u2022", middot: "\u00b7", deg: "\u00b0", plusmn: "\u00b1",
	times: "\u00d7", divide: "\u00f7", euro: "\u20ac", pound: "\u00a3",
	cent: "\u00a2", yen: "\u00a5", sect: "\u00a7", para: "\u00b6",
};

function decodeEntities(text: string): string {
	return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, ent: string) => {
		if (ent[0] === "#") {
			if (ent[1] === "x" || ent[1] === "X") {
				const cp = parseInt(ent.slice(2), 16);
				return Number.isNaN(cp) ? match : String.fromCodePoint(cp);
			}
			const cp = parseInt(ent.slice(1), 10);
			return Number.isNaN(cp) ? match : String.fromCodePoint(cp);
		}
		return NAMED_ENTITIES[ent] ?? match;
	});
}

/** Extract the contents of the first <title> element, if any. */
export function extractTitle(html: string): string | undefined {
	const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	if (!m) return undefined;
	const title = decodeEntities(m[1]).trim();
	return title || undefined;
}

/** Convert an HTML document to readable plain text. */
export function htmlToText(html: string): string {
	let s = html;

	// Drop non-content sections entirely.
	s = s.replace(
		/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi,
		" ",
	);

	// Drop comments.
	s = s.replace(/<!--[\s\S]*?-->/g, " ");

	// Block-level open/close tags become newlines so text doesn't run together.
	s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (match, tag: string) => {
		return BLOCK_TAGS.has(tag.toLowerCase()) ? "\n" : "";
	});

	// Strip any remaining tags.
	s = s.replace(/<[^>]+>/g, "");

	s = decodeEntities(s);

	// Normalize whitespace per line, collapse 3+ newlines to 2.
	s = s
		.split("\n")
		.map((line) => line.replace(/[ \t\r\f\v]+/g, " ").trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

	return s;
}
