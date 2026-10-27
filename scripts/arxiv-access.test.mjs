import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSourceStreams } from '../src/lib/source-collector.ts';

test('arXiv collection spaces complete requests across hosts and calls, including failures, without delaying other publishers', async () => {
  const stream = { id: 'ai', publisher: 'arXiv', publisherId: 'arxiv', section: 'papers', category: 'research', kind: 'rss', url: 'https://rss.arxiv.org/rss/cs.AI' };
  const requests = [];
  let unrelatedAt;
  const body = '<rss><channel><title>Papers</title></channel></rss>';
  const fetcher = async (url, init) => {
    assert.equal(init.signal.aborted, false);
    assert.equal(init.headers.Authorization, undefined);
    if (new URL(url).hostname === 'example.test') {
      unrelatedAt = Date.now();
      return new Response(body);
    }
    const request = { url, startedAt: Date.now(), finishedAt: 0 };
    requests.push(request);
    if (url.includes('export.arxiv.org')) {
      return new Response(new ReadableStream({ cancel() { request.finishedAt = Date.now(); } }), { status: 503 });
    }
    return new Response(new ReadableStream({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(body));
          request.finishedAt = Date.now();
          controller.close();
        }, 100);
      },
    }));
  };
  const first = await collectSourceStreams(undefined, { streams: [
    stream,
    { ...stream, id: 'api', url: 'https://export.arxiv.org/api/query?search_query=cat:cs.AI' },
    { ...stream, id: 'other', url: 'https://example.test/feed' },
  ], fetcher });
  assert.deepEqual(first.health.map(row => row.status), ['ok', 'failed', 'ok']);
  assert.equal(first.health[1].error, 'HTTP 503');
  const second = await collectSourceStreams(undefined, { streams: [{ ...stream, id: 'lg', url: 'https://rss.arxiv.org/rss/cs.LG' }], fetcher });
  assert.equal(second.health[0].status, 'ok');
  assert.equal(requests.length, 3);
  for (let i = 1; i < requests.length; i++) {
    assert.ok(requests[i - 1].finishedAt > 0);
    assert.ok(requests[i].startedAt - requests[i - 1].finishedAt >= 2995, 'wait at least three seconds after consuming or cancelling the previous response');
  }
  assert.ok(unrelatedAt < requests[1].startedAt, 'unrelated publishers do not wait for the arXiv queue');
});
