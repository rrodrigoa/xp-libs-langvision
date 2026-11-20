import { randomUUID } from 'node:crypto';

const blocked = (code, message) => Object.assign(new Error(message), { code });
const field = (name, maxLength) => ({ type: 'object', required: [name], properties: { [name]: { type: 'string', minLength: 1, maxLength } }, additionalProperties: false });
const empty = { type: 'object', properties: {}, additionalProperties: false };
const mainResources = new Set(['document', 'script', 'stylesheet', 'xhr', 'fetch']);
const snapshotLimit = 4400;
const linkLimit = 24;
const idleMs = 15 * 60_000;

export function createBrowserResearch({ enabled, fetchResource }) {
  const sessions = new Map();
  let browserPromise;
  const launch = async () => {
    try {
      const { chromium } = await import('playwright');
      return await chromium.launch({
        chromiumSandbox: true,
        proxy: { server: 'http://192.0.2.1:9', bypass: '<-loopback>' },
        args: ['--disable-quic', '--host-resolver-rules=MAP * ~NOTFOUND', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
      });
    } catch (error) {
      throw blocked('WEB_BROWSER_UNAVAILABLE', `Isolated Chromium could not start. Install the packaged Playwright browser and check sandbox support: ${error.message}`);
    }
  };
  const cleanupTurn = async id => {
    const item = sessions.get(id);
    if (!item) return;
    sessions.delete(id);
    clearTimeout(item.idle);
    await item.context?.close().catch(() => {});
  };
  async function open(id) {
    if (sessions.has(id)) return sessions.get(id);
    if (sessions.size >= 4) throw blocked('WEB_SESSION_LIMIT', 'The research browser is busy. Close another research session or try again later.');
    const item = { refs: new Map(), queue: Promise.resolve() };
    sessions.set(id, item);
    try {
      browserPromise ??= launch().catch(error => { browserPromise = undefined; throw error; });
      item.context = await (await browserPromise).newContext({ serviceWorkers: 'block', acceptDownloads: false, permissions: [] });
      if (sessions.get(id) !== item) { await item.context.close(); throw blocked('WEB_SESSION_CLOSED', 'The research turn ended.'); }
      await item.context.routeWebSocket('**/*', socket => socket.close());
      await item.context.route('**/*', async route => {
        const request = route.request();
        if (++item.requests > 60 || request.method() !== 'GET' || !mainResources.has(request.resourceType())) {
          await route.abort().catch(() => {}); return;
        }
        try {
          const deadline = AbortSignal.timeout(5000);
          const response = await fetchResource(request.url(), item.signal ? AbortSignal.any([item.signal, deadline]) : deadline, 0, true);
          item.bytes += response.body.length;
          if (item.bytes > 4 * 1024 * 1024) throw blocked('WEB_LIMIT', 'The page exceeded the research browser byte budget.');
          if (response.location) {
            if (request.isNavigationRequest() && request.frame() === item.page?.mainFrame()) item.nextLocation = response.location;
            await route.abort();
            return;
          }
          await route.fulfill({ status: response.status, body: response.body, headers: {
            'content-type': response.type, 'x-content-type-options': 'nosniff',
          } });
        } catch (error) {
          if (request.isNavigationRequest()) item.navigationError = error.message;
          await route.abort().catch(() => {});
        }
      });
      item.page = await item.context.newPage();
      item.context.on('page', page => { if (page !== item.page) void page.close().catch(() => {}); });
      item.requests = 0;
      item.bytes = 0;
      return item;
    } catch (error) {
      await cleanupTurn(id);
      throw error;
    }
  }
  const snapshot = async item => {
    const url = item.page.url();
    if (!/^https?:\/\//i.test(url)) throw blocked('WEB_PAGE_REQUIRED', 'Navigate to a public HTTP(S) page first.');
    const raw = await item.page.locator('body').ariaSnapshot({ timeout: 5000 });
    const links = await item.page.getByRole('link').evaluateAll((elements, limit) => {
      const links = new Map();
      for (const element of elements) {
        if (element instanceof HTMLAnchorElement && /^https?:\/\//i.test(element.href) && element.href.length <= 2048) {
          links.set(element.href, { title: (element.getAttribute('aria-label') ?? element.innerText).trim().slice(0, 160), url: element.href });
        }
        if (links.size >= limit) break;
      }
      return [...links.values()];
    }, linkLimit + 1);
    item.refs.clear();
    item.snapshotUrl = url;
    return { url, text: raw.slice(0, snapshotLimit), truncated: raw.length > snapshotLimit || links.length > linkLimit, links: links.slice(0, linkLimit).map(link => {
      const ref = randomUUID();
      item.refs.set(ref, link.url);
      return { ref, ...link };
    }), untrusted: true };
  };
  const definitions = [
    ['navigate', 'Open a public HTTP(S) URL in a fresh research browser for this turn and return rendered content and link references.', field('url', 2048)],
    ['snapshot', 'Read the current public page as rendered, including new references for its visible links.', empty],
    ['follow_link', 'Navigate via a link reference from the most recent snapshot. Old references are invalid.', field('ref', 64)],
    ['close', 'Close this turn’s research browser context.', empty],
  ];
  const ensureEnabled = () => {
    if (!enabled) throw blocked('WEB_BROWSER_UNAVAILABLE', 'Browser research is disabled. Enable LANGVISION_WEB_BROWSER=1 and install Playwright Chromium.');
  };
  const tools = definitions.map(([method, description, schema]) => ({
    name: 'web.' + method, description, schema, risk: ['snapshot', 'close'].includes(method) ? 'read' : 'write', version: 1,
    preview: args => ({ summary: 'Use isolated public web research', arguments: args }),
    preflight: ensureEnabled,
    async execute(args, context = {}) {
      ensureEnabled();
      const id = context.identity?.userMessageId;
      if (!id) throw blocked('WEB_SESSION_REQUIRED', 'Browser research needs a LangVision turn identity.');
      if (method === 'close') { await cleanupTurn(id); return { closed: true }; }
      let item = sessions.get(id);
      if (!item) {
        if (method !== 'navigate') throw blocked('WEB_PAGE_REQUIRED', 'Call web.navigate to open a public page first.');
        item = await open(id);
      }
      const work = item.queue.then(async () => {
        context.signal?.throwIfAborted();
        const limit = AbortSignal.timeout(15000);
        const signal = context.signal ? AbortSignal.any([context.signal, limit]) : limit;
        item.signal = signal;
        clearTimeout(item.idle);
        const abort = () => { void cleanupTurn(id); };
        signal.addEventListener('abort', abort, { once: true });
        try {
          if (method === 'snapshot') return await snapshot(item);
          const url = method === 'navigate' ? args.url : item.page.url() === item.snapshotUrl && item.refs.get(args.ref);
          if (!url) throw blocked('WEB_LINK_STALE', 'Take a new snapshot and use one of its link references.');
          if (!/^https?:\/\//i.test(url)) throw blocked('WEB_INVALID_URL', 'Only public HTTP(S) URLs are supported.');
          item.navigationError = null;
          item.requests = item.bytes = 0;
          item.refs.clear();
          try {
            let next = url;
            for (let redirects = 0; ; redirects++) {
              item.nextLocation = null;
              try { await item.page.goto(next, { waitUntil: 'load', timeout: 12000 }); break; }
              catch (error) {
                if (!item.nextLocation || redirects === 3) throw error;
                next = item.nextLocation;
              }
            }
            return await snapshot(item);
          } catch (error) {
            context.signal?.throwIfAborted();
            throw blocked(limit.aborted ? 'WEB_BROWSER_TIMEOUT' : 'WEB_NAVIGATION_FAILED', item.navigationError ?? error.message);
          }
        } finally {
          signal.removeEventListener('abort', abort);
          if (sessions.has(id)) { item.idle = setTimeout(() => { void cleanupTurn(id); }, idleMs); item.idle.unref(); }
        }
      });
      item.queue = work.catch(() => {});
      return work;
    },
  }));
  return { tools, cleanupTurn, async shutdown() {
    await Promise.all([...sessions.keys()].map(cleanupTurn));
    await (await browserPromise?.catch(() => null))?.close();
  } };
}
