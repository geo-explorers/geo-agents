# geo-agents

All Geo agents, one folder each. The skills they use are **vendored** from the [geo-skills](https://github.com/geo-explorers/geo-skills) skills library at one pinned release. This repository never edits them.

> **Status.** 16 skills vendored from geo-skills `v1.3.2`. Two agents live here: geo-research and geo-mirror-refresh. The QA agent is not built yet.

Agents read [`CLAUDE.md`](CLAUDE.md) first: it holds the hard rules and the routing.

## Install

You need `git` and Node 22 or newer. There is nothing else to install: the tools have no dependencies.

```bash
git clone https://github.com/geo-explorers/geo-agents.git
cd geo-agents
node tools/verify-lock.mjs
```

The last command must print `OK`. No GitHub account is needed. If you downloaded the ZIP instead of cloning, that works too: when newer skills exist, Claude offers to make a copy that updates itself (`node tools/setup-clone.mjs`) and asks you to open the new folder. Start Claude Code from this folder so the rules, the skills, the allowlist and the session check all load. Claude Code runs this repository's hooks only after you trust the folder, the first time you open it.

Secrets go in a `.env` file that you create and fill in yourself, starting from `.env.example`. It is git-ignored, and agents are not allowed to read it. It uses the same variable names as geo-skills: `NOTION_TOKEN` for the agents and the Notion skills; `GEO_PRIVATE_KEY` and `DEMO_SPACE_ID` for the skills that publish to Geo; `INJECT_BASE_URL` and `INJECT_API_KEY` for geo-publish's inject mode. Fill in only what you use. The agents here need only `NOTION_TOKEN`.

## Run an agent

1. **Start Claude Code in this folder.** Agents are loaded when a session starts, so start a new session after an update.
2. **Ask for the job in plain words**, for example "refresh the mirrors" or "research this entity", or name the agent: "use the geo-research agent to …".
3. The agent reads its instructions in `agents/<name>/AGENT.md`, checks the vendored skills with `node tools/verify-lock.mjs`, and stops if that check fails.

| Agent | Needs |
|---|---|
| geo-mirror-refresh | `NOTION_TOKEN` in `.env`, and the mirror pages connected to that Notion integration |
| geo-research | Web search, and the Hypergraph MCP server registered in Claude Code under the name `hypergraph-mcp`. Its tool list uses that name; under another name the agent loses its Geo lookups |

Both agents log their task in the Work tracker first, as [`workflow/AGENT-WORKFLOW.md`](workflow/AGENT-WORKFLOW.md) requires.

## What runs from here

All 16 library skills are vendored, so their instructions are always at hand. Not all of them can *run* from this repository yet. Some call shared code that lives only in the library (`src/`, `lib/`, root `scripts/`), or expect the library's folder layout. Those are run from a checkout of [geo-skills](https://github.com/geo-explorers/geo-skills) until the library ships its shared code as a package.

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

Nothing downloads skills while an agent runs. Skills reach this repository and each editor's computer in three steps, all automatic.

### 1. A geo-skills release reaches `main`, with no one involved

When a skill change is merged in geo-skills, its release workflow tags a release (`vX.Y.Z`) and notifies this repository. The **sync-skills-release** workflow then:

1. checks the tag is an exact release on geo-skills `main` and points at the notified commit, and never moves backwards;
2. runs `node tools/sync-skills.mjs --ref <tag> --commit <hash>`, which replaces `.claude/skills/`, rewrites `skills.lock.json` and updates the two release lines at the top of this README;
3. opens a pull request on the branch `bot/sync-skills-<tag>` with the release link and the skills that changed;
4. waits for the required `verify-vendored` check on that exact commit, then merges the pull request itself.

Close the pull request to stop a release from landing. If a skill was added or removed, the pull request says so: the table in [What runs from here](#what-runs-from-here) and the routing in `CLAUDE.md` still need a person.

If the workflow fails, its pull request gets a comment with the run link. Re-run it, or run it by hand: **Actions → sync-skills-release → Run workflow**, with the tag.

### 2. Each editor's checkout, at the start of a session

When Claude Code starts in this folder, a hook compares the checkout's `skills.lock.json` with the team's `main`. If the skills changed, Claude offers the update before the first task.

- **Yes:** Claude runs `node tools/update.mjs` (Claude Code asks permission first). Your own files are kept: loose files are not touched, edits are stashed and put back, other branches are left as they are, and hand-edited skill files are copied to `runs/update-backup-<time>/` before the released ones are restored. Then start a new Claude Code session. Until you do, Claude refuses skill work, because the old skills are still loaded.
- **No:** carry on with the current skills. You'll be asked again in the next new session.

`node tools/update.mjs --dry-run` shows what the update would do without changing anything.

### 3. By hand, for maintainers

The same sync, run locally, ends in a pull request like the bot's:

1. **Preview** what the new release would change:
   ```bash
   node tools/sync-skills.mjs --ref v1.1.0 --dry-run
   ```
2. **Vendor it.** This replaces `.claude/skills/`, rewrites `skills.lock.json` and updates this README's release lines:
   ```bash
   node tools/sync-skills.mjs --ref v1.1.0
   ```
3. **Open a pull request.** Reviewers read the real skill diff. The `verify-vendored` check recomputes every fingerprint and must pass.

The tool accepts release tags only, in the form `vX.Y.Z`, and only from the official library. It refuses a branch name. It also refuses a tag that now points at a different commit than the one recorded in the lock, because a published release must never move. To pin the expected commit yourself, add `--commit <40-character hash>`.

Never edit a file under `.claude/skills/` and never edit `skills.lock.json` by hand. If a vendored file is changed, added or removed, the check fails. A maintainer restores the pinned release by running the sync again with the tag already in the lock.

### The bot

The workflow acts as the org's release GitHub App, not as a person, and uses no personal token. Each run asks the app for a token that lasts one hour and can write only contents and pull requests in this repository. The app's id (variable `RELEASE_APP_ID`) and private key (secret `RELEASE_APP_PRIVATE_KEY`) live in the environment `skills-sync`, which only `main` can use. The app is the only actor allowed to merge without an approval; the `verify-vendored` check can't be bypassed by anyone. How the app is set up and how its key is rotated is in geo-skills' `MAINTAINERS.md`.

## Checks

| Command | What it proves |
|---|---|
| `node tools/verify-lock.mjs` | Every vendored file matches its fingerprint, and nothing extra is in `.claude/skills/` |
| `node --test tools/verify-lock.test.mjs` | The check itself catches a changed, added or removed file |
| `node --test tools/preflight.test.mjs tools/sync-skills.test.mjs` | The session check reports each case correctly, the restart guard blocks only skill work, and the README release lines update |
| `node --test tools/update.test.mjs` | The updater keeps editors' loose files, edits and branches, and stops safely when it can't fast-forward |
| `node --test shared/notion.test.mjs` | The Notion client paces requests, retries reads, and never retries a write |

All of them run in GitHub on every pull request as the `verify-vendored` check, which is required to merge.

## Layout

| Path | What lives here |
|---|---|
| `CLAUDE.md` | Hard rules and routing. They travel with the agents |
| `.claude/skills/<skill>/` | Vendored library skills, all at one release. Never hand-edited |
| `.claude/agents/<role>.md` | One subagent definition per role |
| `.claude/settings.json` | Allowlist: run the tools and agent scripts, ask before any `--publish`, skills sync or update, never read `.env*`. Registers the two hooks |
| `.claude/hooks/` | `session-start.mjs`, the session check, and `restart-guard.mjs`, which blocks skill work after an update until a new session |
| `agents/<name>/` | One folder per agent |
| `shared/` | `notion.mjs`, the one Notion client, and `geo-read.mjs`, a read-only Geo client copied from the library. Both go away when the library has its own shared package |
| `docs/` | The library's `documentation/`, moved here. geo-research reads it |
| `workflow/` | Task and QA-issue lifecycle guide, and `ids.json` |
| `skills.lock.json` | Library tag, commit, and a fingerprint per vendored file |
| `tools/` | `sync-skills.mjs` (the bot and maintainers), `update.mjs` and `setup-clone.mjs` (editors, through Claude) and `verify-lock.mjs` (everyone) |
| `runs/` | Git-ignored: ledgers, verdicts, fetched pages, update backups and the restart marker |
| `.github/workflows/verify-vendored.yml` | The required check |
| `.github/workflows/sync-skills-release.yml` | Vendors each geo-skills release through a bot pull request |
