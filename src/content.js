// Page content script: shows a "SynthID?" button on images and videos, and a result badge
// after a check. Videos also get a download button. With a mouse the buttons follow the hovered
// media; on touch screens every visible image and video gets them.
(() => {
  if (window.__synthidChecker) return;
  window.__synthidChecker = true;

  const { api, sendBlob, createBlobReceiver, sniffMediaType, fileName, timestamp } = globalThis.SynthIDShared;
  const MIN_SIZE = 80; // CSS px; skips icons, avatars and tracking pixels
  const touchOnly = matchMedia('(hover: none)').matches;
  const RETRYABLE = new Set(['error', 'signin', 'terms']);
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const DOWNLOAD_ICON =
    'M12 2C12.5523 2 13 2.44772 13 3V13.5858L16.2929 10.2929C16.6834 9.90237 17.3166 9.90237 17.7071 10.2929C18.0976 10.6834 18.0976 11.3166 17.7071 11.7071L12.7071 16.7071C12.3166 17.0976 11.6834 17.0976 11.2929 16.7071L6.29289 11.7071C5.90237 11.3166 5.90237 10.6834 6.29289 10.2929C6.68342 9.90237 7.31658 9.90237 7.70711 10.2929L11 13.5858V3C11 2.44772 11.4477 2 12 2ZM4 17C4.55228 17 5 17.4477 5 18V20H19V18C19 17.4477 19.4477 17 20 17C20.5523 17 21 17.4477 21 18V20C21 21.1046 20.1046 22 19 22H5C3.89543 22 3 21.1046 3 20V18C3 17.4477 3.44772 17 4 17Z';

  const host = document.createElement('synthid-checker');
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const css = `
    .item { position: fixed; top: 0; left: 0; display: none; align-items: flex-start; gap: 6px; }
    .item.visible { display: flex; }
    .badge, .save {
      box-sizing: border-box; border: 0; border-radius: 5px; color: #fff;
      background: rgba(32, 33, 36, 0.85); box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
      cursor: pointer; pointer-events: auto; -webkit-tap-highlight-color: transparent;
    }
    .badge {
      display: inline-flex; align-items: center; gap: 6px; max-width: 240px; padding: 10px 10px;
      font: 600 12px/16px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; text-align: left;
    }
    .badge:hover, .save:hover { filter: brightness(1.15); }
    .badge:focus-visible, .save:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 2px; }
    .touch .badge { padding: 7px 12px; font-size: 13px; }
    .save { flex: none; display: grid; place-items: center; width: 36px; height: 36px; padding: 0; }
    .touch .save { width: 30px; height: 30px; }
    .save svg { width: 18px; height: 18px; }
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
      border-top-color: #fff; border-radius: 5px; animation: spin 0.8s linear infinite;
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

  const badges = new Map(); // media element -> { el, button, save, state }
  const onScreen = new Set(); // touch mode: media currently in the viewport
  let hovered = null;

  // ---- Which media get a button --------------------------------------------------------

  const isMedia = (el) => el instanceof HTMLImageElement || el instanceof HTMLVideoElement;

  function bigEnough(el) {
    const rect = el.getBoundingClientRect();
    return rect.width >= MIN_SIZE && rect.height >= MIN_SIZE;
  }

  function shouldShow(media, badge) {
    if (!media.isConnected) return false;
    if (badge.state.status !== 'idle' || (badge.save && badge.save.dataset.state !== 'idle')) return true;
    return media === hovered || (touchOnly && onScreen.has(media));
  }

  if (touchOnly) {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) onScreen.add(entry.target);
        else onScreen.delete(entry.target);
      }
      scheduleUpdate();
    });
    const observeAll = (root) => {
      if (isMedia(root)) observer.observe(root);
      root.querySelectorAll?.('img, video').forEach((el) => observer.observe(el));
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
    if (stack[0] === host) return; // pointer is on one of our badges; keep the current target
    setHovered(stack.find((el) => isMedia(el) && bigEnough(el)) ?? null);
  }

  function setHovered(media) {
    if (media === hovered) return;
    hovered = media;
    scheduleUpdate();
  }

  // ---- Badge rendering and positioning --------------------------------------------------

  function badgeFor(media) {
    let badge = badges.get(media);
    if (badge) return badge;
    const el = document.createElement('div');
    el.className = 'item';
    badge = { el, button: makeButton('badge', () => onBadgeClick(media, badge)), save: null, state: { status: 'idle' } };
    // Videos also get a download button, to keep the file or upload it to synthid.com yourself.
    if (media instanceof HTMLVideoElement) {
      badge.save = makeButton('save', (e) => onSaveClick(media, badge.save, e.shiftKey));
      badge.save.dataset.state = 'idle';
      badge.save.setAttribute('aria-label', 'Download video');
      badge.save.title = globalThis.SynthIDMeta ? 'Download video (Shift+click: every video in the post)' : 'Download video';
      badge.save.append(downloadIcon());
      el.append(badge.save);
    }
    el.append(badge.button);
    badges.set(media, badge);
    layer.append(el);
    render(badge);
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

  function downloadIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', DOWNLOAD_ICON);
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

  function render({ button: el, state }) {
    el.dataset.status = state.status;
    el.replaceChildren();
    if (state.status === 'checking') {
      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      el.append(spinner);
    }
    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = label(state);
    const detail = describe(state);
    if (detail && el.classList.contains('expanded')) {
      const line = document.createElement('span');
      line.className = 'detail';
      line.textContent = detail;
      text.append(line);
    }
    el.append(text);
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
    if (touchOnly) onScreen.forEach((media) => bigEnough(media) && badgeFor(media));

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
      if (offscreen || rect.width === 0) {
        badge.el.classList.remove('visible');
        continue;
      }
      badge.el.classList.add('visible');
      const inset = 8;
      const topOffset = 70;
      const width = badge.el.offsetWidth;
      const height = badge.el.offsetHeight;
      // Near the top-right corner of the media, kept on screen while the media is partly scrolled away.
      const x = Math.max(inset, Math.min(rect.right - width - inset, innerWidth - width - inset));
      const y = Math.min(Math.max(rect.top + topOffset, inset), Math.max(rect.bottom - height - inset, inset));
      badge.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    }
  }

  addEventListener('scroll', scheduleUpdate, { capture: true, passive: true });
  addEventListener('resize', scheduleUpdate, { passive: true });
  // Catches layout shifts, carousels and media removed by the page.
  setInterval(() => badges.size && scheduleUpdate(), 500);

  // ---- Running a check ------------------------------------------------------------------

  function mediaSource(media) {
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
