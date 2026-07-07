/**
 * Editor resolution.
 *
 * Matches pi's own precedence (used by the Ctrl+G `app.editor.external`
 * keybinding and the built-in editor dialog):
 *
 *   1. `externalEditor` in user settings.json
 *   2. $VISUAL
 *   3. $EDITOR
 *   4. `notepad` on Windows, `nano` elsewhere
 *
 * The settings read is best-effort: project-local settings are intentionally
 * ignored (an editor is a personal preference, not a project concern), and a
 * malformed or unreadable file silently falls through to the env vars.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export interface EditorCommand {
	command: string;
	args: string[];
}

const DEFAULT_EDITOR = process.platform === "win32" ? "notepad" : "nano";

/** Split an editor command string into command + args (e.g. `code -w`). */
export function parseEditorCommand(raw: string): EditorCommand {
	const parts = raw.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) {
		return { command: DEFAULT_EDITOR, args: [] };
	}
	return { command: parts[0]!, args: parts.slice(1) };
}

/** Read `externalEditor` from user-scoped settings, if present. */
function readExternalEditorSetting(): string | undefined {
	try {
		const settingsPath = join(homedir(), CONFIG_DIR_NAME, "agent", "settings.json");
		const raw = readFileSync(settingsPath, "utf-8");
		const parsed = JSON.parse(raw) as { externalEditor?: string };
		const value = parsed.externalEditor?.trim();
		return value || undefined;
	} catch {
		return undefined;
	}
}

/** Resolve the user's preferred editor. */
export function resolveEditor(): EditorCommand {
	const raw =
		readExternalEditorSetting() ||
		process.env.VISUAL ||
		process.env.EDITOR ||
		DEFAULT_EDITOR;
	return parseEditorCommand(raw);
}
