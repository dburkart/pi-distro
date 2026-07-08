/**
 * The maintainer contract.
 *
 * The single most important file in a memory store is the schema/config that
 * turns the agent from a "generic chatbot that drops notes" into a
 * disciplined maintainer. Every production deployment of the wiki pattern
 * reports this file is co-evolved over time and is non-optional. This is the
 * correction to "let the agent choose its own schema" — give it a contract,
 * not a blank slate.
 *
 * This module bootstraps the contract on first use. The user is meant to edit
 * it; the agent is meant to follow and propose changes to it.
 */

import { join } from "node:path";
import { writeText, readText, pathExists } from "./paths.ts";

export const MEMORY_CONTRACT_FILENAME = "MEMORY.md";

export function contractPath(root: string): string {
	return join(root, MEMORY_CONTRACT_FILENAME);
}

/** The default maintainer contract, written on first init. */
export const DEFAULT_CONTRACT = `# Memory

This directory is the agent's persistent, cross-session memory. The agent
writes and maintains it; you read and edit it. Everything here is plain
markdown — inspect it, diff it, commit it.

## What belongs here

Two kinds of memory, both durable across sessions:

- **Factual**: project state, decisions made and why, your preferences and
  constraints, environment facts. ("We chose PostgreSQL, not MySQL." "Tests
  run via pnpm test, not npm." "The auth module is mid-refactor — see
  decisions.md.")
- **Experiential**: lessons learned, dead-ends, what worked and what didn't.
  ("Retry logic was a red herring; the connection pool config was the bug."
  "Approach X failed because Y.") This is the part most agents lack and the
  highest-leverage to keep — it stops the agent re-deriving solutions every
  session.

Do NOT store ephemeral session state (the current todo list lives in the
session, not here), secrets, or anything that should be in code/comments
instead.

## Conventions

- One topic per file. Prefer a flat name (\`decisions.md\`, \`lessons.md\`,
  \`env.md\`); nest only when a topic genuinely has sub-pages
  (\`debugging/auth.md\`).
- New page when something is a distinct concept you'd link to from elsewhere.
  Edit in place when it's an update to an existing one.
- Each page starts with a one-line summary as its first heading or paragraph
  — the index is built from these.
- Prefer to update an existing page over creating a new one. Search before
  you write.
- When new info contradicts an existing page, update the page — don't write
  a competing one. Note the contradiction in \`log.md\`.

## Index and log

- \`index.md\` is a one-line-per-page catalog the agent maintains. Read it
  first to find relevant pages; drill in from there. At small scale this
  beats any search infra.
- \`log.md\` is append-only and chronological: one line per write, parseable
  with \`grep "^## "\` . Use it to see what changed recently.

## Maintenance

Run \`/memory lint\` periodically. It flags orphan pages (no inbound links),
possible contradictions, and stale entries. Lint does not delete anything —
it only reports; you decide.
`;
