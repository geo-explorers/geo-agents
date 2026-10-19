// shared/notion.mjs — the one Notion client for the agents in this repository.
//
// Written for geo-agents. Its pacing and retry behaviour follow the library's
// scripts/notion-read.mjs and the notion-operations skill, as released in
// geo-explorers/geo-skills v1.0.0
// (commit a7166025cd81bc3078a217588de78f786a22c7d2). It differs from that script
// in three ways: failures are thrown instead of returned, Retry-After is
// honoured, and it can write. This file is deleted once the library ships its
// own shared package.
//
// The rules it enforces:
//   - Paced. Notion allows about 3 requests per second per integration token,
//     shared by every agent using that token. The default here is 2.5.
//   - Reads are retried. A GET, a search and a database query change nothing,
//     so a rate limit or a server error is retried, waiting as long as Notion asks.
//   - Writes are NEVER retried. A write that fails or times out may still have
//     been applied; sending it again can create a duplicate row. The caller gets
//     the error and must read back before deciding what to do.
//   - The token is read from the environment and never printed.
//
// No dependencies. Node 22+.
//
//   import { createNotionClient } from '../../shared/notion.mjs';
//   const notion = createNotionClient();                 // uses NOTION_TOKEN
//   const rows = await notion.queryAll(databaseId);      // read, paged, retried
//   await notion.patch(`pages/${pageId}`, { properties });   // write, sent once

export const NOTION_VERSION = '2022-06-28';
const BASE_URL = 'https://api.notion.com/v1/';
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export class NotionError extends Error {
  constructor(message, { status = null, code = null, retryAfterSeconds = null, method, path, isWrite }) {
    super(message);
    this.name = 'NotionError';
    this.status = status;                       // HTTP status, or null for a network failure
    this.code = code;                           // Notion's error code, e.g. "object_not_found"
    this.retryAfterSeconds = retryAfterSeconds; // set on a 429 when Notion sent Retry-After
    this.method = method;
    this.path = path;
    this.isWrite = isWrite;
  }
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} [options]
 * @param {string} [options.token]            defaults to process.env.NOTION_TOKEN
 * @param {number} [options.ratePerSecond]    request starts per second, default 2.5
 * @param {number} [options.maxReadRetries]   extra attempts for a read, default 5
 * @param {Function} [options.fetch]          for tests
 * @param {Function} [options.sleep]          for tests
 * @param {Function} [options.now]            for tests
 */
export function createNotionClient({
  token = process.env.NOTION_TOKEN,
  ratePerSecond = 2.5,
  maxReadRetries = 5,
  fetch: fetchImpl = globalThis.fetch,
  sleep = realSleep,
  now = Date.now,
} = {}) {
  if (!token) {
    throw new Error(
      'NOTION_TOKEN is not set. Load it from the environment, for example ' +
        '`node --env-file=.env <script>`. Never pass the token on the command line.',
    );
  }
  if (!(ratePerSecond > 0)) throw new Error('ratePerSecond must be greater than 0');

  const intervalMs = 1000 / ratePerSecond;
  let nextSlot = 0;
  let queue = Promise.resolve();

  /** Wait for this request's turn. Calls are served in order, one slot each. */
  function pace() {
    const turn = queue.then(async () => {
      const wait = nextSlot - now();
      if (wait > 0) await sleep(wait);
      nextSlot = Math.max(now(), nextSlot) + intervalMs;
    });
    queue = turn.catch(() => {});
    return turn;
  }

  async function send(method, path, body, isWrite) {
    await pace();
    let response;
    try {
      response = await fetchImpl(BASE_URL + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Notion-Version': NOTION_VERSION,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      const hint = isWrite ? ' The write may or may not have been applied: read back before sending it again.' : '';
      throw new NotionError(`Notion ${method} ${path}: network error (${err.message}).${hint}`, { method, path, isWrite });
    }
    if (response.ok) return response.json();

    let detail = {};
    try { detail = await response.json(); } catch { /* not JSON */ }
    const header = response.headers?.get?.('retry-after');
    const retryAfterSeconds = header != null && header !== '' && !Number.isNaN(Number(header)) ? Number(header) : null;
    const shared = detail.code === 'object_not_found'
      ? ' A 404 that names the integration means the page is not shared with it, not that it does not exist.'
      : '';
    throw new NotionError(
      `Notion ${method} ${path}: HTTP ${response.status}${detail.code ? ` ${detail.code}` : ''}` +
        `${detail.message ? ` — ${String(detail.message).slice(0, 300)}` : ''}.${shared}`,
      { status: response.status, code: detail.code ?? null, retryAfterSeconds, method, path, isWrite },
    );
  }

  /** A read: safe to repeat, so rate limits, server errors and network failures are retried. */
  async function read(method, path, body) {
    let lastError;
    for (let attempt = 0; attempt <= maxReadRetries; attempt++) {
      try {
        return await send(method, path, body, false);
      } catch (err) {
        if (!(err instanceof NotionError)) throw err;
        const retryable = err.status === null || RETRYABLE_STATUS.has(err.status);
        if (!retryable || attempt === maxReadRetries) throw err;
        lastError = err;
        const waitMs = err.retryAfterSeconds != null
          ? err.retryAfterSeconds * 1000
          : Math.min(30_000, 1000 * 2 ** attempt);
        await sleep(waitMs);
      }
    }
    throw lastError;
  }

  /** A write: sent exactly once. */
  const write = (method, path, body) => send(method, path, body, true);

  const cleanId = (id) => String(id).replace(/-/g, '');

  return {
    // ---- reads (retried) ----
    /** GET any path under /v1/, e.g. `pages/<id>` or `databases/<id>`. */
    get: (path) => read('GET', path),
    /** POST /search. Read-only. */
    search: (body = {}) => read('POST', 'search', body),
    /** One page of a database query. Read-only. */
    queryDatabase: (databaseId, body = {}) => read('POST', `databases/${cleanId(databaseId)}/query`, body),
    /** Every row of a database query, following the cursor to the end. */
    async queryAll(databaseId, body = {}) {
      const rows = [];
      let cursor;
      do {
        const page = await read('POST', `databases/${cleanId(databaseId)}/query`, {
          page_size: 100, ...body, ...(cursor ? { start_cursor: cursor } : {}),
        });
        rows.push(...(page.results ?? []));
        cursor = page.has_more ? page.next_cursor : undefined;
      } while (cursor);
      return rows;
    },

    // ---- writes (never retried) ----
    /** POST a write, e.g. `pages` to create a row. Sent once. */
    post: (path, body) => write('POST', path, body),
    /** PATCH a write, e.g. `pages/<id>` to update properties. Sent once. */
    patch: (path, body) => write('PATCH', path, body),
  };
}
