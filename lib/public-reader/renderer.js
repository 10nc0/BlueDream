'use strict';

const { ReaderError } = require('./policy');

// No executable path or browser flags are accepted from the model or request.
// Operators must install the matching Playwright Chromium build. No fallback
// to unsandboxed Chromium or a remote automation API.
async function renderDocument(inertHtml, { signal } = {}) {
  signal?.throwIfAborted();
  let browser;
  let aborted = false;
  const close = () => { aborted = true; if (browser) void browser.close().catch(() => {}); };
  signal?.addEventListener('abort', close, { once: true });
  try {
    const { chromium } = require('playwright');
    // The managed Nix Chromium wrapper supplies its own runtime libraries;
    // bundled Linux builds may not run on NixOS. Never add unsandboxed flags.
    const nixChromium = '/repl/tools/bin/chromium';
    browser = await chromium.launch({
      headless: true, chromiumSandbox: true, env: {}, timeout: 10000,
      ...(require('fs').existsSync(nixChromium) ? { executablePath: nixChromium } : {}),
      args: ['--disable-background-networking', '--disable-extensions', '--disable-component-update',
        '--disable-sync', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND']
    });
    if (aborted) { await browser.close(); signal?.throwIfAborted(); }
    const context = await browser.newContext({
      javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false,
      offline: true, storageState: { cookies: [], origins: [] }
    });
    await context.route('**/*', route => route.abort('blockedbyclient'));
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    context.on('page', popup => { if (popup !== page) void popup.close(); });
    page.on('download', download => void download.cancel());
    await page.setContent(`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'">${inertHtml}`, { timeout: 10000, waitUntil: 'domcontentloaded' });
    // Fixed code only; selectors, scripts and scroll counts are not model inputs.
    for (let i = 0; i < 2; i++) {
      signal?.throwIfAborted();
      await page.mouse.wheel(0, 600);
    }
    return await page.locator('main').innerText({ timeout: 5000 });
  } catch (error) {
    signal?.throwIfAborted();
    throw new ReaderError('browser_unavailable', 'Safe sandboxed Chromium rendering is unavailable; no browser retrieval succeeded.');
  } finally {
    signal?.removeEventListener('abort', close);
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { renderDocument };
