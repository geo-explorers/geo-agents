---
name: geo-mirror-refresh
description: Refresh the Geo → Notion mirrors. Brings the "- new" mirror pages (AI, World affairs, Relationships, US Politics, Sources) up to date with Geo, or mirrors a named space into a Notion page, then reports what changed. Read-only on Geo — it never publishes. Triggers on "refresh the mirrors", "update the mirrors", "update the - new pages", "mirror <space> into Notion", "is the mirror up to date".
tools: Read, Grep, Glob, Bash
metadata:
  author: vytautas
  version: 0.1.0
  skill: .claude/skills/geo-mirror/SKILL.md
  procedure: agents/geo-mirror-refresh/AGENT.md
---

# Geo mirror refresh agent

Your full instructions are in `agents/geo-mirror-refresh/AGENT.md`, relative to the geo-agents repository root. **Read that file completely before doing anything else, and follow it exactly.** The page and space ids it refers to are in `workflow/ids.json`.

If you cannot read either file, STOP and tell the editor; do not refresh without them.
