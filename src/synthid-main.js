// Runs inside synthid.com's own JavaScript context (world: MAIN).
//
// The site reports every detection outcome as a gtag "detection_result" event
// ({media_type, result, partner_name}), so reading window.dataLayer gives a structured
// result without scraping the page. Also reports the Firebase sign-in state. Both are
// relayed to synthid-bridge.js with postMessage.
(() => {
  const TAG = 'synthid-checker';
  const EVENTS = new Set(['file_upload', 'detection_result', 'submit_media_image', 'submit_media_video']);
  const post = (data) => window.postMessage({ [TAG]: true, ...data }, location.origin);

  // dataLayer keeps every entry, so poll it for new ones rather than patching push(), which
  // gtag.js wraps itself.
  let layer = null;
  let seen = 0;
  setInterval(() => {
    if (window.dataLayer !== layer) {
      layer = window.dataLayer;
      seen = 0;
    }
    if (!Array.isArray(layer)) return;
    for (; seen < layer.length; seen++) {
      // gtag() pushes its `arguments` object: ['event', name, params].
      const entry = layer[seen];
      if (entry?.[0] === 'event' && EVENTS.has(entry[1])) {
        try {
          post({ type: 'gtag', name: entry[1], params: JSON.parse(JSON.stringify(entry[2] ?? {})) });
        } catch {}
      }
    }
  }, 200);

  // Sign-in is Firebase Auth, restored asynchronously from IndexedDB after page load.
  const authPoll = setInterval(() => {
    const apps = window.firebase?.apps;
    if (!apps?.length) return;
    clearInterval(authPoll);
    for (const app of apps) {
      try {
        app.auth().onAuthStateChanged((user) => post({ type: 'auth', signedIn: !!user }));
      } catch {}
    }
  }, 100);
  setTimeout(() => clearInterval(authPoll), 20000);
})();
