// Background worker: downloads the media, then runs each check through synthid.com in an
// inactive "worker" tab. Firefox loads the other scripts via manifest background.scripts;
// Chrome's service worker has to import them.
if (typeof importScripts === 'function' && !globalThis.SynthIDShared) importScripts('shared.js', 'streams.js');

const { api, MAX_BYTES, sendBlob, createBlobReceiver, sniffMediaType } = globalThis.SynthIDShared;
const { findStreamedFile } = globalThis.SynthIDStreams;

const SYNTHID_URL = 'https://synthid.com/';
const JOB_TIMEOUT_MS = 5 * 60 * 1000;
const BRIDGE_TIMEOUT_MS = 30 * 1000;
const CACHEABLE = new Set(['detected', 'not_detected', 'uncertain', 'inconclusive']);
const NEEDS_USER = new Set(['signin', 'terms']); // the user has to act in the synthid.com tab

const jobs = [];
let running = false;
let workerTabId = null;
let signInTabId = null; // worker tab left open for the user to sign in; reused next time
const readyTabs = new Set();
const readyWaiters = new Map(); // tabId -> resolve

class FinalError extends Error {}

api.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.t === 'bridge-ready' && sender.tab) {
    readyTabs.add(sender.tab.id);
    readyWaiters.get(sender.tab.id)?.();
  }
});

api.tabs.onRemoved.addListener((tabId) => {
  readyTabs.delete(tabId);
  if (tabId === workerTabId) workerTabId = null;
  if (tabId === signInTabId) signInTabId = null;
});

api.runtime.onConnect.addListener((port) => {
  if (port.name === 'check') handleCheckPort(port);
  if (port.name === 'download') handleDownloadPort(port);
});

// One port per click. The content script sends {t:'check', src} for a URL we should download,
// {t:'check', inline:true} followed by the file itself (blob:/data: media), or
// {t:'check', streamed:true, duration} for a streamed video with no file URL.
function handleCheckPort(port) {
  let closed = false;
  let request = null;
  port.onDisconnect.addListener(() => {
    closed = true;
  });
  const post = (msg) => {
    if (!closed) port.postMessage(msg);
  };
  const enqueue = (blob) => {
    jobs.push({ blob, src: request?.src, post, isClosed: () => closed });
    post({ t: 'status', text: running ? 'Queued…' : 'Starting…' });
    runJobs();
  };
  const receive = createBlobReceiver(enqueue);

  port.onMessage.addListener(async (msg) => {
    if (receive(msg) || msg?.t !== 'check') return;
    request = msg;
    if (msg.streamed) {
      post({ t: 'status', text: 'Finding the video file…' });
      try {
        const file = await findStreamedFile(port.sender?.tab?.id, msg.duration);
        // Cache by file path: the signed query string changes between page loads.
        request = { ...msg, src: file.key };
        const cached = await cachedResult(file.key);
        if (cached) {
          post({ t: 'result', result: cached });
          return;
        }
        post({ t: 'status', text: 'Downloading…' });
        enqueue(await fetchMedia(file.url));
      } catch (err) {
        post({ t: 'result', result: { status: 'error', message: err.message } });
      }
      return;
    }
    const cached = msg.src && (await cachedResult(msg.src));
    if (cached) {
      post({ t: 'result', result: cached });
      return;
    }
    if (msg.inline) return;
    post({ t: 'status', text: 'Downloading…' });
    try {
      enqueue(await fetchMedia(msg.src));
    } catch (err) {
      if (err instanceof FinalError) post({ t: 'result', result: { status: 'error', message: err.message } });
      else post({ t: 'need-bytes', reason: err.message });
    }
  });
}

// Session storage outlives the service worker (which Chrome stops after ~30s idle) but is
// cleared when the browser closes. Repeat clicks on the same URL then don't use quota.
async function cachedResult(src) {
  const key = `result:${src}`;
  try {
    return (await api.storage.session.get(key))[key];
  } catch {
    return undefined;
  }
}

function cacheResult(src, result) {
  Promise.resolve(api.storage.session?.set({ [`result:${src}`]: result })).catch(() => {});
}

async function fetchMedia(src, maxBytes = MAX_BYTES) {
  const res = await fetch(src, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (Number(res.headers.get('content-length')) > maxBytes) {
    throw new FinalError('Larger than synthid.com’s 100 MB limit.');
  }
  return res.blob();
}

// One port per download click: {t:'download', src, name?} for a file URL, or
// {t:'download', streamed:true, duration, name} for a streamed video. Saved with the downloads API;
// Firefox for Android has none, so there the file is sent back for the page to save.
function handleDownloadPort(port) {
  let closed = false;
  port.onDisconnect.addListener(() => {
    closed = true;
  });
  port.onMessage.addListener(async (msg) => {
    if (msg?.t !== 'download') return;
    try {
      const src = msg.streamed ? (await findStreamedFile(port.sender?.tab?.id, msg.duration, Infinity)).url : msg.src;
      if (api.downloads) {
        const name = await saveDownload(src, msg.name);
        if (!closed) port.postMessage({ t: 'saved', name });
      } else {
        const blob = await fetchMedia(src, Infinity);
        if (!closed) await sendBlob(port, blob, { name: msg.name ?? (await fileNameFor(src, blob)) });
      }
    } catch (err) {
      if (!closed) port.postMessage({ t: 'failed', message: err.message });
    }
  });
}

// download() returns as soon as the download starts, so this waits for it to finish to report
// failures such as an expired link. Resolves with the saved file's name.
function saveDownload(url, filename) {
  return new Promise((resolve, reject) => {
    let id = null;
    const settle = (item) => {
      if (item?.state !== 'complete' && item?.state !== 'interrupted') return;
      api.downloads.onChanged.removeListener(onChanged);
      if (item.state === 'complete') resolve(item.filename.split(/[\\/]/).pop());
      else reject(new Error(item.error === 'USER_CANCELED' ? 'Download cancelled.' : `Download failed (${item.error}).`));
    };
    const onChanged = (delta) => {
      if (delta.id === id && delta.state) api.downloads.search({ id }).then(([item]) => settle(item));
    };
    api.downloads.onChanged.addListener(onChanged);
    api.downloads
      .download({ url, ...(filename && { filename }) })
      .then((newId) => {
        id = newId;
        return api.downloads.search({ id });
      })
      .then(([item]) => settle(item))
      .catch((err) => {
        api.downloads.onChanged.removeListener(onChanged);
        reject(err);
      });
  });
}

// Without the downloads API there's no browser-picked name: use the URL's, or the file type's.
async function fileNameFor(src, blob) {
  const last = new URL(src).pathname.split('/').pop();
  if (/^[\w.-]+\.\w{2,4}$/.test(last)) return last;
  const type = sniffMediaType(new Uint8Array(await blob.slice(0, 64).arrayBuffer()));
  return `video.${type?.ext ?? 'mp4'}`;
}

async function runJobs() {
  if (running) return;
  running = true;
  try {
    while (jobs.length) {
      const job = jobs.shift();
      if (job.isClosed()) continue;
      let result;
      try {
        result = await withTimeout(checkOnSynthID(job), JOB_TIMEOUT_MS, 'Timed out waiting for synthid.com.');
      } catch (err) {
        result = { status: 'error', message: err.message };
      }
      if (job.src && CACHEABLE.has(result.status)) cacheResult(job.src, result);
      job.post({ t: 'result', result });

      if (NEEDS_USER.has(result.status)) {
        // Leave the tab open and in front for the user; fail the rest of the queue.
        await focusTab(workerTabId);
        signInTabId = workerTabId;
        workerTabId = null;
        for (const queued of jobs.splice(0)) queued.post({ t: 'result', result });
      }
    }
  } finally {
    running = false;
    if (workerTabId != null) {
      api.tabs.remove(workerTabId).catch(() => {});
      workerTabId = null;
    }
  }
}

async function checkOnSynthID(job) {
  const file = await prepareFile(job.blob);
  job.post({ t: 'status', text: 'Opening synthid.com…' });
  const tabId = await openWorkerTab();

  return new Promise((resolve, reject) => {
    const port = api.tabs.connect(tabId, { name: 'job' });
    port.onMessage.addListener((msg) => {
      if (msg.t === 'status') {
        job.post({ t: 'status', text: msg.text });
      } else if (msg.t === 'result') {
        resolve(msg.result);
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => reject(new Error('The synthid.com tab was closed.')));
    sendBlob(port, file.blob, { name: file.name, kind: file.kind }).catch(reject);
  });
}

// Give the file the exact MIME type and extension synthid.com expects.
async function prepareFile(blob) {
  if (blob.size === 0) throw new Error('The file is empty.');
  if (blob.size > MAX_BYTES) throw new Error('Larger than synthid.com’s 100 MB limit.');
  const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
  const type = sniffMediaType(head);
  if (!type) throw new Error(`Unsupported file type${blob.type ? ` (${blob.type})` : ''}.`);
  return { blob: blob.slice(0, blob.size, type.mime), name: `synthid-check.${type.ext}`, kind: type.kind };
}

// Reuses the worker tab between queued jobs, reloading it so each check starts from the home page.
async function openWorkerTab() {
  if (workerTabId == null && signInTabId != null) {
    workerTabId = signInTabId;
    signInTabId = null;
  }
  if (workerTabId != null) {
    try {
      await api.tabs.get(workerTabId);
    } catch {
      workerTabId = null;
    }
  }
  if (workerTabId == null) {
    const tab = await api.tabs.create({ url: SYNTHID_URL, active: false });
    workerTabId = tab.id;
  } else {
    readyTabs.delete(workerTabId);
    await api.tabs.update(workerTabId, { url: SYNTHID_URL });
  }
  await waitForBridge(workerTabId);
  return workerTabId;
}

function waitForBridge(tabId) {
  if (readyTabs.has(tabId)) return Promise.resolve();
  const ready = new Promise((resolve) => readyWaiters.set(tabId, resolve));
  return withTimeout(ready, BRIDGE_TIMEOUT_MS, 'synthid.com did not load.').finally(() => readyWaiters.delete(tabId));
}

async function focusTab(tabId) {
  if (tabId == null) return;
  try {
    const tab = await api.tabs.update(tabId, { active: true });
    await api.windows?.update(tab.windowId, { focused: true });
  } catch {
    // The windows API doesn't exist on Firefox for Android.
  }
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
