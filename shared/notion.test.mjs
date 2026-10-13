// Tests for shared/notion.mjs. No network: fetch, sleep and the clock are faked.
//
//   node --test shared/notion.test.mjs

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NOTION_VERSION, NotionError, createNotionClient } from './notion.mjs';

/** A fake world: scripted responses, a clock that only moves when we sleep. */
function world(responses) {
  const calls = [];
  const sleeps = [];
  let clock = 1_000_000;
  const queue = [...responses];
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body, at: clock });
    const next = queue.shift();
    if (!next) throw new Error('test: no scripted response left');
    if (next.throw) throw new Error(next.throw);
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? next.retryAfter ?? null : null) },
      json: async () => next.json ?? {},
    };
  };
  const sleep = async (ms) => { sleeps.push(ms); clock += ms; };
  const client = (options = {}) => createNotionClient({ token: 'secret-test-token', fetch, sleep, now: () => clock, ...options });
  return { calls, sleeps, client };
}

test('refuses to start without a token, and does not echo anything secret', () => {
  assert.throws(() => createNotionClient({ token: '' }), /NOTION_TOKEN is not set/);
});

test('sends the token, the pinned API version and the body', async () => {
  const w = world([{ status: 200, json: { object: 'page' } }]);
  const result = await w.client().patch('pages/abc', { properties: { Done: { checkbox: true } } });
  assert.deepEqual(result, { object: 'page' });
  const call = w.calls[0];
  assert.equal(call.url, 'https://api.notion.com/v1/pages/abc');
  assert.equal(call.method, 'PATCH');
  assert.equal(call.headers.Authorization, 'Bearer secret-test-token');
  assert.equal(call.headers['Notion-Version'], NOTION_VERSION);
  assert.equal(JSON.parse(call.body).properties.Done.checkbox, true);
});

test('a read is retried after a rate limit, waiting as long as Notion asks', async () => {
  const w = world([{ status: 429, retryAfter: '7' }, { status: 200, json: { id: 'x' } }]);
  const result = await w.client().get('pages/x');
  assert.equal(result.id, 'x');
  assert.equal(w.calls.length, 2);
  assert.ok(w.sleeps.includes(7000), 'waited the Retry-After seconds');
});

test('a read is retried after a server error and after a network failure', async () => {
  const w = world([{ status: 503 }, { throw: 'socket hang up' }, { status: 200, json: { results: [], has_more: false } }]);
  const page = await w.client().queryDatabase('db-1');
  assert.deepEqual(page.results, []);
  assert.equal(w.calls.length, 3);
  assert.equal(w.calls[0].url, 'https://api.notion.com/v1/databases/db1/query');
});

test('a read gives up after the retry budget and reports the last error', async () => {
  const w = world(Array.from({ length: 3 }, () => ({ status: 500 })));
  await assert.rejects(w.client({ maxReadRetries: 2 }).get('pages/x'), (err) => err instanceof NotionError && err.status === 500);
  assert.equal(w.calls.length, 3);
});

test('a read is not retried on an error that will not go away', async () => {
  const w = world([{ status: 404, json: { code: 'object_not_found', message: 'Could not find page' } }]);
  await assert.rejects(w.client().get('pages/x'), (err) => err.code === 'object_not_found' && /not shared/.test(err.message));
  assert.equal(w.calls.length, 1);
});

test('a write is never retried: not on a rate limit', async () => {
  const w = world([{ status: 429, retryAfter: '2' }, { status: 200 }]);
  await assert.rejects(w.client().post('pages', { parent: {} }), (err) => err.status === 429 && err.retryAfterSeconds === 2 && err.isWrite);
  assert.equal(w.calls.length, 1, 'sent exactly once');
});

test('a write is never retried: not on a server error or a network failure', async () => {
  const a = world([{ status: 502 }, { status: 200 }]);
  await assert.rejects(a.client().patch('pages/x', {}), (err) => err.status === 502);
  assert.equal(a.calls.length, 1);

  const b = world([{ throw: 'ETIMEDOUT' }, { status: 200 }]);
  await assert.rejects(b.client().post('pages', {}), /may or may not have been applied/);
  assert.equal(b.calls.length, 1);
});

test('requests are paced: starts are at least one interval apart, in order', async () => {
  const w = world(Array.from({ length: 4 }, () => ({ status: 200, json: {} })));
  const notion = w.client({ ratePerSecond: 2 }); // 500 ms apart
  await Promise.all([notion.get('a'), notion.get('b'), notion.get('c'), notion.get('d')]);
  assert.deepEqual(w.calls.map((c) => c.url.split('/').pop()), ['a', 'b', 'c', 'd']);
  for (let i = 1; i < w.calls.length; i++) {
    assert.ok(w.calls[i].at - w.calls[i - 1].at >= 500, `call ${i} started at least 500 ms after the previous one`);
  }
});

test('queryAll follows the cursor to the last page', async () => {
  const w = world([
    { status: 200, json: { results: [1, 2], has_more: true, next_cursor: 'c1' } },
    { status: 200, json: { results: [3], has_more: false, next_cursor: null } },
  ]);
  const rows = await w.client().queryAll('db', { filter: { property: 'Status' } });
  assert.deepEqual(rows, [1, 2, 3]);
  assert.equal(JSON.parse(w.calls[0].body).page_size, 100);
  assert.equal(JSON.parse(w.calls[1].body).start_cursor, 'c1');
  assert.deepEqual(JSON.parse(w.calls[1].body).filter, { property: 'Status' });
});

test('an error message never contains the token', async () => {
  const w = world([{ status: 401, json: { code: 'unauthorized', message: 'API token is invalid.' } }]);
  await assert.rejects(w.client().get('users/me'), (err) => !err.message.includes('secret-test-token'));
});
