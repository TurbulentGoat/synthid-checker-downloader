// Content script on synthid.com (isolated world). When the background sends a file, it puts
// it into the site's own upload input, exactly as if the user had picked it, then waits for
// the outcome reported by synthid-main.js.
(() => {
  const { api, createBlobReceiver } = globalThis.SynthIDShared;
  const TAG = 'synthid-checker';
  const RESULT_TIMEOUT_MS = 4 * 60 * 1000;

  const PARTNERS = { google: 'Google AI', kakao: 'Kakao', nvidia: 'NVIDIA', openai: 'OpenAI' };
  const OUTCOMES = {
    detected: { status: 'detected' },
    not_detected: { status: 'not_detected' },
    abstention: { status: 'uncertain', message: 'Not enough information to detect SynthID.' },
    possible_tampering: {
      status: 'uncertain',
      message: 'It may have been edited, or Google AI was only used for a small part of it.',
    },
    empty: { status: 'inconclusive', message: 'The media was empty.' },
    low_resolution: { status: 'inconclusive', message: 'The resolution is too low to check.' },
    not_enough_detail: { status: 'inconclusive', message: 'There is not enough detail to check.' },
    low_fps: { status: 'inconclusive', message: 'The video has less than 10 frames per second.' },
    low_quality: { status: 'inconclusive', message: 'The quality is too low to check.' },
    video_too_long: { status: 'inconclusive', message: 'The video is too long for synthid.com.' },
    audio_too_long: { status: 'inconclusive', message: 'The audio is too long for synthid.com.' },
    image_quota_error: { status: 'error', message: 'synthid.com’s image limit was reached. Try again later.' },
    video_quota_error: { status: 'error', message: 'synthid.com’s video limit was reached. Try again later.' },
    audio_quota_error: { status: 'error', message: 'synthid.com’s audio limit was reached. Try again later.' },
    error: { status: 'error', message: 'synthid.com reported an error.' },
  };
  const SIGN_IN = {
    status: 'signin',
    message: 'synthid.com needs you to sign in. Sign in in the tab that just opened, then try again.',
  };
  const TERMS = {
    status: 'terms',
    message: 'synthid.com wants you to accept its terms first. Read them in the tab that just opened, then try again.',
  };

  let signedIn = null; // unknown until Firebase reports
  const events = [];

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data?.[TAG]) return;
    if (e.data.type === 'auth') signedIn = e.data.signedIn;
    if (e.data.type === 'gtag') events.push(e.data);
  });

  Promise.resolve(api.runtime.sendMessage({ t: 'bridge-ready' })).catch(() => {});

  api.runtime.onConnect.addListener((port) => {
    if (port.name !== 'job') return;
    const receive = createBlobReceiver(async (blob, meta) => {
      // Messages keep the background worker from being suspended during a long check.
      const heartbeat = setInterval(() => port.postMessage({ t: 'heartbeat' }), 10000);
      const status = (text) => port.postMessage({ t: 'status', text });
      let result;
      try {
        result = await detect(new File([blob], meta.name, { type: blob.type }), meta.kind, status);
      } catch (err) {
        result = { status: 'error', message: err.message };
      }
      clearInterval(heartbeat);
      port.postMessage({ t: 'result', result });
    });
    port.onMessage.addListener(receive);
  });

  async function detect(file, kind, status) {
    status('Waiting for synthid.com…');
    await waitFor(() => signedIn !== null, 15000).catch(() => {});
    if (signedIn === false) return SIGN_IN;
    // Give the app's own auth listener a moment to see the restored session.
    await sleep(300);

    const input = await findFileInput(kind);
    if (!input) throw new Error('Couldn’t find the upload box on synthid.com. The site may have changed.');
    // The terms dialog opens on load until accepted. Never accept it on the user's behalf.
    await sleep(1000);
    if (termsPrompt()) return TERMS;

    const firstEvent = events.length;
    const newEvent = (...names) => events.slice(firstEvent).find((e) => names.includes(e.name));
    const onDetectionPage = () => /-detection$/.test(location.pathname);

    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    status('Uploading to synthid.com…');

    // The site either routes to its detection page, or shows a sign-in dialog or error snackbar.
    const accepted = await waitFor(
      () => newEvent('file_upload') || onDetectionPage() || signInPrompt() || snackbarText(),
      15000,
    ).catch(() => null);
    if (!newEvent('file_upload') && !onDetectionPage()) {
      if (signInPrompt()) return SIGN_IN;
      throw new Error(snackbarText() || (accepted ? 'synthid.com rejected the file.' : 'synthid.com didn’t respond.'));
    }

    status('Checking for SynthID…');
    const outcome = await waitFor(
      () => newEvent('detection_result') || newEvent('submit_media_image', 'submit_media_video') || resultFromPage(),
      RESULT_TIMEOUT_MS,
    );
    await sleep(500); // let the page render its confidence text, which describe() reads
    return describe(outcome);
  }

  function describe(outcome) {
    let key = outcome.params?.result ?? outcome.result;
    // submit_media_* events use slightly different names than detection_result.
    if (key === 'uncertain') key = 'abstention';
    const result = { ...(OUTCOMES[key] ?? OUTCOMES.error) };
    if (result.status === 'detected') {
      const partner = outcome.params?.partner_name ?? outcome.partner ?? '';
      result.partner = PARTNERS[partner.toLowerCase()] ?? (partner || 'a SynthID partner');
      result.confidence = document.body.innerText.match(/SynthID confidence: (Very High|High|Mid)/)?.[1];
    }
    return result;
  }

  // Backup in case the analytics hook misses the event: read the result title off the page.
  function resultFromPage() {
    for (const node of document.querySelectorAll('.title')) {
      const text = node.textContent.trim();
      if (/^Not made with/i.test(text)) return { result: 'not_detected' };
      if (/^Unsure if made with/i.test(text)) return { result: 'abstention' };
      const made = text.match(/^Made with (.+?)(?:\s*\(.*\))?$/i);
      if (made) return { result: 'detected', partner: made[1] };
    }
    return null;
  }

  async function findFileInput(kind) {
    const query = () => document.querySelector('input[type=file]');
    const input = await waitFor(query, 15000).catch(() => null);
    if (input) return input;
    // The site's older layout makes you pick a media type first, which leads to the upload box.
    const link = document.querySelector(`a[href*="${kind}-detection"]`);
    if (!link) return null;
    link.click();
    return waitFor(query, 10000).catch(() => null);
  }

  function dialogText() {
    const dialogs = document.querySelectorAll('mat-dialog-container, .mat-mdc-dialog-container, [role=dialog]');
    return [...dialogs].map((d) => d.textContent).join('\n');
  }

  function signInPrompt() {
    return /please sign in/i.test(dialogText());
  }

  function termsPrompt() {
    return /Agree and continue/i.test(dialogText());
  }

  function snackbarText() {
    const bar = document.querySelector('.mat-mdc-snack-bar-label, mat-snack-bar-container, sid-unsupported-file-type-snackbar');
    return bar?.textContent.trim().replace(/\s*Dismiss$/, '') || '';
  }

  function waitFor(check, timeoutMs) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        const value = check();
        if (value) resolve(value);
        else if (Date.now() - started > timeoutMs) reject(new Error('Timed out waiting for synthid.com.'));
        else setTimeout(tick, 250);
      };
      tick();
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
