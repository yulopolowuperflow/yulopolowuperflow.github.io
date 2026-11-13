// Preserve the entry URL for reloads and share its parameters with the worker.
(() => {
  const root = typeof document === 'undefined'
    ? new URL('./', self.location.href)
    : new URL('./', document.currentScript.src);
  const storageKey = new URL('__saved_download_params__', root).href;
  const cacheName = 'personal-site-download-params-v1';

  async function snapshot() {
    const cache = await caches.open(cacheName);
    const response = await cache.match(storageKey);
    return response ? response.json() : null;
  }

  async function read() {
    const saved = await snapshot();
    if (saved?.url) return [...new URL(saved.url).searchParams];
    return Array.isArray(saved) ? saved : saved?.params || [];
  }

  async function save(url) {
    const cache = await caches.open(cacheName);
    await cache.put(storageKey, new Response(JSON.stringify({ url }), {
      headers: { 'Content-Type': 'application/json' },
    }));
  }

  globalThis.B1Params = { read, save };
  if (typeof document === 'undefined') return;

  const incoming = new URL(location.href);
  window.__landingRoot = root.href;

  // Expose params synchronously — index.html no longer waits for disk I/O
  window.__savedDownloadParams = incoming.searchParams;

  // Keep relative images/styles/scripts tied to the real page after replaceState.
  const base = document.createElement('base');
  base.href = new URL('./', incoming).href;
  document.head.prepend(base);

  // Clean the URL immediately — don't block on disk
  history.replaceState(history.state, '', root.href);

  // Persist params for the service worker in the background.
  // Only the legacy sw2.js fallback (via B1Params.read()) needs this to be ready,
  // and sw3.js reads params from the iframe URL directly.
  window.__landingParamsReady = save(incoming.href).catch((error) => {
    console.error('[params] save failed', error);
  });
})();
