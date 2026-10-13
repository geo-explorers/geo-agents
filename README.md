# geo-agents

All Geo agents, one folder each. The skills they use are **vendored** from the [content-management](https://github.com/geo-explorers/content-management) skills library at one pinned release. This repository never edits them.

> **Migration status.** The tools and the lock check are in place. The skills are vendored in step 4 and the agents move in during step 5. Until then `.claude/skills/` is empty and the folders under `agents/` are placeholders.

Agents read [`CLAUDE.md`](CLAUDE.md) first: it holds the hard rules and the routing.

## Install

You need `git` and Node 22 or newer. There is nothing else to install: the tools have no dependencies.

```bash
git clone https://github.com/geo-explorers/geo-agents.git
cd geo-agents
node tools/verify-lock.mjs
```

The last command must print `OK`. Start Claude Code from this folder so the rules, the skills and the allowlist all load.

Secrets go in a `.env` file that you create and fill in yourself. It is git-ignored, and agents are not allowed to read it.

## Run an agent

> Filled in when the agents move here in step 5.

Every session starts with `node tools/verify-lock.mjs`. If it fails, the agent stops and asks a maintainer.

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

Both run in GitHub on every pull request as the `verify-vendored` check, which is required to merge.

## Layout

| Path | What lives here |
|---|---|
| `CLAUDE.md` | Hard rules and routing. They travel with the agents |
| `.claude/skills/<skill>/` | Vendored library skills, all at one release. Never hand-edited |
| `.claude/agents/<role>.md` | One subagent definition per role |
| `.claude/settings.json` | Allowlist: run the tools and agent scripts, ask before any `--publish` or skills sync, never read `.env*` |
| `agents/<name>/` | One folder per agent |
| `shared/` | One Notion client and one read-only Geo client, until the library has its own shared package |
| `docs/` | The library's `documentation/`, moved here. geo-research reads it |
| `workflow/` | Task and QA-issue lifecycle guide, and `ids.json` |
| `skills.lock.json` | Library tag, commit, and a fingerprint per vendored file |
| `tools/` | `sync-skills.mjs` (maintainers) and `verify-lock.mjs` (everyone) |
| `runs/` | Git-ignored: ledgers, verdicts, fetched pages |
| `.github/workflows/verify-vendored.yml` | The required check |
