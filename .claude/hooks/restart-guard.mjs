#!/usr/bin/env node
// PreToolUse hook: after tools/update.mjs moved this checkout, refuse skill and agent
// work until a new session starts, because this session still has the old skills and
// rules loaded. Everything else is allowed. Registered in .claude/settings.json.
//
// Exit 0 = allow. Exit 2 = block; stderr is shown to Claude.

import { readFileSync } from 'node:fs';
import { REPO_ROOT } from '../../tools/lib/lock.mjs';
import { isSkillWork, readMarker } from '../../tools/lib/preflight.mjs';

const marker = readMarker(REPO_ROOT);
if (!marker) process.exit(0);

const block = () => {
  process.stderr.write(
    `BLOCKED: the skills in this checkout were updated during this session (${marker.from ?? '?'} → ${marker.to ?? '?'}), ` +
    'and this session still has the old skills and rules loaded. Do not do skill or agent work in this session by any route: ' +
    'no Skill tool, no subagents, no scripts under .claude/skills, and no following a SKILL.md by hand. ' +
    'Tell the editor: "Please start a new Claude Code session (close this one and open a new one), then ask me again." ' +
    'Keep helping with anything that needs no skill.\n',
  );
  process.exit(2);
};

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  block(); // unreadable input while a restart is pending: fail closed
}
if (isSkillWork(input?.tool_name, input?.tool_input)) block();
process.exit(0);
