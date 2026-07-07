/**
 * `review` tool — the agent hands text to a human, who edits it in $EDITOR.
 *
 * The tool writes the text to a temp file, opens it in the user's editor via
 * the secondary buffer, and returns the absolute path of that file. The agent
 * is expected to `read` the path back to see what the human changed — this
 * keeps potentially large edited content out of the tool result and lets
 * follow-up workflows (e.g. committing the reviewed text) reuse the path.
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openContent } from "../lib/editor.ts";

export function registerReviewTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "review",
		label: "Review",
		description:
			"Open text for human review in the user's $EDITOR. The human edits it; " +
			"the tool returns the absolute path of the edited file. Read the path back " +
			"to see the changes. Use this when the agent needs a human to review or " +
			"correct text (prose, commit messages, config, code, etc.).",
		promptSnippet: "Hand text to the human for review/editing in $EDITOR",
		promptGuidelines: [
			"Use review when the agent needs the human to review or edit text before " +
				"proceeding; the tool returns a file path — call read on it to see the result.",
		],
		parameters: Type.Object({
			content: Type.String({
				description: "Text for the human to review. It will be opened in their editor.",
			}),
			label: Type.Optional(
				Type.String({
					description: "Short label shown while waiting for review.",
				}),
			),
			pathHint: Type.Optional(
				Type.String({
					description:
						"Optional filename used only to pick the temp file extension " +
						"(for editor syntax highlighting). Not opened directly.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({
				content: [{ type: "text", text: params.label ? `Waiting for review: ${params.label}` : "Waiting for review…" }],
			});

			const { path, result } = await openContent(ctx, params.content, {
				pathHint: params.pathHint,
				signal: signal ?? ctx.signal,
			});

			if (result.error) {
				throw new Error(`Editor failed: ${result.error.message}`);
			}
			if (result.cancelled) {
				return {
					content: [{ type: "text", text: `Review cancelled. File (may be partially edited): ${path}` }],
					details: { path, cancelled: true },
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Reviewed file (exit code ${result.exitCode}). Read this path to see the human's edits:\n${path}`,
					},
				],
				details: { path, exitCode: result.exitCode },
			};
		},
	});
}
