// Finds the file behind a streamed video. Facebook and Instagram play videos through Media
// Source Extensions, so the <video> has no file URL. The player downloads byte ranges of
// complete MP4 files (one per quality, video and audio separate) from Meta's CDN with
// ?bytestart=…&byteend=…. Dropping those parameters returns the whole file.
//
// Requests are watched with webRequest because Facebook fetches from a worker, which the page
// can't see. The clicked video is matched to a file by its duration.
(() => {
  const { api, MAX_BYTES } = globalThis.SynthIDShared;

  const SEGMENT_URLS = ['*://*.fbcdn.net/*bytestart=*', '*://*.cdninstagram.com/*bytestart=*'];
  const FILES_PER_TAB = 40;
  const MAX_PROBES = 24;
  const PROBE_BYTES = 128 * 1024;
  const NOT_FOUND =
    'This video is streamed in pieces and its file couldn’t be found. On Facebook and Instagram, let it play for a few seconds, then try again.';

  // Kept in session storage because the background worker can be stopped between the video
  // loading and the click.
  const writes = new Map(); // tabId -> promise chain, so updates don't overwrite each other
  const storageKey = (tabId) => `streams:${tabId}`;
  const readFiles = async (tabId) => (await api.storage.session.get(storageKey(tabId)))[storageKey(tabId)] ?? [];

  function updateFiles(tabId, change) {
    const next = (writes.get(tabId) ?? Promise.resolve())
      .then(async () => {
        const updated = change(await readFiles(tabId));
        if (updated) await api.storage.session.set({ [storageKey(tabId)]: updated });
      })
      .catch(() => {});
    writes.set(tabId, next);
  }

  api.webRequest.onBeforeRequest.addListener(
    ({ tabId, url }) => {
      if (tabId < 0) return;
      const file = new URL(url);
      if (!file.searchParams.has('bytestart')) return;
      file.searchParams.delete('bytestart');
      file.searchParams.delete('byteend');
      const key = file.origin + file.pathname;
      updateFiles(tabId, (files) => {
        if (files[0]?.key === key && Date.now() - files[0].seen < 2000) return null;
        const others = files.filter((f) => f.key !== key);
        return [{ key, url: file.href, seen: Date.now() }, ...others].slice(0, FILES_PER_TAB);
      });
    },
    { urls: SEGMENT_URLS },
  );

  api.tabs.onRemoved.addListener((tabId) => {
    Promise.resolve(api.storage.session.remove(storageKey(tabId))).catch(() => {});
    writes.delete(tabId);
  });

  // Returns {key, url} for the best-quality video file, no larger than maxBytes, whose length
  // matches the clicked video.
  async function findStreamedFile(tabId, duration, maxBytes = MAX_BYTES) {
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('This is a live or unfinished stream, so there’s no file to check.');
    }
    await writes.get(tabId);
    const files = (await readFiles(tabId)).slice(0, MAX_PROBES);
    const probed = await Promise.all(files.map(async (file) => ({ ...file, ...(await probe(file.url).catch(() => null)) })));
    const tolerance = Math.max(0.5, duration * 0.01);
    const matches = probed.filter((f) => f.tracks?.includes('vide') && Math.abs(f.duration - duration) <= tolerance);
    if (!matches.length) throw new Error(NOT_FOUND);

    // Every quality of one video has the same exact length; use the most recently played video.
    const newest = matches.reduce((a, b) => (b.seen > a.seen ? b : a));
    const versions = matches.filter((f) => Math.abs(f.duration - newest.duration) < 0.05);
    const fitting = versions.filter((f) => f.size > 0 && f.size <= maxBytes);
    if (!fitting.length) throw new Error('Larger than synthid.com’s 100 MB limit.');
    const best = fitting.reduce((a, b) => (b.size > a.size ? b : a));
    return { key: best.key, url: best.url };
  }

  // Downloads the start of a file to see what tracks it has, how long it is and its size.
  async function probe(url) {
    const res = await fetch(url, { credentials: 'include', headers: { Range: `bytes=0-${PROBE_BYTES - 1}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const size = Number(res.headers.get('content-range')?.split('/')[1] ?? res.headers.get('content-length'));
    return { ...parseMp4Head(await readAtMost(res, PROBE_BYTES)), size };
  }

  async function readAtMost(res, limit) {
    const reader = res.body.getReader();
    const chunks = [];
    let length = 0;
    while (length < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.length;
    }
    reader.cancel().catch(() => {});
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }

  // Reads the boxes at the start of an MP4. DASH files have an empty movie duration and give
  // their length in a sidx (segment index) box instead.
  function parseMp4Head(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const ascii = (at) => String.fromCharCode(...bytes.subarray(at, at + 4));

    function* boxes(start, end) {
      for (let at = start; at + 8 <= end; ) {
        let size = view.getUint32(at);
        let header = 8;
        if (size === 1) {
          if (at + 16 > end) return;
          size = Number(view.getBigUint64(at + 8));
          header = 16;
        } else if (size === 0) {
          size = end - at;
        }
        if (size < header) return;
        yield { type: ascii(at + 4), body: at + header, end: Math.min(at + size, end), complete: at + size <= end };
        at += size;
      }
    }

    // mvhd and mdhd share a layout: version, flags, two timestamps, timescale, duration.
    function readDuration(at) {
      const version = bytes[at];
      const timescale = view.getUint32(at + (version === 1 ? 20 : 12));
      const duration = version === 1 ? Number(view.getBigUint64(at + 24)) : view.getUint32(at + 16);
      return timescale ? duration / timescale : 0;
    }

    const tracks = [];
    let headerDuration = 0;
    let indexDuration = 0;
    for (const box of boxes(0, bytes.length)) {
      if (box.type === 'moov') {
        for (const child of boxes(box.body, box.end)) {
          if (child.type === 'mvhd') headerDuration = readDuration(child.body);
          if (child.type !== 'trak') continue;
          for (const mdia of boxes(child.body, child.end)) {
            if (mdia.type !== 'mdia') continue;
            for (const part of boxes(mdia.body, mdia.end)) {
              if (part.type === 'hdlr') tracks.push(ascii(part.body + 8));
              if (part.type === 'mdhd') headerDuration ||= readDuration(part.body);
            }
          }
        }
      } else if (box.type === 'sidx' && box.complete) {
        const version = bytes[box.body];
        const timescale = view.getUint32(box.body + 8);
        let at = box.body + 12 + (version === 0 ? 8 : 16) + 2;
        const count = view.getUint16(at);
        at += 2;
        let total = 0;
        for (let i = 0; i < count; i++, at += 12) total += view.getUint32(at + 4);
        indexDuration = timescale ? total / timescale : 0;
      } else if (box.type === 'moof' || box.type === 'mdat') {
        break;
      }
    }
    return { tracks, duration: indexDuration || headerDuration };
  }

  globalThis.SynthIDStreams = { findStreamedFile, parseMp4Head };
})();
