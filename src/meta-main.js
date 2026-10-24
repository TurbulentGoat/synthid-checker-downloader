// Runs inside Instagram's and Threads' own JavaScript context (world: MAIN), from document_start.
//
// Both sites list each post's video files in the JSON their API calls return: video_versions,
// progressive MP4s with sound, one per quality. This taps the page's fetch and XHR, read-only, to
// collect them, and answers lookups from meta.js by post shortcode or media ID. On Instagram, a
// post it hasn't seen is requested from the API the site itself uses.
(() => {
  const TAG = 'synthid-meta';
  const IG_APP_ID = '936619743392459'; // Instagram's web app ID, sent with media-info requests
  const MAX_CACHED = 3000;
  const onInstagram = /(^|\.)instagram\.com$/.test(location.hostname);
  const pageFetch = window.fetch;

  // ---- Collecting video files from the site's JSON -------------------------------------

  // "code:<shortcode>" | "pk:<media id>"  ->  { user, items: [{ url, duration }] }
  const media = new Map();

  function bestUrl(versions) {
    const usable = versions.filter((v) => typeof v?.url === 'string');
    usable.sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));
    return usable[0]?.url ?? null;
  }

  function videoItem(node) {
    const url = Array.isArray(node?.video_versions) && bestUrl(node.video_versions);
    if (!url) return null;
    return { url, duration: typeof node.video_duration === 'number' ? node.video_duration : null };
  }

  // Media IDs exceed 2^53, so only trust string forms (pk, or the "<pk>_<owner>" id).
  function pkOf(node) {
    if (typeof node.pk === 'string' && /^\d+$/.test(node.pk)) return node.pk;
    const id = typeof node.id === 'string' && node.id.match(/^(\d+)(?:_\d+)?$/);
    if (id) return id[1];
    if (Number.isSafeInteger(node.pk)) return String(node.pk);
    return null;
  }

  function userOf(node) {
    const user = node.user || node.owner || node.caption?.user;
    return typeof user?.username === 'string' ? user.username : null;
  }

  function remember(key, entry) {
    media.delete(key); // re-insert so it counts as newest
    media.set(key, entry);
    if (media.size > MAX_CACHED) media.delete(media.keys().next().value);
  }

  // Walks any JSON looking for media objects: { code, pk, video_versions, carousel_media, user }.
  function harvest(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 80) return;
    if (Array.isArray(node)) {
      for (const child of node) harvest(child, depth + 1);
      return;
    }
    const isMedia = Array.isArray(node.video_versions) || Array.isArray(node.carousel_media);
    if (isMedia) {
      const user = userOf(node);
      const items = [];
      const own = videoItem(node);
      if (own) items.push(own);
      for (const child of Array.isArray(node.carousel_media) ? node.carousel_media : []) {
        const item = videoItem(child);
        if (!item) continue; // photo slide
        items.push(item);
        const childPk = pkOf(child);
        if (childPk) remember(`pk:${childPk}`, { user, items: [item] });
      }
      if (items.length) {
        const entry = { user, items };
        if (typeof node.code === 'string') remember(`code:${node.code}`, entry);
        const pk = pkOf(node);
        if (pk) remember(`pk:${pk}`, entry);
      }
    }
    for (const key in node) {
      if (isMedia && key === 'carousel_media') continue; // handled above
      const value = node[key];
      if (value && typeof value === 'object') harvest(value, depth + 1);
    }
  }

  function harvestText(text) {
    if (typeof text !== 'string' || !text.includes('video_versions')) return;
    const body = text.replace(/^\s*for\s*\(;;\);/, '');
    try {
      harvest(JSON.parse(body));
      return;
    } catch {
      // May be several JSON documents, one per line (streamed responses).
    }
    for (const line of body.split('\n')) {
      const s = line.trim();
      if (s[0] !== '{' && s[0] !== '[') continue;
      try {
        harvest(JSON.parse(s));
      } catch {}
    }
  }

  const seenScripts = new WeakSet();
  function harvestEmbeddedJson() {
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      if (seenScripts.has(script)) continue;
      seenScripts.add(script);
      harvestText(script.textContent);
    }
  }

  // ---- Read-only taps on the page's fetch and XHR ----------------------------------------
  // They never alter requests or responses, and swallow their own errors so the page keeps working.

  const isApi = (url) => /graphql|\/api\//i.test(url || '');

  window.fetch = function (input) {
    const promise = pageFetch.apply(window, arguments);
    try {
      const url = typeof input === 'string' ? input : (input?.url ?? String(input));
      if (isApi(url)) promise.then((res) => res.clone().text()).then(harvestText).catch(() => {});
    } catch {}
    return promise;
  };

  const xhrUrls = new WeakMap();
  const { open, send } = XMLHttpRequest.prototype;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      xhrUrls.set(this, String(url));
    } catch {}
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    try {
      if (isApi(xhrUrls.get(this))) {
        this.addEventListener('load', () => {
          try {
            if (this.responseType === '' || this.responseType === 'text') harvestText(this.responseText);
          } catch {}
        });
      }
    } catch {}
    return send.apply(this, arguments);
  };

  // ---- Lookups from meta.js ---------------------------------------------------------------

  // Shortcodes are base64 media IDs (the first 11 characters, on long private ones).
  function shortcodeToPk(code) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let id = 0n;
    for (const ch of code.slice(0, 11)) {
      const i = alphabet.indexOf(ch);
      if (i < 0) return null;
      id = id * 64n + BigInt(i);
    }
    return id > 0n ? id.toString() : null;
  }

  const lookup = (code, pk) => (code && media.get(`code:${code}`)) || (pk && media.get(`pk:${pk}`)) || null;

  async function findEntry(code, pk) {
    let entry = lookup(code, pk);
    if (entry) return entry;
    harvestEmbeddedJson();
    entry = lookup(code, pk);
    if (entry || !onInstagram) return entry;

    const id = pk || (code && shortcodeToPk(code));
    if (!id) return null;
    try {
      const res = await pageFetch(`${location.origin}/api/v1/media/${id}/info/`, {
        credentials: 'include',
        headers: { 'X-IG-App-ID': IG_APP_ID, 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      harvestText(await res.text());
    } catch (err) {
      throw new Error(`Instagram wouldn’t return this video (${err.message}). Are you logged in?`);
    }
    return lookup(code, id);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.[TAG] !== 'lookup') return;
    const { id, code, pk } = e.data;
    findEntry(code, pk)
      .then(
        (entry) => ({ entry }),
        (err) => ({ error: err.message }),
      )
      .then((reply) => window.postMessage({ [TAG]: 'entry', id, ...reply }, location.origin));
  });
})();
