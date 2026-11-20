import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserResearch } from './researchBrowser.js';
import { fetchPublicResource } from './researchMcp.js';

const context = id => ({ identity: { userMessageId: id }, signal: AbortSignal.timeout(20000) });

test('browser research requires opt-in and public resource requests reject special addresses', async () => {
  const { tools } = createBrowserResearch({ enabled: false });
  await assert.rejects(tools[0].execute({ url: 'https://example.com' }, context('a')), { code: 'WEB_BROWSER_UNAVAILABLE' });
  for (const url of ['file:///tmp/a', 'http://localhost:8780/', 'http://127.0.0.1/', 'http://[::ffff:127.0.0.1]/']) {
    await assert.rejects(fetchPublicResource(url, AbortSignal.timeout(3000), 0, true), /public|blocked/);
  }
});

test('real Chromium renders JS, scopes links by turn, rechecks redirects and ignores non-GET or local subresources', { skip: process.env.LANGVISION_TEST_WEB_BROWSER !== '1' }, async () => {
  const visited = [];
  const origin = 'https://example.com';
  const response = (url, body) => ({ url, status: 200, type: 'text/html', body: Buffer.from(body) });
  const browser = createBrowserResearch({ enabled: true, async fetchResource(url, signal) {
    visited.push(url);
    if (url.startsWith('http://127.0.0.1')) return fetchPublicResource(url, signal, 0, true);
    if (url === origin + '/redirect') return { url, status: 302, location: 'http://127.0.0.1/private', body: Buffer.alloc(0) };
    if (url === origin + '/target') return response(url, '<h1>Rendered destination</h1>');
    if (url === origin + '/') return response(url, `<script>
      addEventListener('DOMContentLoaded', () => {
        document.body.innerHTML='<h1>Rendered source</h1><a href="/target">Details</a>';
        fetch('http://127.0.0.1/private').catch(() => {});
        fetch('/submit',{method:'POST',body:'do not send'}).catch(() => {});
      });
    </script>`);
    throw new Error('Unexpected source: ' + url);
  } });
  const tool = (name, args, id = 'turn-a') => browser.tools.find(item => item.name === 'web.' + name).execute(args, context(id));
  try {
    const page = await tool('navigate', { url: origin + '/' });
    assert.match(page.text, /Rendered source/);
    assert.equal(page.untrusted, true);
    assert.equal(page.links[0].title, 'Details');
    await assert.rejects(tool('follow_link', { ref: page.links[0].ref }, 'turn-b'), { code: 'WEB_PAGE_REQUIRED' });
    const next = await tool('snapshot', {});
    await assert.rejects(tool('follow_link', { ref: page.links[0].ref }), { code: 'WEB_LINK_STALE' });
    assert.match((await tool('follow_link', { ref: next.links[0].ref })).text, /Rendered destination/);
    assert.ok(!visited.includes(origin + '/submit'));
    await assert.rejects(tool('navigate', { url: origin + '/redirect' }), /blocked/);
    assert.ok(visited.includes('http://127.0.0.1/private'));
    assert.deepEqual(await tool('close', {}), { closed: true });
    await assert.rejects(tool('snapshot', {}), { code: 'WEB_PAGE_REQUIRED' });
  } finally { await browser.shutdown(); }
});
