import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSourceStreams } from '../src/lib/source-collector.ts';

const now = new Date('2026-09-26T12:00:00Z');
const stream = { id: 'hf', publisher: 'Example', publisherId: 'example', section: 'models', category: 'models', kind: 'json-index', url: 'https://huggingface.co/api/models?author=example' };

async function withTokens(run) {
  const previous = { HF_TOKEN: process.env.HF_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  process.env.HF_TOKEN = 'hf_test';
  process.env.GITHUB_TOKEN = 'github_test';
  try { await run(); } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

test('Hugging Face API authentication survives same-origin pagination without repeating cache validators', async () => {
  await withTokens(async () => {
    let calls = 0;
    const result = await collectSourceStreams({ version: 1, streams: { hf: { seen: {}, etag: '"page-one"' } } }, {
      now, streams: [stream], fetcher: async (url, init) => {
        calls++;
        assert.equal(init.headers.Authorization, 'Bearer hf_test');
        assert.equal(init.headers['If-None-Match'], calls === 1 ? '"page-one"' : undefined);
        return new Response(JSON.stringify([{ id: `example/model-${calls}`, lastModified: now.toISOString() }]), {
          headers: calls === 1 ? { Link: '<https://huggingface.co/api/models?author=example&cursor=next>; rel="next"' } : {},
        });
      },
    });
    assert.equal(calls, 2);
    assert.equal(result.health[0].status, 'ok');
    assert.equal(result.health[0].baselineCount, 2);
  });
});

test('provider tokens are scoped to their HTTPS API origins and public collection works without HF_TOKEN', async () => {
  await withTokens(async () => {
    for (const [url, expected] of [
      [stream.url, 'Bearer hf_test'],
      ['https://huggingface.co/blog/feed.xml', undefined],
      ['https://huggingface.co.example.test/api/models', undefined],
      ['http://huggingface.co/api/models', undefined],
      ['https://api.github.com/repos/example/model/releases', 'Bearer github_test'],
    ]) {
      let receivedHeaders;
      await collectSourceStreams(undefined, { now, streams: [{ ...stream, url }], fetcher: async (_url, init) => {
        receivedHeaders = init.headers;
        return new Response('[]');
      } });
      assert.ok(receivedHeaders);
      assert.equal(receivedHeaders.Authorization, expected);
    }
    delete process.env.HF_TOKEN;
    const result = await collectSourceStreams(undefined, { now, streams: [stream], fetcher: async (_url, init) => {
      assert.equal(init.headers.Authorization, undefined);
      return new Response('[]');
    } });
    assert.equal(result.health[0].status, 'ok');
  });
});

test('Hugging Face pagination cannot send the token to another origin', async () => {
  await withTokens(async () => {
    let calls = 0;
    const result = await collectSourceStreams(undefined, { now, streams: [stream], fetcher: async () => {
      calls++;
      return new Response('[]', { headers: { Link: '<https://example.test/api/models>; rel="next"' } });
    } });
    assert.equal(calls, 1);
    assert.equal(result.health[0].status, 'failed');
    assert.equal(result.health[0].error, 'Cross-origin pagination rejected');
  });
});
