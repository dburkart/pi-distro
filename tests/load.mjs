/**
 * Test harness for the distro repo — loads an extension under jiti with the
 * same `@earendil-works/*` + `typebox` alias map pi's own loader uses, so a
 * plain `node --test` run (no install) can drive an extension's real factory
 * and pure exports. See memory `lessons.md` for the recipe rationale.
 *
 * The pi install root is resolved dynamically from `which pi` (realpath of the
 * `pi` bin → `<PI>/dist/cli.js` → `dirname` twice), so the suite is portable
 * across machines — no hardcoded paths. jiti is a pi dependency, imported
 * dynamically from the resolved install (bare `import "jiti"` can't resolve —
 * the repo has no node_modules).
 */
import { execSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

function resolvePi() {
	const bin = execSync("which pi", { encoding: "utf8" }).trim();
	const real = realpathSync(bin); // <PI>/dist/cli.js
	const pi = path.dirname(path.dirname(real));
	if (!existsSync(path.join(pi, "dist", "index.js"))) {
		throw new Error(`could not resolve pi install from ${bin} → ${real}`);
	}
	return pi;
}

const PI = resolvePi();
const alias = {
	"@earendil-works/pi-coding-agent": `${PI}/dist/index.js`,
	"@earendil-works/pi-tui": `${PI}/node_modules/@earendil-works/pi-tui/dist/index.js`,
	"@earendil-works/pi-ai": `${PI}/node_modules/@earendil-works/pi-ai/dist/compat.js`,
	typebox: `${PI}/node_modules/typebox/build/index.mjs`,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const { createJiti } = await import(`file://${PI}/node_modules/jiti/lib/jiti.mjs`);

/**
 * jiti-import an extension (or any repo source file) and return its module
 * namespace (so both the default factory export and named pure exports are
 * available). `moduleCache: false` so edits between runs are picked up.
 */
export async function loadExt(relPath) {
	const jiti = createJiti(import.meta.url, { alias, moduleCache: false });
	const file = path.resolve(repoRoot, relPath);
	return jiti.import(file);
}

export const piRoot = PI;
export const repoRootPath = repoRoot;
