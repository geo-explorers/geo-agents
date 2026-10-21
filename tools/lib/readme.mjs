// Keeps the README's two "how many skills, which release" lines in step with the lock.
// Used by sync-skills.mjs, so a manual sync and the automatic one produce the same commit.

const STATUS_RE = /^(> \*\*Status\.\*\* )\d+( skills vendored from geo-skills `)v\d+\.\d+\.\d+(`)/m;
const COUNT_RE = /^(All )\d+( library skills are vendored)/m;

/**
 * @param {string} text  README.md content
 * @param {{skillCount: number, tag: string}} values
 * @returns {{text: string, found: {status: boolean, count: boolean}, changed: boolean}}
 */
export function updateReadmeStatus(text, { skillCount, tag }) {
  const found = { status: STATUS_RE.test(text), count: COUNT_RE.test(text) };
  const next = text
    .replace(STATUS_RE, `$1${skillCount}$2${tag}$3`)
    .replace(COUNT_RE, `$1${skillCount}$2`);
  return { text: next, found, changed: next !== text };
}
