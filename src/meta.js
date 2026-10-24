// Instagram and Threads: works out which post a <video> belongs to, then asks meta-main.js for
// that post's video file. Unlike the stream matching in streams.js, that file has sound and the
// video doesn't need to have played first. content.js uses it for both checks and downloads.
(() => {
  const SITE = /(^|\.)instagram\.com$/.test(location.hostname) ? 'instagram' : 'threads';
  const TAG = 'synthid-meta';
  const LOOKUP_TIMEOUT_MS = 20 * 1000;
  const IG_POST_KINDS = new Set(['p', 'reel', 'reels', 'tv']);

  // ---- Asking meta-main.js for a post's files --------------------------------------------

  const waiting = new Map(); // lookup id -> settle(reply)
  let nextId = 0;

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.[TAG] !== 'entry') return;
    waiting.get(e.data.id)?.(e.data);
  });

  // Resolves with { user, items: [{ url, duration }] }, or null if the post has no known video.
  function lookup(code, pk) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const settle = (reply) => {
        clearTimeout(timer);
        waiting.delete(id);
        if (reply.error) {
          reject(new Error(reply.error));
          return;
        }
        // Only accept real file URLs, whatever else might post messages on the page.
        const items = reply.entry?.items?.filter((item) => /^https:\/\//.test(item?.url)) ?? [];
        resolve(items.length ? { user: reply.entry.user, items } : null);
      };
      const timer = setTimeout(
        () => settle({ error: 'Couldn’t look up this post. Reload the page and try again.' }),
        LOOKUP_TIMEOUT_MS,
      );
      waiting.set(id, settle);
      window.postMessage({ [TAG]: 'lookup', id, code, pk }, location.origin);
    });
  }

  // ---- Which post a video belongs to -----------------------------------------------------

  function directUrl(video) {
    const candidates = [video.currentSrc, video.src, ...Array.from(video.querySelectorAll('source'), (s) => s.src)];
    return candidates.find((url) => /^https?:\/\//i.test(url || '')) || null;
  }

  function visibleArea(el, clip) {
    const r = el.getBoundingClientRect();
    const left = Math.max(r.left, clip ? clip.left : 0, 0);
    const right = Math.min(r.right, clip ? clip.right : Infinity, innerWidth);
    const top = Math.max(r.top, clip ? clip.top : 0, 0);
    const bottom = Math.min(r.bottom, clip ? clip.bottom : Infinity, innerHeight);
    return Math.max(0, right - left) * Math.max(0, bottom - top);
  }

  // Instagram: /p/CODE/, /reel/CODE/, /reels/CODE/, /<user>/p/CODE/, /stories/<user>/<pk>/
  function parseIgPath(path) {
    const parts = path.split('/').filter(Boolean);
    if (parts[0] === 'stories') {
      if (parts[1] === 'highlights') return { kind: 'highlight' };
      if (parts[1] && /^\d+$/.test(parts[2] || '')) return { kind: 'story', user: parts[1], pk: parts[2] };
      return { kind: 'stories' };
    }
    for (let i = 0; i <= 1 && i < parts.length - 1; i++) {
      const code = parts[i + 1];
      if (IG_POST_KINDS.has(parts[i]) && code !== 'audio' && /^[A-Za-z0-9_-]{5,}$/.test(code)) {
        return { kind: 'post', code, user: i === 1 ? parts[0] : null };
      }
    }
    return null;
  }

  function igCodesIn(el) {
    const codes = new Map(); // code -> username from the link, if any
    for (const a of el.querySelectorAll('a[href]')) {
      if (a.hostname !== location.hostname) continue;
      const m = parseIgPath(a.pathname);
      if (m?.kind === 'post' && !codes.has(m.code)) codes.set(m.code, m.user);
    }
    return codes;
  }

  // The username link in a post header: <a href="/name/">name</a>
  function igUserIn(scope) {
    for (const a of scope.querySelectorAll('a[href]')) {
      if (a.hostname !== location.hostname) continue;
      const m = a.pathname.match(/^\/([A-Za-z0-9._]{1,30})\/?$/);
      if (m && a.textContent.trim() === m[1]) return m[1];
    }
    return null;
  }

  // Playing, or the biggest video on screen.
  function isMainVideo(video) {
    const videos = [...document.querySelectorAll('video')];
    if (videos.length <= 1 || !video.paused) return true;
    const mine = visibleArea(video);
    return videos.every((v) => v === video || visibleArea(v) <= mine);
  }

  function igContext(video) {
    const here = parseIgPath(location.pathname) || {};
    if (here.kind === 'story') return { pk: here.pk, user: here.user, idPart: `story_${here.pk}` };
    if (here.kind === 'highlight' || here.kind === 'stories') {
      if (directUrl(video)) return {};
      throw new Error('Story highlights aren’t supported yet. Open the story from the profile instead.');
    }

    // The video usually sits inside a link to its own post.
    let code = null;
    let user = null;
    const link = video.closest('a[href]');
    const fromLink = link && link.hostname === location.hostname && parseIgPath(link.pathname);
    if (fromLink?.kind === 'post') {
      code = fromLink.code;
      user = fromLink.user;
    }

    // Otherwise, grow outwards until we reach a container that mentions exactly one post.
    let scope = video;
    let tied = false;
    for (let i = 0; i < 40 && scope.parentElement && scope.parentElement !== document.body; i++) {
      const parent = scope.parentElement;
      const codes = igCodesIn(parent);
      if (codes.size > 1 || (code && codes.size === 1 && !codes.has(code))) break;
      scope = parent;
      if (codes.size === 1) {
        tied = true;
        if (!code) {
          const [c, u] = codes.entries().next().value;
          code = c;
          user = user || u;
        }
      }
      if (parent.tagName === 'ARTICLE') break;
    }

    // Reel pages: the video is the page's own post.
    if (!code && here.kind === 'post' && isMainVideo(video)) {
      code = here.code;
      user = user || here.user;
    }
    if (!user && tied) user = igUserIn(scope);
    return { code, user };
  }

  // Threads: /@user/post/CODE
  const parseThreadsPath = (path) => path.match(/\/@([^/]+)\/post\/([^/?#]+)/);

  // Each post is wrapped in [data-pressable-container]. If that ever disappears, fall back to the
  // largest ancestor that links to only one post, so a reply can't borrow the video above it.
  function threadsPost(video) {
    const tagged = video.closest('[data-pressable-container]');
    if (tagged) return tagged;
    const postsIn = (el) =>
      new Set([...el.querySelectorAll('a[href*="/post/"]')].map((a) => parseThreadsPath(a.pathname)?.[2]).filter(Boolean));
    let el = video;
    while (el.parentElement && el.parentElement !== document.body && postsIn(el.parentElement).size <= 1) {
      el = el.parentElement;
    }
    return el;
  }

  function threadsContext(video) {
    const post = threadsPost(video);
    // The post's own link wraps its timestamp; a quoted post's link comes later.
    const link = post.querySelector('a[href*="/post/"] time')?.closest('a') ?? post.querySelector('a[href*="/post/"]');
    const m = parseThreadsPath(link ? link.pathname : location.pathname);
    return { user: m?.[1] ?? null, code: m?.[2] ?? null, videos: [...post.querySelectorAll('video')] };
  }

  // ---- From a video to its file ----------------------------------------------------------

  // Which of the post's videos is this <video>? Match by duration, then by position.
  function pickItem(items, video, domIndex, domCount) {
    if (items.length === 1) return items[0];
    const d = video.duration;
    if (Number.isFinite(d) && d > 0) {
      const close = items.filter((it) => it.duration != null && Math.abs(it.duration - d) < 0.6);
      if (close.length === 1) return close[0];
    }
    if (domCount === items.length && domIndex >= 0) return items[domIndex];
    return null;
  }

  async function resolveVideo({ video, code, pk, user, idPart, domIndex = -1, domCount = -1, all = false }) {
    const { fileName, timestamp } = globalThis.SynthIDShared;
    const id = idPart || code || timestamp();
    const nameFor = (who, index, total) =>
      fileName([SITE, who, id, total > 1 && index >= 0 ? String(index + 1) : null], 'mp4');

    if (!all) {
      const direct = directUrl(video);
      if (direct) return { files: [{ url: direct, name: nameFor(user, domIndex, domCount) }] };
    }
    if (!code && !pk) throw new Error('Couldn’t work out which post this video belongs to. Open the post and try again.');

    const entry = await lookup(code, pk);
    if (!entry) {
      throw new Error(
        SITE === 'instagram'
          ? 'Instagram didn’t return a video file for this post.'
          : 'Couldn’t find this video’s file yet. Let it start playing, then try again.',
      );
    }
    const who = user || entry.user;
    const total = entry.items.length;
    const fileFor = (item) => ({ url: item.url, name: nameFor(who, entry.items.indexOf(item), total) });
    if (all) return { files: entry.items.map(fileFor) };

    const item = pickItem(entry.items, video, domIndex, domCount);
    if (item) return { files: [fileFor(item)] };
    return {
      files: entry.items.map(fileFor),
      note: `Couldn’t tell which slide this is, so saved all ${total} videos from the post.`,
    };
  }

  // Returns { files: [{ url, name }], note? } for one <video>, or with `all` for every video in
  // its post.
  async function resolve(video, all = false) {
    if (SITE === 'instagram') return resolveVideo({ video, ...igContext(video), all });

    const { videos, ...post } = threadsContext(video);
    const forVideo = (v) => resolveVideo({ video: v, ...post, domIndex: videos.indexOf(v), domCount: videos.length });
    if (!all) return forVideo(video);
    const files = [];
    let missing = 0;
    for (const v of videos) {
      try {
        files.push(...(await forVideo(v)).files);
      } catch (err) {
        if (videos.length === 1) throw err;
        missing++;
      }
    }
    if (!files.length) throw new Error('Couldn’t find these videos’ files yet. Let them play, then try again.');
    return {
      files,
      note: missing
        ? `Saved ${files.length}, but couldn’t find ${missing} yet. Let them play, then try again.`
        : undefined,
    };
  }

  globalThis.SynthIDMeta = { resolve };
})();
