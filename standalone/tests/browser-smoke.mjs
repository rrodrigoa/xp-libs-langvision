import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseURL = process.env.LANGVISION_SMOKE_URL ?? 'http://127.0.0.1:18780';
if (new URL(baseURL).origin !== 'http://127.0.0.1:18780') throw new Error('Use the disposable browser fixture port.');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ baseURL, viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('heading', { name: 'LangVision', exact: true }).waitFor();
  await page.getByTestId('ai-primitive-designer').waitFor();
  const profile = await page.request.post('/api/assistant/profiles', { data: {
    displayName: 'Cached model fixture', baseUrl: 'http://127.0.0.1:11434',
    model: process.env.LANGVISION_SMOKE_MODEL ?? 'qwen3.6:latest', numCtx: 16384, temperature: 0, seed: 42, thinkingMode: 'off',
  } });
  assert.equal(profile.status(), 201, await profile.text());
  assert.ok((await page.request.put('/api/assistant/workspace/default/profile', { data: { profileId: (await profile.json()).id } })).ok());
  await page.reload();
  await page.getByTestId('assistant-message-input').fill('Reply with the short phrase: standalone agent verified. Do not use any tools other than finish_step.');
  const response = page.waitForResponse(item => item.request().method() === 'POST' && new URL(item.url()).pathname.endsWith('/messages'), { timeout: 180000 });
  await page.getByRole('button', { name: 'Send to assistant', exact: true }).click();
  const conversation = await (await response).json();
  assert.equal(conversation.state, 'idle', JSON.stringify(conversation.messages?.at(-1)));
  assert.ok(conversation.messages.some(message => message.payload?.finalAnswer && /standalone agent verified/i.test(message.content)));
  await page.getByRole('button', { name: 'Historia', exact: true }).click();
  await page.getByRole('heading', { name: 'Historia', exact: true }).waitFor();
  await page.getByRole('button', { name: /Reply with the short phrase/ }).first().click();
  await page.getByTestId('ai-open-execution-editor').waitFor();
  const background = await page.locator('body').evaluate(body => getComputedStyle(body).colorScheme);
  assert.equal(background, 'dark');
  await page.getByText('Execution waterfall', { exact: false }).first().waitFor();
  await page.getByRole('button', { name: 'Fit graph', exact: true }).click();
  await page.waitForFunction(() => {
    const graph = document.querySelector('.ai-historical-graph');
    if (!graph) return false;
    const bounds = graph.getBoundingClientRect();
    const nodes = [...graph.querySelectorAll('.react-flow__node')];
    return nodes.length > 2 && nodes.every(node => {
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.x >= bounds.x - 1 && box.right <= bounds.right + 1 &&
        box.y >= bounds.y - 1 && box.bottom <= bounds.bottom + 1;
    });
  });
  if (process.env.LANGVISION_SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.LANGVISION_SMOKE_SCREENSHOT });
  await page.getByTestId('ai-open-execution-editor').click();
  await page.getByTestId('ai-agent-inspection').waitFor();
  const before = await (await page.request.get('/api/assistant/workflows?workspaceId=default')).json();
  await page.getByRole('button', { name: 'Packages', exact: true }).click();
  const link = page.getByRole('link', { name: 'Download agent package' });
  await link.waitFor();
  const file = await page.request.get(await link.getAttribute('href'));
  assert.ok(file.ok(), await file.text());
  await page.getByLabel('Import package').setInputFiles({ name: 'smoke.langvision.json', mimeType: 'application/json', buffer: await file.body() });
  await page.getByRole('status').filter({ hasText: 'Draft imported' }).waitFor();
  const after = await (await page.request.get('/api/assistant/workflows?workspaceId=default')).json();
  assert.equal(after.activeId, before.activeId);
  assert.equal(after.workflows.length, before.workflows.length + 1);
  const imported = after.workflows.find(item => !before.workflows.some(original => original.id === item.id));
  const activation = await page.request.post('/api/assistant/workflows/' + imported.id + '/activate', {
    data: { workspaceId: 'default', expectedDraftVersion: imported.draftVersion },
  });
  assert.ok(activation.ok(), await activation.text());
  assert.deepEqual(errors, []);
  console.log('Standalone editor shell, cached-model chat and persisted Historia passed in Chromium.');
} finally { await browser.close(); }
