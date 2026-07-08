# Dana's Pi Distro

This repository contains Dana's personal pi distribution.

## Principles

1. Before adding new features, whether as a skill or extension, read all
   relevant documentation under docs/. Start from [docs/README.md](docs/README.md),
   the index — it lists every doc with a one-line summary so you can judge
   relevance without recursively listing the tree.
2. When adding new features, always remember to keep things concise and well-factored.
3. After adding a new feature, extension, or skill make sure to document
   important decisions or guiding principles under docs/ **and add a line to
   [docs/README.md](docs/README.md)** so the doc is discoverable from the index.
4. All extensions, skills, and scripts written to this repository should be portable to other users and computers.
5. Every change ships with a test. The repo's suite is `node --test`
   (configured in `.pi/test.json`); run it before considering a change done:
   `node --test --test-reporter=tap tests/extensions/*.test.mjs` (or via the
   `test` tool / `/test` command). Add or extend tests in `tests/` alongside
   the code — load extensions under jiti via `tests/load.mjs` (no install
   needed; see `docs/extensions/test.md`).

