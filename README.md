# geo-agents

All Geo agents, one folder each. The skills they use are **vendored** from the [geo-skills](https://github.com/geo-explorers/geo-skills) skills library at one pinned release. This repository never edits them.

> **Status.** 15 skills vendored from geo-skills `v1.2.1`. Two agents live here: geo-research and geo-mirror-refresh. The QA agent is not built yet.

Agents read [`CLAUDE.md`](CLAUDE.md) first: it holds the hard rules and the routing.

## Install

You need `git` and Node 22 or newer. There is nothing else to install: the tools have no dependencies.

```bash
git clone https://github.com/geo-explorers/geo-agents.git
cd geo-agents
node tools/verify-lock.mjs
```

The last command must print `OK`. Start Claude Code from this folder so the rules, the skills and the allowlist all load.

Secrets go in a `.env` file that you create and fill in yourself, starting from `.env.example`. It is git-ignored, and agents are not allowed to read it. It needs only `NOTION_TOKEN`; no agent here needs a wallet key.

## Run an agent

1. **Start Claude Code in this folder.** Agents are loaded when a session starts, so start a new session after pulling changes.
2. **Ask for the job in plain words**, for example "refresh the mirrors" or "research this entity", or name the agent: "use the geo-research agent to …".
3. The agent reads its instructions in `agents/<name>/AGENT.md`, checks the vendored skills with `node tools/verify-lock.mjs`, and stops if that check fails.

| Agent | Needs |
|---|---|
| geo-mirror-refresh | `NOTION_TOKEN` in `.env`, and the mirror pages connected to that Notion integration |
| geo-research | Web search, and the Hypergraph MCP server registered in Claude Code under the name `hypergraph-mcp`. Its tool list uses that name; under another name the agent loses its Geo lookups |

Both agents log their task in the Work tracker first, as [`workflow/AGENT-WORKFLOW.md`](workflow/AGENT-WORKFLOW.md) requires.

## What runs from here

All 15 library skills are vendored, so their instructions are always at hand. Not all of them can *run* from this repository yet. Some call shared code that lives only in the library (`src/`, `lib/`, root `scripts/`), or expect the library's folder layout. Those are run from a checkout of [geo-skills](https://github.com/geo-explorers/geo-skills) until the library ships its shared code as a package.

| Skill | Runs from here? | Why |
|---|---|---|
| geo-query | Yes | Plain GraphQL over HTTP. Its client is here as `shared/geo-read.mjs` |
| geo-mirror, Geo → Notion | Yes | The mirroring scripts need nothing outside the skill folder |
| geo-mirror, Notion → Geo | No | `sync-to-geo.mjs` imports the library's `src/functions.ts` and the Geo SDK |
| ontology-advisor | Yes | Its scripts use only what is in the skill folder |
| geo-describe | Yes | Its similarity check needs the Python package `sentence_transformers` |
| geo-discovery | Partly | The read stages are self-contained. The publish and dashboard scripts need the Geo SDK |
| notion-operations | Yes | It is guidance. The helper it names, `scripts/notion-read.mjs`, lives in the library |
| daily-report | Yes | Self-contained |
| image-banner-recompose | Yes | Self-contained |
| geo-publish | No | Its publish scripts import `src/functions`, `lib/inject.ts` and `src/xlsx-to-csv.cjs` |
| geo-clean | No | Uses `src/` and `validate_migration.ts` |
| geo-orchestrate | No | Generates scripts that import `src/` |
| geo-claim-grouping | No | `discover_candidates.ts` imports `src/functions.ts` |
| geo-claim-grouping-notion | No | Its own scripts are self-contained, but the discovery step it starts with is geo-claim-grouping's |
| geo-mirror-and-group | No | `run-pipeline.mjs` builds paths in the library's `skills/<tier>/` layout |
| geo-press-review | No | Runs `scripts/press-review-coverage-map.ts` from the library root |

Two more things to know when a skill is run from here:

- **Paths in the instructions are the library's.** A skill may say `skills/actionable/geo-mirror/scripts/…`. Here the same file is at `.claude/skills/geo-mirror/scripts/…`. The vendored files are never edited to fix this.
- **This table was built by reading imports and paths, not by running each skill.** The two agents that move here in step 5 are each proven with a supervised run.

## Update the skills

Skills change only when a maintainer moves this repository to a newer library release. Nothing downloads skills while an agent runs.

1. **Preview** what the new release would change:
   ```bash
   node tools/sync-skills.mjs --ref v1.1.0 --dry-run
   ```
2. **Vendor it.** This replaces `.claude/skills/` and rewrites `skills.lock.json`:
   ```bash
   node tools/sync-skills.mjs --ref v1.1.0
   ```
3. **Open a pull request.** Reviewers read the real skill diff. The `verify-vendored` check recomputes every fingerprint and must pass.
4. **Merge.** From then on every agent session checks the new lock at start.

The tool accepts release tags only, in the form `vX.Y.Z`, and only from the official library. It refuses a branch name. It also refuses a tag that now points at a different commit than the one recorded in the lock, because a published release must never move. To pin the expected commit yourself, add `--commit <40-character hash>`.

Never edit a file under `.claude/skills/` and never edit `skills.lock.json` by hand. If a vendored file is changed, added or removed, the check fails. A maintainer restores the pinned release by running the sync again with the tag already in the lock.

## Checks

| Command | What it proves |
|---|---|
| `node tools/verify-lock.mjs` | Every vendored file matches its fingerprint, and nothing extra is in `.claude/skills/` |
| `node --test tools/verify-lock.test.mjs` | The check itself catches a changed, added or removed file |
| `node --test shared/notion.test.mjs` | The Notion client paces requests, retries reads, and never retries a write |

All three run in GitHub on every pull request as the `verify-vendored` check, which is required to merge.

## Layout

| Path | What lives here |
|---|---|
| `CLAUDE.md` | Hard rules and routing. They travel with the agents |
| `.claude/skills/<skill>/` | Vendored library skills, all at one release. Never hand-edited |
| `.claude/agents/<role>.md` | One subagent definition per role |
| `.claude/settings.json` | Allowlist: run the tools and agent scripts, ask before any `--publish` or skills sync, never read `.env*` |
| `agents/<name>/` | One folder per agent |
| `shared/` | `notion.mjs`, the one Notion client, and `geo-read.mjs`, a read-only Geo client copied from the library. Both go away when the library has its own shared package |
| `docs/` | The library's `documentation/`, moved here. geo-research reads it |
| `workflow/` | Task and QA-issue lifecycle guide, and `ids.json` |
| `skills.lock.json` | Library tag, commit, and a fingerprint per vendored file |
| `tools/` | `sync-skills.mjs` (maintainers) and `verify-lock.mjs` (everyone) |
| `runs/` | Git-ignored: ledgers, verdicts, fetched pages |
| `.github/workflows/verify-vendored.yml` | The required check |
