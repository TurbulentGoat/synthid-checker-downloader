// ==UserScript==
// @name         Socials Video Downloader
// @namespace    https://threads.com
// @version      5.1.1
// @description  Download videos from Threads (button in each post's action bar) and Instagram (button on each video)
// @author       You
// @match        https://*.threads.com/*
// @match        https://*.threads.net/*
// @match        https://www.instagram.com/*
// @connect      fbcdn.net
// @connect      cdninstagram.com
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        GM_addStyle
// @grant        unsafeWindow
// @run-at       document-start
// @license      MIT
// ==/UserScript==

(function () {
  "use strict";

  // ── Config ──────────────────────────────────────────────────────────
  const TAG = "[TVD]";
  const SITE = /(^|\.)instagram\.com$/.test(location.hostname) ? "instagram" : "threads";
  const MARK = "data-tvd";            // marks the Threads action-bar item we inject
  const SHARE_LABELS = ["Share"];     // Threads: add your UI language's word for "Share" if it isn't English
  const IG_APP_ID = "936619743392459"; // Instagram's web app ID, sent with media-info lookups
  const MAX_CACHED = 3000;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const DL_PATH =
    "M12 2C12.5523 2 13 2.44772 13 3V13.5858L16.2929 10.2929C16.6834 9.90237 17.3166 9.90237 17.7071 10.2929C18.0976 10.6834 18.0976 11.3166 17.7071 11.7071L12.7071 16.7071C12.3166 17.0976 11.6834 17.0976 11.2929 16.7071L6.29289 11.7071C5.90237 11.3166 5.90237 10.6834 6.29289 10.2929C6.68342 9.90237 7.31658 9.90237 7.70711 10.2929L11 13.5858V3C11 2.44772 11.4477 2 12 2ZM4 17C4.55228 17 5 17.4477 5 18V20H19V18C19 17.4477 19.4477 17 20 17C20.5523 17 21 17.4477 21 18V20C21 21.1046 20.1046 22 19 22H5C3.89543 22 3 21.1046 3 20V18C3 17.4477 3.44772 17 4 17Z";

  const CSS = `
    .tvd-btn { cursor: pointer; transition: opacity .15s; }
    .tvd-btn:hover { opacity: .6; }
    .tvd-btn:active { opacity: .4; }
    .tvd-busy svg { animation: tvd-pulse .8s ease-in-out infinite; }
    .tvd-done svg { color: #1f9d55 !important; }
    .tvd-fail svg { color: #e0245e !important; }
    @keyframes tvd-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }

    .tvd-host { isolation: isolate; }
    .tvd-host-pos { position: relative; }
    .tvd-ov {
    position: absolute;
    top: 64px;
    left: 10px;
    z-index: 5;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border-radius: 15%;
    background: rgba(0, 0, 0, .55);
    color: #fff;
    cursor: pointer;
    opacity: 0;
    transition: opacity .15s, background .15s;
    -webkit-tap-highlight-color: transparent;
    }
    .tvd-ov svg { width: 18px; height: 18px; display: block; }
    .tvd-ov.tvd-story { top: 64px; }
    .tvd-ov:hover { background: rgba(0, 0, 0, .8); }
    .tvd-host:hover > .tvd-ov, .tvd-ov:focus-visible,
    .tvd-ov.tvd-busy, .tvd-ov.tvd-done, .tvd-ov.tvd-fail { opacity: 1; }
    @media (hover: none) { .tvd-ov { opacity: .9; } }

    .tvd-toast {
      position: fixed; left: 50%; bottom: 24px; z-index: 2147483647;
      transform: translate(-50%, 8px); opacity: 0; pointer-events: none;
      max-width: calc(100vw - 32px); padding: 8px 14px; border-radius: 10px;
      background: rgba(16, 16, 16, .92); color: #fff;
      font: 500 13px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
      transition: opacity .2s, transform .2s;
    }
    .tvd-toast.tvd-show { opacity: 1; transform: translate(-50%, 0); }
  `;

  // A failure we can explain to the user (shown as-is in the toast)
  class UserError extends Error {}

  // ── 1. Video URLs from Meta's own data (both sites share the same media format) ──
  // "code:<shortcode>" | "pk:<media id>"  ->  { user, items: [{ url, duration }] }
  const media = new Map();

  function bestUrl(versions) {
    if (!Array.isArray(versions)) return null;
    const usable = versions.filter((v) => v && typeof v.url === "string");
    usable.sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));
    return usable.length ? usable[0].url : null;
  }

  function videoItem(node) {
    const url = node && bestUrl(node.video_versions);
    if (!url) return null;
    return { url, duration: typeof node.video_duration === "number" ? node.video_duration : null };
  }

  // Media IDs exceed 2^53, so only trust string forms (pk, or the "<pk>_<owner>" id)
  function pkOf(node) {
    if (typeof node.pk === "string" && /^\d+$/.test(node.pk)) return node.pk;
    if (typeof node.id === "string") {
      const m = node.id.match(/^(\d+)(?:_\d+)?$/);
      if (m) return m[1];
    }
    if (typeof node.pk === "number" && Number.isSafeInteger(node.pk)) return String(node.pk);
    return null;
  }

  function userOf(node) {
    const u = node.user || node.owner || (node.caption && node.caption.user);
    return u && typeof u.username === "string" ? u.username : null;
  }

  function remember(key, entry) {
    media.delete(key); // re-insert so it counts as newest
    media.set(key, entry);
    if (media.size > MAX_CACHED) media.delete(media.keys().next().value);
  }

  // Walk any JSON looking for media objects: { code, pk, video_versions, carousel_media, user }
  function harvest(node, depth = 0) {
    if (!node || typeof node !== "object" || depth > 80) return;
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
      if (Array.isArray(node.carousel_media)) {
        for (const child of node.carousel_media) {
          const item = videoItem(child);
          if (!item) continue; // photo slide
          items.push(item);
          const childPk = pkOf(child);
          if (childPk) remember("pk:" + childPk, { user, items: [item] });
        }
      }
      if (items.length) {
        const entry = { user, items };
        if (typeof node.code === "string") remember("code:" + node.code, entry);
        const pk = pkOf(node);
        if (pk) remember("pk:" + pk, entry);
      }
    }
    for (const key in node) {
      if (isMedia && key === "carousel_media") continue; // already handled above
      const value = node[key];
      if (value && typeof value === "object") harvest(value, depth + 1);
    }
  }

  function harvestText(text) {
    if (typeof text !== "string" || !text.includes("video_versions")) return;
    const body = text.replace(/^\s*for\s*\(;;\);/, "");
    try {
      harvest(JSON.parse(body));
      return;
    } catch (_) {
      /* may be several JSON documents, one per line (streamed responses) */
    }
    for (const line of body.split("\n")) {
      const s = line.trim();
      if (s[0] !== "{" && s[0] !== "[") continue;
      try { harvest(JSON.parse(s)); } catch (_) { /* skip */ }
    }
  }

  const seenScripts = new WeakSet();
  function harvestEmbeddedJson() {
    for (const s of document.querySelectorAll('script[type="application/json"]')) {
      if (seenScripts.has(s)) continue;
      seenScripts.add(s);
      harvestText(s.textContent);
    }
  }

  // Read-only taps on the page's fetch/XHR. They never alter requests or responses,
  // and any failure inside them is swallowed so the page keeps working.
  function hookNetwork() {
    const page = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    // In a Firefox content sandbox, functions must be exported before the page can call them
    const xray = page !== window && typeof exportFunction === "function";
    const expose = (fn) => (xray ? exportFunction(fn, page) : fn);
    const isApi = (url) => /graphql|\/api\//i.test(url || "");

    try {
      const origFetch = page.fetch;
      if (typeof origFetch === "function") {
        page.fetch = expose(function (input) {
          const promise = origFetch.apply(page, arguments);
          try {
            const url = typeof input === "string" ? input : (input && input.url) || String(input);
            if (isApi(url)) {
              promise.then((res) => res.clone().text()).then(harvestText).catch(() => {});
            }
          } catch (_) { /* never break the page */ }
          return promise;
        });
      }
    } catch (e) {
      console.debug(TAG, "fetch tap unavailable:", e);
    }

    try {
      const proto = page.XMLHttpRequest && page.XMLHttpRequest.prototype;
      if (proto) {
        const origOpen = proto.open;
        const origSend = proto.send;
        proto.open = expose(function (method, url) {
          try { this.__tvdUrl = String(url); } catch (_) { /* ignore */ }
          return origOpen.apply(this, arguments);
        });
        proto.send = expose(function () {
          try {
            if (isApi(this.__tvdUrl)) {
              this.addEventListener("load", () => {
                try {
                  if (this.responseType === "" || this.responseType === "text") harvestText(this.responseText);
                } catch (_) { /* ignore */ }
              });
            }
          } catch (_) { /* never break the page */ }
          return origSend.apply(this, arguments);
        });
      }
    } catch (e) {
      console.debug(TAG, "XHR tap unavailable:", e);
    }
  }

  // ── 2. Resolving a <video> to a downloadable file ───────────────────
  // Instagram/Threads shortcodes are base64 media IDs (first 11 chars on long private codes)
  function shortcodeToPk(code) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let id = 0n;
    for (const ch of code.slice(0, 11)) {
      const i = alphabet.indexOf(ch);
      if (i < 0) return null;
      id = id * 64n + BigInt(i);
    }
    return id > 0n ? id.toString() : null;
  }

  function lookup(code, pk) {
    return (code && media.get("code:" + code)) || (pk && media.get("pk:" + pk)) || null;
  }

  async function igFetchInfo(pk) {
    const res = await fetch(`${location.origin}/api/v1/media/${pk}/info/`, {
      credentials: "include",
      headers: { "X-IG-App-ID": IG_APP_ID, "X-Requested-With": "XMLHttpRequest" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    harvestText(await res.text());
  }

  async function findEntry(code, pk) {
    let entry = lookup(code, pk);
    if (entry) return entry;
    harvestEmbeddedJson();
    entry = lookup(code, pk);
    if (entry || SITE !== "instagram") return entry;

    const id = pk || (code && shortcodeToPk(code));
    if (!id) return null;
    try {
      await igFetchInfo(id);
    } catch (e) {
      throw new UserError(`Instagram wouldn't return this video (${e.message}). Are you logged in?`);
    }
    return lookup(code, id);
  }

  function directUrl(video) {
    const candidates = [
      video.currentSrc,
      video.src,
      ...Array.from(video.querySelectorAll("source"), (s) => s.src),
    ];
    return candidates.find((u) => /^https?:\/\//i.test(u || "")) || null;
  }

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

  function fileName(parts) {
    return parts.filter(Boolean).join("_").replace(/[^\w.-]+/g, "_") + ".mp4";
  }

  function stamp() {
    return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  }

  // Returns { files: [{ url, name }], note? } for one <video> (or every video in its post with `all`)
  async function resolveVideo({ video, code, pk, user, idPart, domIndex = -1, domCount = -1, all = false }) {
    const id = idPart || code || stamp();
    const nameFor = (who, index, total) =>
      fileName([SITE, who, id, total > 1 && index >= 0 ? String(index + 1) : null]);

    if (!all) {
      const direct = directUrl(video);
      if (direct) return { files: [{ url: direct, name: nameFor(user, domIndex, domCount) }] };
    }
    if (!code && !pk) {
      throw new UserError("Couldn't work out which post this video belongs to. Open the post and try again.");
    }

    const entry = await findEntry(code, pk);
    if (!entry) {
      throw new UserError(
        SITE === "instagram"
          ? "Instagram didn't return a video file for this post."
          : "Couldn't find this video's file yet. Let it start playing, then try again."
      );
    }

    const who = user || entry.user;
    const total = entry.items.length;
    const fileFor = (it) => ({ url: it.url, name: nameFor(who, entry.items.indexOf(it), total) });
    if (all) return { files: entry.items.map(fileFor) };

    const item = pickItem(entry.items, video, domIndex, domCount);
    if (item) return { files: [fileFor(item)] };
    return {
      files: entry.items.map(fileFor),
      note: `Couldn't tell which slide this is, so saved all ${total} videos from the post.`,
    };
  }

  // ── 3. Downloading ──────────────────────────────────────────────────
  function saveBlob(blob, name) {
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = name;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 30000);
  }

  // GM_download first, then GM_xmlhttpRequest -> blob -> <a download>.
  function download(url, name) {
    return new Promise((resolve, reject) => {
      const viaXhr = () => {
        if (typeof GM_xmlhttpRequest !== "function") return reject(new Error("GM_xmlhttpRequest unavailable"));
        GM_xmlhttpRequest({
          method: "GET",
          url,
          responseType: "blob",
          onload: (r) => {
            if (r.status >= 200 && r.status < 300 && r.response) {
              saveBlob(r.response, name);
              resolve();
            } else {
              reject(new Error(`HTTP ${r.status}`));
            }
          },
          onerror: () => reject(new Error("network error")),
          ontimeout: () => reject(new Error("timeout")),
        });
      };

      if (typeof GM_download !== "function") return viaXhr();
      try {
        GM_download({
          url,
          name,
          onload: () => resolve(),
          onerror: (e) => {
            console.debug(TAG, "GM_download failed, trying XHR:", (e && e.error) || e);
            viaXhr();
          },
          ontimeout: viaXhr,
        });
      } catch (_) {
        viaXhr();
      }
    });
  }

  function openTab(url) {
    if (typeof GM_openInTab === "function") GM_openInTab(url, { active: true });
    else window.open(url, "_blank", "noopener");
  }

  // ── 4. Shared UI ────────────────────────────────────────────────────
  let toastEl = null;
  let toastTimer = 0;
  function toast(message) {
    if (!toastEl || !toastEl.isConnected) {
      toastEl = document.createElement("div");
      toastEl.className = "tvd-toast";
      toastEl.setAttribute("role", "status");
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.classList.add("tvd-show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("tvd-show"), 4000);
  }

  function flash(btn, state) {
    btn.classList.remove("tvd-done", "tvd-fail");
    btn.classList.add(`tvd-${state}`);
    setTimeout(() => btn.classList.remove(`tvd-${state}`), 1800);
  }

  function setBusy(btn, on) {
    btn.classList.toggle("tvd-busy", on);
    btn.setAttribute("aria-busy", String(on));
  }

  function downloadIcon(base) {
    const svg = base ? base.cloneNode(false) : document.createElementNS(SVG_NS, "svg");
    if (!base) svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-label", "Download video");
    svg.setAttribute("title", "Download video");
    svg.setAttribute("role", "img");
    const title = document.createElementNS(SVG_NS, "title");
    title.textContent = "Download video";
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", DL_PATH);
    path.setAttribute("fill", "currentColor");
    svg.append(title, path);
    return svg;
  }

  // `job` returns { files, note?, missing? }; this downloads them and reports back.
  async function run(btn, job) {
    if (btn.classList.contains("tvd-busy")) return;
    setBusy(btn, true);
    try {
      const { files, note, missing = 0 } = await job();
      const unique = [...new Map(files.map((f) => [f.url, f])).values()];
      const saved = [];
      const opened = [];
      for (const f of unique) {
        try {
          await download(f.url, f.name);
          saved.push(f.name);
        } catch (err) {
          console.warn(TAG, "download failed, opening in a tab instead:", err);
          openTab(f.url);
          opened.push(f.name);
        }
      }

      if (saved.length && !opened.length && !missing) {
        flash(btn, "done");
        toast(note || (saved.length === 1 ? `Saved ${saved[0]}` : `Saved ${saved.length} videos`));
      } else if (saved.length + opened.length + missing === 1) {
        flash(btn, "fail");
        toast(
          opened.length
            ? "Download was blocked, so the video opened in a new tab. Save it from there."
            : "Couldn't find this video's file yet. Let it start playing, then try again."
        );
      } else {
        flash(btn, "fail");
        const bits = [];
        if (saved.length) bits.push(`Saved ${saved.length}`);
        if (opened.length) bits.push(`opened ${opened.length} in new tabs (download blocked)`);
        if (missing) bits.push(`couldn't find ${missing} (let them play, then retry)`);
        toast(bits.join(", ") + ".");
      }
    } catch (err) {
      flash(btn, "fail");
      if (err instanceof UserError) {
        toast(err.message);
      } else {
        console.error(TAG, err);
        toast("Download failed. Check the console for details.");
      }
    } finally {
      setBusy(btn, false);
    }
  }

  // Click/keyboard activation, and keep presses from reaching the post underneath
  // (which would open it, follow a link, or pause/mute the video).
  function wire(btn, job) {
    const swallow = (e) => {
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend", "dblclick"]) {
      btn.addEventListener(type, swallow);
    }
    const activate = (e) => {
      e.preventDefault();
      swallow(e);
      run(btn, () => job(e));
    };
    btn.addEventListener("click", activate);
    btn.addEventListener("auxclick", (e) => {
      e.preventDefault();
      swallow(e);
    });
    btn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") activate(e);
    });
  }

  function visibleArea(el, clip) {
    const r = el.getBoundingClientRect();
    const left = Math.max(r.left, clip ? clip.left : 0, 0);
    const right = Math.min(r.right, clip ? clip.right : Infinity, window.innerWidth);
    const top = Math.max(r.top, clip ? clip.top : 0, 0);
    const bottom = Math.min(r.bottom, clip ? clip.bottom : Infinity, window.innerHeight);
    return Math.max(0, right - left) * Math.max(0, bottom - top);
  }

  // ── 5. Threads: button in the action bar ────────────────────────────
  const SHARE_SELECTOR = SHARE_LABELS
    .flatMap((l) => [`svg[aria-label="${l}"]`, `svg[title="${l}"]`])
    .join(",");

  function findShareIcons(root) {
    const found = new Set(root.querySelectorAll(SHARE_SELECTOR));
    for (const t of root.querySelectorAll("svg > title")) {
      if (SHARE_LABELS.includes(t.textContent.trim())) found.add(t.parentNode);
    }
    return [...found];
  }

  // Share svg -> its [role=button] -> the item wrapper -> the action bar
  function actionBarParts(shareSvg) {
    const btn = shareSvg.closest('[role="button"]');
    const item = btn && btn.parentElement;
    const bar = item && item.parentElement;
    return btn && item && bar ? { item, bar } : null;
  }

  // Each post is wrapped in [data-pressable-container]. If that ever disappears,
  // fall back to the largest ancestor that contains only this one Share icon,
  // so a text reply can never "borrow" the video from the post above it.
  function getPost(bar) {
    const tagged = bar.closest("[data-pressable-container]");
    if (tagged) return tagged;
    let el = bar;
    while (
      el.parentElement &&
      el.parentElement !== document.body &&
      findShareIcons(el.parentElement).length <= 1
    ) {
      el = el.parentElement;
    }
    return el;
  }

  function threadsMeta(post) {
    const timeLink = post.querySelector('a[href*="/post/"] time');
    const link = (timeLink && timeLink.closest("a")) || post.querySelector('a[href*="/post/"]');
    const path = link ? link.pathname : location.pathname;
    const m = path.match(/\/@([^/]+)\/post\/([^/?#]+)/);
    return m ? { user: m[1], code: m[2] } : { user: null, code: null };
  }

  // In a carousel: prefer the video that's playing, else the most visible one.
  function pickVideo(videos, post) {
    if (videos.length === 1) return videos[0];
    const playing = videos.filter((v) => !v.paused && !v.ended);
    if (playing.length === 1) return playing[0];
    const clip = post.getBoundingClientRect();
    let best = videos[0];
    let bestArea = -1;
    for (const v of videos) {
      const area = visibleArea(v, clip);
      if (area > bestArea) {
        best = v;
        bestArea = area;
      }
    }
    return best;
  }

  async function threadsJob(btn, ev) {
    const item = btn.closest(`[${MARK}]`);
    const bar = item && item.parentElement;
    if (!bar) throw new Error("download button is no longer in an action bar");
    const post = getPost(bar);
    const videos = [...post.querySelectorAll("video")];
    if (!videos.length) throw new UserError("No video found in this post.");

    const meta = threadsMeta(post);
    const targets = ev.shiftKey ? videos : [pickVideo(videos, post)];
    const files = [];
    let missing = 0;
    for (const video of targets) {
      try {
        const r = await resolveVideo({
          video,
          code: meta.code,
          user: meta.user,
          domIndex: videos.indexOf(video),
          domCount: videos.length,
        });
        files.push(...r.files);
      } catch (e) {
        if (targets.length === 1) throw e;
        missing++;
      }
    }
    return { files, missing };
  }

  // Clone the Share item so spacing, size and colours match the other icons.
  function buildThreadsItem(shareItem) {
    const item = shareItem.cloneNode(true);
    item.setAttribute(MARK, "");
    const oldSvg = item.querySelector("svg");
    if (oldSvg) oldSvg.replaceWith(downloadIcon(oldSvg));
    item.querySelectorAll("span").forEach((s) => {
      if (!s.querySelector("svg")) s.remove(); // drop the share count
    });

    const btn = item.querySelector('[role="button"]') || item;
    btn.classList.add("tvd-btn");
    btn.setAttribute("aria-label", "Download video");
    btn.setAttribute("title", "Download video (Shift+click: every video in the post)");
    btn.removeAttribute("aria-haspopup");
    btn.removeAttribute("aria-expanded");
    wire(btn, (e) => threadsJob(btn, e));
    return item;
  }

  function scanThreads() {
    for (const svg of findShareIcons(document)) {
      if (svg.closest(`[${MARK}]`)) continue;
      const parts = actionBarParts(svg);
      if (!parts) continue;
      const { item, bar } = parts;
      if (bar.querySelector(`:scope > [${MARK}]`)) continue;
      if (!getPost(bar).querySelector("video")) continue;
      bar.appendChild(buildThreadsItem(item));
    }
  }

  // ── 6. Instagram: button on each video ──────────────────────────────
  const IG_POST_KINDS = new Set(["p", "reel", "reels", "tv"]);

  // /p/CODE/, /reel/CODE/, /reels/CODE/, /<user>/p/CODE/, /stories/<user>/<pk>/
  function parseIgPath(path) {
    const parts = path.split("/").filter(Boolean);
    if (parts[0] === "stories") {
      if (parts[1] === "highlights") return { kind: "highlight" };
      if (parts[1] && /^\d+$/.test(parts[2] || "")) return { kind: "story", user: parts[1], pk: parts[2] };
      return { kind: "stories" };
    }
    for (let i = 0; i <= 1 && i < parts.length - 1; i++) {
      const code = parts[i + 1];
      if (IG_POST_KINDS.has(parts[i]) && code !== "audio" && /^[A-Za-z0-9_-]{5,}$/.test(code)) {
        return { kind: "post", code, user: i === 1 ? parts[0] : null };
      }
    }
    return null;
  }

  function igCodesIn(el) {
    const codes = new Map(); // code -> username from the link, if any
    for (const a of el.querySelectorAll("a[href]")) {
      if (a.hostname !== location.hostname) continue;
      const m = parseIgPath(a.pathname);
      if (m && m.kind === "post" && !codes.has(m.code)) codes.set(m.code, m.user);
    }
    return codes;
  }

  // The username link in a post header: <a href="/name/">name</a>
  function igUserIn(scope) {
    for (const a of scope.querySelectorAll("a[href]")) {
      if (a.hostname !== location.hostname) continue;
      const m = a.pathname.match(/^\/([A-Za-z0-9._]{1,30})\/?$/);
      if (m && a.textContent.trim() === m[1]) return m[1];
    }
    return null;
  }

  // Playing, or the biggest video on screen
  function isMainVideo(video) {
    const videos = [...document.querySelectorAll("video")];
    if (videos.length <= 1 || !video.paused) return true;
    const mine = visibleArea(video);
    return videos.every((v) => v === video || visibleArea(v) <= mine);
  }

  function igContext(video) {
    const here = parseIgPath(location.pathname) || {};
    if (here.kind === "story") return { pk: here.pk, user: here.user, idPart: `story_${here.pk}` };
    if (here.kind === "highlight" || here.kind === "stories") {
      if (directUrl(video)) return {};
      throw new UserError("Story highlights aren't supported yet. Open the story from the profile instead.");
    }

    // The video usually sits inside a link to its own post
    let code = null;
    let user = null;
    const link = video.closest("a[href]");
    const fromLink = link && link.hostname === location.hostname && parseIgPath(link.pathname);
    if (fromLink && fromLink.kind === "post") {
      code = fromLink.code;
      user = fromLink.user;
    }

    // Otherwise, grow outwards until we reach a container that mentions exactly one post
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
      if (parent.tagName === "ARTICLE") break;
    }

    // Reel pages: the video is the page's own post
    if (!code && here.kind === "post" && isMainVideo(video)) {
      code = here.code;
      user = user || here.user;
    }
    if (!user && tied) user = igUserIn(scope);
    return { code, user };
  }

  async function instagramJob(video, ev) {
    const ctx = igContext(video);
    return resolveVideo({ video, ...ctx, all: ev.shiftKey });
  }

  // Highest ancestor that is the same box as the video, so the button sits above
  // Instagram's transparent player overlay. Never climbs out of the slide/link/post.
  const IG_STOP_TAGS = new Set(["A", "ARTICLE", "LI", "UL", "MAIN", "SECTION", "BODY", "HTML"]);
  function overlayHost(video) {
    const vr = video.getBoundingClientRect();
    const sameBox = (el) => {
      const r = el.getBoundingClientRect();
      return (
        Math.abs(r.width - vr.width) <= 4 && Math.abs(r.height - vr.height) <= 4 &&
        Math.abs(r.top - vr.top) <= 4 && Math.abs(r.left - vr.left) <= 4
      );
    };
    let host = video.parentElement;
    if (!host) return null;
    for (let el = host.parentElement; el; el = el.parentElement) {
      if (IG_STOP_TAGS.has(el.tagName) || el.querySelectorAll("video").length > 1 || !sameBox(el)) break;
      host = el;
    }
    return host;
  }

  const overlays = new WeakMap(); // video -> our button
  const videoOf = new WeakMap();  // our button -> its video
  const declined = new WeakMap(); // video -> the button that already covers it

  // Say once if another copy of this script is also running on the page
  let warnedDuplicate = false;
  function warnDuplicate(detail) {
    if (warnedDuplicate) return;
    warnedDuplicate = true;
    const msg =
      "Two copies of the video downloader are running" + (detail ? ` (${detail})` : "") +
      ". Disable one in your userscript manager.";
    console.warn(TAG, msg);
    if (document.body) toast(msg);
    else document.addEventListener("DOMContentLoaded", () => toast(msg), { once: true });
  }

  function isShown(el) {
    return typeof el.checkVisibility === "function"
      ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      : true;
  }

  // Close together in the page (same post), not merely overlapping on screen:
  // a post opened over the feed overlaps feed videos but lives elsewhere in the page.
  function related(a, b) {
    let el = a;
    for (let i = 0; i < 12 && el; i++, el = el.parentElement) {
      if (el.contains(b)) return true;
    }
    return false;
  }

  // A button already covering this spot: one in the same host, or one on another
  // <video> that occupies the same box in the same post.
  function coveringButton(host) {
    const same = host.querySelector(":scope > .tvd-ov");
    if (same) return same;
    const hr = host.getBoundingClientRect();
    const area = hr.width * hr.height;
    if (area < 1) return null;
    for (const btn of document.querySelectorAll(".tvd-ov")) {
      const other = btn.parentElement;
      if (!other || other === host || !related(host, other)) continue;
      const r = other.getBoundingClientRect();
      const w = Math.min(hr.right, r.right) - Math.max(hr.left, r.left);
      const h = Math.min(hr.bottom, r.bottom) - Math.max(hr.top, r.top);
      const smaller = Math.min(area, r.width * r.height);
      if (w > 0 && h > 0 && smaller > 0 && (w * h) / smaller >= 0.6) return btn;
    }
    return null;
  }

  // Drop our buttons whose video was swapped out or moved, and give way to a button
  // another copy of the script put in the same place.
  function pruneStale() {
    for (const btn of document.querySelectorAll(".tvd-ov")) {
      const video = videoOf.get(btn);
      if (!video) continue; // not ours
      const host = btn.parentElement;
      const gone = !video.isConnected || !host || !host.contains(video);
      const foreign =
        !!host && [...host.querySelectorAll(":scope > .tvd-ov")].some((b) => b !== btn && !videoOf.has(b));
      if (!gone && !foreign) continue;
      if (foreign) warnDuplicate();
      btn.remove();
      if (overlays.get(video) === btn) overlays.delete(video);
    }
  }

  function attachOverlay(video) {
    pruneStale();
    const existing = overlays.get(video);
    if (existing && existing.isConnected) return;
    const host = overlayHost(video);
    if (!host) return;

    const clash = coveringButton(host);
    if (clash) {
      const clashVideo = videoOf.get(clash);
      if (!clashVideo) warnDuplicate(); // put there by another copy of this script
      if (!clashVideo || isShown(clashVideo) || !isShown(video)) {
        declined.set(video, clash);
        return;
      }
      // Ours, but sitting on a hidden copy of the video: move it to the visible one
      clash.remove();
      overlays.delete(clashVideo);
    }

    host.classList.add("tvd-host");
    const pos = getComputedStyle(host).position;
    if (!pos || pos === "static") host.classList.add("tvd-host-pos");

    const btn = document.createElement("div");
    btn.className = "tvd-ov";
    btn.setAttribute("role", "button");
    btn.setAttribute("tabindex", "0");
    btn.setAttribute("aria-label", "Download video");
    btn.setAttribute("title", "Download video (Shift+click: every video in the post)");
    // Stories and highlights have a header over the video, so the button sits below it
    if (location.pathname.startsWith("/stories/")) btn.classList.add("tvd-story");
    btn.appendChild(downloadIcon());
    wire(btn, (e) => instagramJob(video, e));

    host.appendChild(btn);
    overlays.set(video, btn);
    videoOf.set(btn, video);
    declined.delete(video);
  }

  // Attach when a video first scrolls into view (it has a real size by then)
  const pending = new WeakSet();
  const io =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => {
          for (const e of entries) {
            if (!e.isIntersecting || e.boundingClientRect.width < 1) continue;
            io.unobserve(e.target);
            pending.delete(e.target);
            attachOverlay(e.target);
          }
        })
      : null;

  function scanInstagram() {
    pruneStale();
    for (const video of document.querySelectorAll("video")) {
      const btn = overlays.get(video);
      if (btn && btn.isConnected) continue;
      if (btn) overlays.delete(video); // React re-rendered and dropped our button
      const cover = declined.get(video);
      if (cover && cover.isConnected) continue; // another button already covers this video
      declined.delete(video);
      if (!io) {
        attachOverlay(video);
      } else if (!pending.has(video)) {
        pending.add(video);
        io.observe(video);
      }
    }
  }

  // ── Init ────────────────────────────────────────────────────────────
  // Only one copy may run per page (e.g. the script installed twice under different names)
  const myName = (typeof GM_info !== "undefined" && GM_info.script && GM_info.script.name) || "video downloader";
  const otherCopy = document.documentElement.getAttribute("data-tvd-running");
  if (otherCopy) {
    warnDuplicate(`"${otherCopy}" and "${myName}"`);
    return;
  }
  document.documentElement.setAttribute("data-tvd-running", myName);

  hookNetwork(); // as early as possible, to catch the first API responses

  if (typeof GM_addStyle === "function") {
    GM_addStyle(CSS);
  } else {
    const style = document.createElement("style");
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  const scan = SITE === "instagram" ? scanInstagram : scanThreads;
  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      try {
        scan();
      } catch (e) {
        console.error(TAG, "scan failed:", e);
      }
    });
  }

  function start() {
    const idle = window.requestIdleCallback
      ? (cb) => window.requestIdleCallback(cb)
      : (cb) => setTimeout(cb, 500);
    idle(harvestEmbeddedJson);
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    schedule();
    console.info(TAG, `Video downloader active on ${SITE}`);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();