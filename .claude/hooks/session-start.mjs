#!/usr/bin/env node
// SessionStart hook: tells Claude whether this checkout's skills are current.
// Registered in .claude/settings.json. Never blocks a session: always exits 0.
//
// Input (stdin, JSON): { source: "startup" | "resume" | ... }
// Output (stdout, JSON): { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }

import { readFileSync } from 'node:fs';
import { REPO_ROOT, verifyLock } from '../../tools/lib/lock.mjs';
import {
  clearMarker, compareLocks, fetchOriginMain, readLockAt, readLockFile, readMarker, sessionContext,
} from '../../tools/lib/preflight.mjs';

function emit(text) {
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } })}\n`);
  process.exit(0);
}

try {
  let source = 'startup';
  try {
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
    if (typeof input.source === 'string') source = input.source;
  } catch { /* no or bad input: treat as a fresh start */ }

  // A brand-new session has the current skills loaded, so a pending restart is done.
  if (source === 'startup') clearMarker(REPO_ROOT);
  const marker = readMarker(REPO_ROOT);

  const lock = verifyLock(REPO_ROOT);
  const fetched = fetchOriginMain(REPO_ROOT, { timeoutMs: 8000 });
  const cmp = fetched.ok
    ? compareLocks(readLockFile(REPO_ROOT), readLockAt(REPO_ROOT, 'refs/remotes/origin/main'))
    : { status: 'unknown', reason: fetched.error };

  emit(sessionContext({ source, cmp, lock, marker, fetchError: fetched.ok ? null : fetched.error }));
} catch (err) {
  emit(`geo-agents session check could not run (${err.message}). Mention this in one line and carry on.`);
}
