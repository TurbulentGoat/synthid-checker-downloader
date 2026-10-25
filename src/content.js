// Page content script: shows a "Check SynthID" button on images and videos, and a result badge
// after a check. Videos also get a download button, and on Instagram and Facebook a play/pause
// button. With a mouse the buttons follow the hovered media; on touch screens every visible image
// and video gets them.
(() => {
  if (window.__synthidChecker) return;
  window.__synthidChecker = true;

  const { api, sendBlob, createBlobReceiver, sniffMediaType, fileName, timestamp } = globalThis.SynthIDShared;
  const MIN_SIZE = 80; // CSS px; skips icons, avatars and tracking pixels
  // File types synthid.com accepts, as listed by its upload box.
  const CHECKABLE = /\.(jpe?g|png|bmp|webp|avif|hei[cf]|tiff?|gif|wav|mp3|ogg|flac|aac|m4a|mp4|mov|webm)$/i;
  const touchOnly = matchMedia('(hover: none)').matches;
  const RETRYABLE = new Set(['error', 'signin', 'terms']);
  // Social feeds get a column of buttons beside each post, and a pause button. `insideTop` is
  // where the column starts when it has to go inside the media: Instagram draws its post header
  // over the top of photos and videos, Facebook puts it above them.
  const FEEDS = [
    { host: /(^|\.)instagram\.com$/, insideTop: 64 },
    { host: /(^|\.)facebook\.com$/, insideTop: 10 },
  ];
  const feed = FEEDS.find((site) => site.host.test(location.hostname));
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const PAUSE_ICON =
    'M6.5 4A1.5 1.5 0 0 0 5 5.5v13A1.5 1.5 0 0 0 6.5 20h2a1.5 1.5 0 0 0 1.5-1.5v-13A1.5 1.5 0 0 0 8.5 4zm9 0A1.5 1.5 0 0 0 14 5.5v13a1.5 1.5 0 0 0 1.5 1.5h2a1.5 1.5 0 0 0 1.5-1.5v-13A1.5 1.5 0 0 0 17.5 4z';
  const PLAY_ICON = 'M7 4.75v14.5a1 1 0 0 0 1.53.85l11.6-7.25a1 1 0 0 0 0-1.7L8.53 3.9A1 1 0 0 0 7 4.75z';
  const DOWNLOAD_ICON =
    'M12 2C12.5523 2 13 2.44772 13 3V13.5858L16.2929 10.2929C16.6834 9.90237 17.3166 9.90237 17.7071 10.2929C18.0976 10.6834 18.0976 11.3166 17.7071 11.7071L12.7071 16.7071C12.3166 17.0976 11.6834 17.0976 11.2929 16.7071L6.29289 11.7071C5.90237 11.3166 5.90237 10.6834 6.29289 10.2929C6.68342 9.90237 7.31658 9.90237 7.70711 10.2929L11 13.5858V3C11 2.44772 11.4477 2 12 2ZM4 17C4.55228 17 5 17.4477 5 18V20H19V18C19 17.4477 19.4477 17 20 17C20.5523 17 21 17.4477 21 18V20C21 21.1046 20.1046 22 19 22H5C3.89543 22 3 21.1046 3 20V18C3 17.4477 3.44772 17 4 17Z';

  const host = document.createElement('synthid-checker');
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const css = `
    .item {
      --size: 36px; --glyph: 18px; --font: 12px; --chip: rgba(18, 18, 18, 0.6);
      position: fixed; top: 0; left: 0; display: none; align-items: flex-start; gap: 6px;
    }
    .item.visible { display: flex; animation: appear 0.15s ease-out; }
    .item[data-layout="column"], .item[data-layout="outside"] { flex-direction: column; }
    /* On the page rather than the media: solid, in the dark grey of the sites' own text. */
    .item[data-layout="outside"] { align-items: flex-end; --chip: rgba(38, 38, 38, 0.94); }
    .item[data-layout="compact"] { --size: 26px; --glyph: 14px; --font: 11px; gap: 4px; }
    .touch .item { --size: 34px; --font: 13px; }
    .touch .item[data-layout="compact"] { --size: 30px; --glyph: 16px; --font: 12px; }
    .item[data-layout="compact"] .pause { display: none; }
    /* Beside a line of text: no taller than it. */
    .item[data-layout="inline"] { --size: 20px; --font: 10px; }
    .touch .item[data-layout="inline"] { --size: 26px; --font: 11px; }
    @keyframes appear { from { opacity: 0; } }
    .badge, .icon {
      box-sizing: border-box; min-width: var(--size); min-height: var(--size); margin: 0;
      border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 5px; color: #fff;
      background: var(--chip); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
      -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
      cursor: pointer; pointer-events: auto; -webkit-tap-highlight-color: transparent;
      transition: box-shadow 0.15s;
    }
    /* An inset shadow tints any background, including the result colours. */
    .badge:hover, .icon:hover { box-shadow: inset 0 0 0 100px rgba(255, 255, 255, 0.14), 0 1px 3px rgba(0, 0, 0, 0.25); }
    .badge:focus-visible, .icon:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 2px; } 
    .badge {
      display: inline-flex; align-items: center; justify-content: center; gap: 6px; max-width: 240px;
      padding: 0 10px; font: 600 var(--font)/16px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      text-align: left;
    }
    .badge.short { padding: 0 4px; }
    .badge.expanded { padding: 8px 10px; justify-content: flex-start; }
    .icon { flex: none; display: grid; place-items: center; width: var(--size); height: var(--size); padding: 0; }
    .icon svg { width: var(--glyph); height: var(--glyph); }
    .save[data-state="busy"] svg { animation: pulse 0.8s ease-in-out infinite; }
    .save[data-state="done"] { background: #137333; }
    .save[data-state="failed"] { background: #c5221f; }
    @keyframes pulse { 50% { opacity: 0.3; } }
    .toast {
      position: fixed; left: 16px; right: 16px; bottom: 24px; width: fit-content; margin: 0 auto;
      box-sizing: border-box; padding: 8px 14px; border-radius: 10px;
      font: 500 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: #fff; background: rgba(16, 16, 16, 0.92);
      opacity: 0; transform: translateY(8px); transition: opacity 0.2s, transform 0.2s;
    }
    .toast.show { opacity: 1; transform: none; }
    .badge[data-status="detected"] { background: #c5221f; }
    .badge[data-status="not_detected"] { background: #137333; }
    .badge[data-status="uncertain"] { background: #b06000; }
    .badge[data-status="inconclusive"], .badge[data-status="error"],
    .badge[data-status="signin"], .badge[data-status="terms"] { background: #5f6368; }
    .text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge.expanded { border-radius: 5px; }
    .badge.expanded .text { white-space: normal; }
    .detail { display: block; font-weight: 400; margin-top: 2px; }
    .spinner {
      flex: none; width: 10px; height: 10px; border: 2px solid rgba(255, 255, 255, 0.35);
      border-top-color: #fff; border-radius: 50%; animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  `;
  // A constructed stylesheet isn't subject to the page's CSP, unlike a <style> element.
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    shadow.adoptedStyleSheets = [sheet];
  } catch {}
  if (!shadow.adoptedStyleSheets?.length) {
    const style = document.createElement('style');
    style.textContent = css;
    shadow.append(style);
  }
  const layer = document.createElement('div');
  layer.className = touchOnly ? 'layer touch' : 'layer';
  const toastEl = document.createElement('div');
  toastEl.className = 'toast';
  toastEl.setAttribute('role', 'status');
  layer.append(toastEl);
  shadow.append(layer);
  document.documentElement.append(host);

  const badges = new Map(); // media element -> { el, button, save, pause, state, layout }
  const onScreen = new Set(); // touch mode: media currently in the viewport
  let hovered = null;
  // Buttons outside the media (social feeds) mean the pointer briefly leaves it on the way there, so
  // the media it just left keeps them for a moment, and gets them back if the pointer arrives.
  const LINGER_MS = 800;
  let leftMedia = null;
  let leftAt = 0;
  const lingering = (media) => media === leftMedia && performance.now() - leftAt < LINGER_MS;

  // ---- Which media get a button --------------------------------------------------------

  const isMedia = (el) => el instanceof HTMLImageElement || el instanceof HTMLVideoElement;

  function bigEnough(el) {
    const rect = el.getBoundingClientRect();
    return rect.width >= MIN_SIZE && rect.height >= MIN_SIZE;
  }

  // A link straight to a file synthid.com can check. One wrapping an image or video is left to
  // that media's own button.
  function isCheckableLink(el) {
    return (
      el instanceof HTMLAnchorElement &&
      /^https?:$/.test(el.protocol) &&
      CHECKABLE.test(el.pathname) &&
      !el.querySelector('img, video, picture, canvas')
    );
  }

  // Images and videos big enough to be content (not SVG, which synthid.com can't check), audio
  // players, and links to checkable files.
  function wantsButton(el) {
    if (isMedia(el)) return bigEnough(el) && !/^data:image\/svg|\.svg([?#]|$)/i.test(mediaSource(el));
    if (!(el instanceof HTMLAudioElement) && !isCheckableLink(el)) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function shouldShow(media, badge) {
    if (!media.isConnected) return false;
    if (badge.state.status !== 'idle' || (badge.save && badge.save.dataset.state !== 'idle')) return true;
    return media === hovered || lingering(media) || (touchOnly && onScreen.has(media));
  }

  if (touchOnly) {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) onScreen.add(entry.target);
        else onScreen.delete(entry.target);
      }
      scheduleUpdate();
    });
    const observe = (el) => (isMedia(el) || el instanceof HTMLAudioElement || isCheckableLink(el)) && observer.observe(el);
    const observeAll = (root) => {
      observe(root);
      root.querySelectorAll?.('img, video, audio, a[href]').forEach(observe);
    };
    observeAll(document);
    new MutationObserver((records) => {
      for (const record of records) record.addedNodes.forEach((node) => node.nodeType === 1 && observeAll(node));
    }).observe(document.documentElement, { childList: true, subtree: true });
  } else {
    let pointer = null;
    let pending = false;
    document.addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerType !== 'mouse') return;
        pointer = [e.clientX, e.clientY];
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
          pending = false;
          updateHovered(...pointer);
        });
      },
      { capture: true, passive: true },
    );
    document.documentElement.addEventListener('mouseleave', () => setHovered(null));
  }

  // elementsFromPoint also finds media covered by transparent overlays, which many sites use.
  function updateHovered(x, y) {
    const stack = document.elementsFromPoint(x, y);
    if (stack[0] === host) {
      // The pointer is on one of our buttons: keep the current target, or win back the last one.
      if (!hovered && lingering(leftMedia)) setHovered(leftMedia);
      return;
    }
    if (hovered && betweenMediaAndButtons(hovered, x, y)) return;
    const media = stack.find((el) => isMedia(el) && wantsButton(el) && uncovered(stack, el));
    const other = stack[0]?.closest?.('audio, a[href]');
    setHovered(media ?? (other && wantsButton(other) ? other : null));
  }

  // Whether anything in `stack` (the elements at one point, topmost first) hides the media: part of a
  // layer fixed over the page that the media isn't in, like the larger player a feed opens, and
  // spanning all of the media's visible part. Sites' own controls and captions over media aren't.
  function uncovered(stack, media) {
    let visible = null;
    for (const el of stack) {
      if (el === media) return true;
      if (el === host || el.contains(media)) continue;
      visible ??= visiblePart(media.getBoundingClientRect());
      const r = el.getBoundingClientRect();
      const spans = r.left <= visible.left + 1 && r.top <= visible.top + 1 && r.right >= visible.right - 1 && r.bottom >= visible.bottom - 1;
      if (spans && inOtherFixedLayer(el, media)) return false;
    }
    return true;
  }

  function inOtherFixedLayer(el, media) {
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      if (getComputedStyle(node).position === 'fixed') return !node.contains(media);
    }
    return false;
  }

  const visiblePart = (rect) => ({
    left: Math.max(rect.left, 0),
    top: Math.max(rect.top, 0),
    right: Math.min(rect.right, innerWidth),
    bottom: Math.min(rect.bottom, innerHeight),
  });

  // Buttons beside the media (feeds, links) leave a gap that may have other media under it, such as
  // a neighbouring story. Outside the media but within the box around it and its buttons, the
  // pointer still counts as on it.
  function betweenMediaAndButtons(media, x, y) {
    const item = badges.get(media)?.el;
    if (!item?.classList.contains('visible')) return false;
    const m = media.getBoundingClientRect();
    if (x >= m.left && x <= m.right && y >= m.top && y <= m.bottom) return false;
    const b = item.getBoundingClientRect();
    return (
      x >= Math.min(m.left, b.left) && x <= Math.max(m.right, b.right) &&
      y >= Math.min(m.top, b.top) && y <= Math.max(m.bottom, b.bottom)
    );
  }

  function setHovered(media) {
    if (media === hovered) return;
    leftMedia = media ? null : hovered;
    leftAt = performance.now();
    if (leftMedia) setTimeout(scheduleUpdate, LINGER_MS);
    hovered = media;
    scheduleUpdate();
  }

  // ---- Badge rendering and positioning --------------------------------------------------

  // Small media such as search-result thumbnails get a compact row in the corner. On social feeds
  // the buttons go in a column outside the media's left edge, clear of the post. When they don't
  // fit there (a full-width video on a phone, or an opened result in a narrow margin) they go
  // inside, clear of anything the site draws over the media. Elsewhere, a row near the top right.
  // Links and audio players get a small button just after them.
  const PLACEMENT = {
    row: { edge: 'right', top: 70, inset: 8 },
    outside: { edge: 'outside', top: 0, inset: 8 },
    column: { edge: 'left', top: feed?.insideTop ?? 64, inset: 10 },
    compact: { edge: 'right', top: 6, inset: 6 },
    inline: { inset: 4 },
  };

  // `width` is the buttons' current width, which is the same in either column layout.
  function layoutFor(target, rect, width) {
    if (!isMedia(target)) return 'inline';
    if (rect.width < 320 || rect.height < 220) return 'compact';
    if (!feed) return 'row';
    return rect.left - width >= 2 * PLACEMENT.outside.inset ? 'outside' : 'column';
  }

  function setLayout(badge, layout) {
    if (badge.layout === layout) return;
    badge.layout = layout;
    badge.el.dataset.layout = layout;
    render(badge);
  }

  function badgeFor(media) {
    let badge = badges.get(media);
    if (badge) return badge;
    const el = document.createElement('div');
    el.className = 'item';
    badge = { el, button: makeButton('badge', () => onBadgeClick(media, badge)), save: null, pause: null, state: { status: 'idle' }, layout: null };
    // Instagram's feed has no pause control (a video sits inside a link to its post), and both
    // feeds restart videos as you scroll. This one keeps them paused.
    if (feed && media instanceof HTMLVideoElement) {
      badge.pause = makeButton('icon pause', () => onPauseClick(media));
      renderPause(badge.pause, media);
      el.append(badge.pause);
    }
    // Videos also get a download button, to keep the file or upload it to synthid.com yourself.
    if (media instanceof HTMLVideoElement) {
      badge.save = makeButton('icon save', (e) => onSaveClick(media, badge.save, e.shiftKey));
      badge.save.dataset.state = 'idle';
      badge.save.setAttribute('aria-label', 'Download video');
      badge.save.title = globalThis.SynthIDMeta ? 'Download video (Shift+click: every video in the post)' : 'Download video';
      badge.save.append(svgIcon(DOWNLOAD_ICON));
      el.append(badge.save);
    }
    el.append(badge.button);
    badges.set(media, badge);
    layer.append(el);
    setLayout(badge, layoutFor(media, media.getBoundingClientRect(), 0)); // measured once it's shown
    return badge;
  }

  function makeButton(className, onClick) {
    const button = document.createElement('button');
    button.className = className;
    button.type = 'button';
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'touchstart', 'touchend']) {
      button.addEventListener(type, (e) => e.stopPropagation());
    }
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick(e);
    });
    return button;
  }

  function svgIcon(pathData) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', pathData);
    path.setAttribute('fill', 'currentColor');
    svg.append(path);
    return svg;
  }

  function setState(media, state) {
    const badge = badgeFor(media);
    badge.state = state;
    // Problems show their explanation straight away (touch screens have no tooltips).
    badge.button.classList.toggle('expanded', RETRYABLE.has(state.status));
    render(badge);
    scheduleUpdate();
  }

  function render({ button: el, state, layout }) {
    // Thumbnails and the feeds' column only have room for a short label. The full one is in the
    // tooltip, and shows when a result is opened.
    const short = layout !== 'row' && !el.classList.contains('expanded');
    el.classList.toggle('short', short);
    el.dataset.status = state.status;
    el.replaceChildren();
    if (state.status === 'checking') {
      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      el.append(spinner);
    }
    const shown = short ? shortLabel(state) : label(state);
    const detail = describe(state);
    if (shown) {
      const text = document.createElement('span');
      text.className = 'text';
      text.textContent = shown;
      if (detail && el.classList.contains('expanded')) {
        const line = document.createElement('span');
        line.className = 'detail';
        line.textContent = detail;
        text.append(line);
      }
      el.append(text);
    }
    el.title = detail || label(state);
    el.setAttribute('aria-label', detail ? `${label(state)}. ${detail}` : label(state));
  }

  function label(state) {
    switch (state.status) {
      case 'idle':
        return 'Check SynthID';
      case 'checking':
        return state.text || 'Checking…';
      case 'detected':
        return 'SynthID detected';
      case 'not_detected':
        return 'No SynthID found';
      case 'uncertain':
        return 'SynthID: unsure';
      case 'inconclusive':
        return 'SynthID: can’t tell';
      case 'signin':
        return 'Sign in to synthid.com';
      case 'terms':
        return 'Accept synthid.com terms';
      default:
        return 'Check failed';
    }
  }

  function shortLabel(state) {
    switch (state.status) {
      case 'idle':
        return 'SynthID';
      case 'checking':
        return ''; // just the spinner; the step is in the tooltip
      case 'detected':
        return 'Watermark found';
      case 'not_detected':
        return 'No watermark';
      case 'uncertain':
        return 'Watermark unsure';
      case 'inconclusive':
        return 'Can’t tell';
      default:
        return label(state); // problems are always shown in full
    }
  }

  function describe(state) {
    switch (state.status) {
      case 'idle':
        return 'Check this for a SynthID watermark using synthid.com';
      case 'detected':
        return [
          `Made with ${state.partner || 'Google AI'}: synthid.com found a SynthID watermark in all or part of it.`,
          state.confidence && `Confidence: ${state.confidence}.`,
        ]
          .filter(Boolean)
          .join(' ');
      case 'not_detected':
        return 'No SynthID watermark found. This doesn’t prove it isn’t AI-generated: only Google and SynthID partner models add the watermark.';
      case 'error':
      case 'signin':
      case 'terms':
        return `${state.message || ''} ${touchOnly ? 'Tap' : 'Click'} to retry.`.trim();
      default:
        return state.message || '';
    }
  }

  function onBadgeClick(media, badge) {
    const { status } = badge.state;
    if (status === 'checking') return;
    if (status === 'idle' || RETRYABLE.has(status)) {
      check(media);
      return;
    }
    badge.button.classList.toggle('expanded');
    render(badge);
    scheduleUpdate();
  }

  let frame = 0;
  function scheduleUpdate() {
    if (!frame) frame = requestAnimationFrame(update);
  }

  function update() {
    frame = 0;
    if (hovered && !hovered.isConnected) hovered = null;
    if (hovered) badgeFor(hovered);
    if (touchOnly) onScreen.forEach((media) => wantsButton(media) && badgeFor(media));

    for (const [media, badge] of badges) {
      // Idle buttons are recreated on demand; results stay until the media leaves the page.
      if (!shouldShow(media, badge)) {
        badge.el.remove();
        badges.delete(media);
        if (!media.isConnected) onScreen.delete(media);
        continue;
      }
      const rect = media.getBoundingClientRect();
      const offscreen = rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth;
      if (offscreen || rect.width === 0 || hidden(media, rect)) {
        badge.el.classList.remove('visible');
        continue;
      }
      badge.el.classList.add('visible');
      setLayout(badge, layoutFor(media, rect, badge.el.offsetWidth));
      const { edge, top, inset } = PLACEMENT[badge.layout];
      const width = badge.el.offsetWidth;
      const height = badge.el.offsetHeight;
      let x;
      let y;
      if (badge.layout === 'inline') {
        // Just after the link's last line (or the audio player), centred on it.
        const line = [...media.getClientRects()].pop() ?? rect;
        x = Math.max(inset, Math.min(line.right + inset, innerWidth - width - inset));
        y = Math.max(inset, Math.min(line.top + (line.height - height) / 2, innerHeight - height - inset));
      } else {
        const along = { right: rect.right - width - inset, left: rect.left + inset, outside: rect.left - width - inset }[edge];
        // Kept on screen, and level with the media while it's partly scrolled away.
        x = Math.max(inset, Math.min(along, innerWidth - width - inset));
        y = Math.min(Math.max(rect.top + top, inset), Math.max(rect.bottom - height - inset, inset));
      }
      badge.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    }
  }

  // Covered at the middle of its visible part, e.g. by the site's own player opened over the feed.
  function hidden(media, rect) {
    const area = visiblePart(media instanceof HTMLAnchorElement ? ([...media.getClientRects()].pop() ?? rect) : rect);
    return !uncovered(document.elementsFromPoint((area.left + area.right) / 2, (area.top + area.bottom) / 2), media);
  }

  addEventListener('scroll', scheduleUpdate, { capture: true, passive: true });
  addEventListener('resize', scheduleUpdate, { passive: true });
  // Catches layout shifts, carousels and media removed by the page.
  setInterval(() => badges.size && scheduleUpdate(), 500);

  // ---- Running a check ------------------------------------------------------------------

  function mediaSource(media) {
    if (media instanceof HTMLAnchorElement) return media.href;
    if (media instanceof HTMLImageElement) return media.currentSrc || media.src;
    return media.currentSrc || media.src || media.querySelector('source[src]')?.src || '';
  }

  // Instagram and Threads (meta.js): the files of the post a video belongs to, or null elsewhere.
  async function siteFiles(media, all = false) {
    if (!globalThis.SynthIDMeta || !(media instanceof HTMLVideoElement)) return null;
    return globalThis.SynthIDMeta.resolve(media, all);
  }

  async function check(media) {
    let src = mediaSource(media);
    const isVideo = media instanceof HTMLVideoElement;
    if (!src && !isVideo) {
      setState(media, { status: 'error', message: 'This element has no file to check.' });
      return;
    }
    setState(media, { status: 'checking', text: 'Starting…' });
    // The post's own file has sound and doesn't need the video to have played, unlike a stream.
    const site = await siteFiles(media).catch(() => null);
    if (site?.files.length === 1) src = site.files[0].url;

    let port;
    try {
      port = api.runtime.connect({ name: 'check' });
    } catch {
      setState(media, { status: 'error', message: 'The extension was updated. Reload this page and try again.' });
      return;
    }
    let finished = false;
    // Messages keep the background worker from being suspended during a long check.
    const heartbeat = setInterval(() => port.postMessage({ t: 'ping' }), 15000);
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      port.disconnect();
      setState(media, result);
    };
    const fail = (err) => finish({ status: 'error', message: err.message });
    const upload = () =>
      readInPage(media, src)
        .then((blob) => {
          setState(media, { status: 'checking', text: 'Sending…' });
          return sendBlob(port, blob);
        })
        .catch(fail);

    port.onMessage.addListener((msg) => {
      if (finished) return;
      if (msg.t === 'status') setState(media, { status: 'checking', text: msg.text });
      else if (msg.t === 'result') finish(msg.result);
      else if (msg.t === 'need-bytes') upload();
    });
    port.onDisconnect.addListener(() => {
      if (!finished) fail(new Error('Lost connection to the extension. Try again.'));
    });

    // The background can download http(s) URLs from any site.
    if (/^https?:/i.test(src)) {
      port.postMessage({ t: 'check', src });
      return;
    }
    // blob: and data: URLs only exist in this page, so those are read here and sent over. A
    // streamed video (blob: MediaSource, or no URL at all) can't be read; the background looks
    // for the file the stream is built from instead.
    (src ? readInPage(media, src) : Promise.reject(new Error('No file URL.')))
      .then((blob) => {
        port.postMessage({ t: 'check', inline: true });
        setState(media, { status: 'checking', text: 'Sending…' });
        return sendBlob(port, blob);
      })
      .catch((err) => {
        if (!isVideo) throw err;
        port.postMessage({ t: 'check', streamed: true, duration: media.duration });
      })
      .catch(fail);
  }

  async function readInPage(media, src) {
    try {
      const res = await fetch(src);
      if (res.ok) return await res.blob();
    } catch {}
    if (media instanceof HTMLImageElement && media.complete && media.naturalWidth) {
      // Last resort: copy the decoded pixels losslessly into a PNG. Fails for cross-origin
      // images the page didn't load with CORS.
      const canvas = document.createElement('canvas');
      canvas.width = media.naturalWidth;
      canvas.height = media.naturalHeight;
      canvas.getContext('2d').drawImage(media, 0, 0);
      try {
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        if (blob) return blob;
      } catch {}
    }
    throw new Error('Couldn’t download this file.');
  }

  // ---- Pausing feed videos --------------------------------------------------------------

  // Instagram and Facebook restart feed videos whenever they decide they're in view, so a video
  // paused here stays paused until it's started by a tap or key press: on our button or the site's.
  const held = new WeakSet();
  let lastGesture = -Infinity;

  if (feed) {
    // pointerup, not pointerdown: a touch that turns into a scroll ends in pointercancel instead.
    for (const type of ['pointerup', 'keydown']) {
      addEventListener(
        type,
        (e) => {
          if (e.isTrusted && e.target !== host) lastGesture = performance.now();
        },
        true,
      );
    }
    // Media events don't bubble, but a capturing listener on the document still sees them.
    const onPlayback = (e) => {
      const video = e.target;
      if (!(video instanceof HTMLVideoElement)) return;
      if (e.type === 'play' && held.has(video)) {
        if (performance.now() - lastGesture < 1000) held.delete(video);
        else video.pause();
      }
      const button = badges.get(video)?.pause;
      if (button) renderPause(button, video);
    };
    document.addEventListener('play', onPlayback, true);
    document.addEventListener('pause', onPlayback, true);
  }

  function onPauseClick(video) {
    if (video.paused) {
      held.delete(video);
      video.play().catch(() => {});
    } else {
      held.add(video);
      video.pause();
    }
  }

  function renderPause(button, video) {
    const label = video.paused ? 'Play video' : 'Pause video';
    button.replaceChildren(svgIcon(video.paused ? PLAY_ICON : PAUSE_ICON));
    button.setAttribute('aria-label', label);
    button.title = label;
  }

  // ---- Downloading a video --------------------------------------------------------------

  function onSaveClick(media, save, all) {
    if (save.dataset.state === 'busy') return;
    setSaveState(save, 'busy');
    download(media, all).then(
      (message) => {
        setSaveState(save, 'done');
        toast(message);
      },
      (err) => {
        setSaveState(save, 'failed');
        toast(err.message);
      },
    );
  }

  function setSaveState(save, state) {
    save.dataset.state = state;
    save.setAttribute('aria-busy', String(state === 'busy'));
    if (state === 'done' || state === 'failed') {
      setTimeout(() => save.dataset.state === state && setSaveState(save, 'idle'), 2000);
    }
    scheduleUpdate();
  }

  // Tries the same sources as a check, in the same order. Resolves with a message for the toast.
  async function download(media, all) {
    const site = await siteFiles(media, all).catch(() => null);
    if (site) return saveFiles(site);

    const src = mediaSource(media);
    if (/^https?:/i.test(src)) {
      try {
        return `Saved ${await save({ src })}`;
      } catch (err) {
        // Some servers only send the file to the page itself.
        return saveFromPage(media, src).catch(() => Promise.reject(err));
      }
    }
    if (src) {
      try {
        return await saveFromPage(media, src);
      } catch {}
    }
    // A streamed video: the background finds the file it's built from, which has no sound.
    const name = await save({ streamed: true, duration: media.duration, name: fileName([siteName(), timestamp()], 'mp4') });
    return `Saved ${name} without sound: the site keeps the sound in a separate file.`;
  }

  async function saveFiles({ files, note }) {
    const unique = [...new Map(files.map((file) => [file.url, file])).values()];
    const names = [];
    let error = null;
    for (const file of unique) {
      try {
        names.push(await save({ src: file.url, name: file.name }));
      } catch (err) {
        error = err;
      }
    }
    if (!names.length) throw error;
    if (error) return `Saved ${names.length} of ${unique.length} videos. ${error.message}`;
    return note ?? (names.length === 1 ? `Saved ${names[0]}` : `Saved ${names.length} videos`);
  }

  async function saveFromPage(media, src) {
    const blob = await readInPage(media, src);
    const type = sniffMediaType(new Uint8Array(await blob.slice(0, 64).arrayBuffer()));
    const name = fileName([siteName(), timestamp()], type?.ext ?? 'mp4');
    saveBlob(blob, name);
    return `Saved ${name}`;
  }

  // Asks the background to download a file: {src, name?} or {streamed, duration, name}. Resolves
  // with the saved file's name.
  function save(request) {
    return new Promise((resolve, reject) => {
      let port;
      try {
        port = api.runtime.connect({ name: 'download' });
      } catch {
        reject(new Error('The extension was updated. Reload this page and try again.'));
        return;
      }
      let finished = false;
      // Messages keep the background worker from being suspended during a long download.
      const heartbeat = setInterval(() => port.postMessage({ t: 'ping' }), 15000);
      const finish = (err, name) => {
        if (finished) return;
        finished = true;
        clearInterval(heartbeat);
        port.disconnect();
        if (err) reject(err);
        else resolve(name);
      };
      // Without a downloads API (Firefox for Android) the background sends the file here to save.
      const receive = createBlobReceiver((blob, meta) => {
        saveBlob(blob, meta.name);
        finish(null, meta.name);
      });
      port.onMessage.addListener((msg) => {
        if (receive(msg)) return;
        if (msg.t === 'saved') finish(null, msg.name);
        else if (msg.t === 'failed') finish(new Error(msg.message));
      });
      port.onDisconnect.addListener(() => finish(new Error('Lost connection to the extension. Try again.')));
      port.postMessage({ t: 'download', ...request });
    });
  }

  function saveBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.addEventListener('click', (e) => e.stopPropagation()); // keep the page's click handlers out of it
    layer.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  // "facebook" for www.facebook.com, for file names.
  const siteName = () => location.hostname.replace(/^(www|m)\./, '').split('.')[0];

  let toastTimer = 0;
  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 5000);
  }
})();
