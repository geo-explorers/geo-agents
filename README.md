# geo-agents

All agents, one folder each. The skills they use are **vendored** from the
content-management library at a pinned tag — this repository never edits them.

Scaffold only: the structure from the migration plan's *Target Structure*, with nothing
migrated in yet.

## Install

> TODO

## Run an agent

> TODO

## Update the skills

> TODO — `tools/sync-skills.mjs --ref <tag>`, then `tools/verify-lock.mjs`.

## Layout

| Path | What lives here |
|---|---|
| `CLAUDE.md` | Hard rules and routing — these travel with the agents |
| `.claude/skills/<skill>/` | Vendored library skills, all at one tag |
| `.claude/agents/<role>.md` | One subagent definition per role |
| `.claude/settings.json` | Allow scripts · ask on `--publish` · deny `.env*` |
| `agents/<name>/` | One folder per agent |
| `shared/` | One Notion client and one read-only Geo client, until `runtime/` exists upstream |
| `docs/` | The library's `documentation/`, moved here — geo-research reads it |
| `workflow/` | Task and QA-issue lifecycle guide · `ids.json` |
| `skills.lock.json` | Library tag, commit, and a fingerprint per vendored file |
| `tools/` | `sync-skills --ref v1.0.0` · `verify-lock` |
| `runs/` | Git-ignored: ledgers, verdicts, fetched pages |
| `.github/workflows/verify-vendored.yml` | Required check: vendored files match the lock |
