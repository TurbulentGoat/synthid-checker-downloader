# SynthID Checker

A browser extension that puts a **SynthID?** button on images and videos. Click it and the
extension checks that file for a SynthID watermark on [synthid.com](https://synthid.com) in the
background, then shows the result on the image:

| Badge | Meaning |
| --- | --- |
| **SynthID detected** (red) | synthid.com found a watermark. Click for the source (e.g. Google AI) and confidence. |
| **No SynthID found** (green) | No watermark. This does *not* mean it isn't AI-generated: only Google and SynthID partner models add one. |
| **SynthID: unsure** (amber) | synthid.com couldn't decide (for example, the image was edited). |
| **SynthID: can't tell** (grey) | Too small, too low quality, too short, and so on. |
| **Check failed** / **Sign in** / **Accept terms** (grey) | Something needs attention. Click to retry. |

Videos also get a **download** button next to it (see [Downloading videos](#downloading-videos)).

With a mouse, the buttons appear on whatever image or video you hover over. On touch screens they
appear on every visible image and video.

## Before you use it

- **The file is sent to Google.** SynthID detection only runs on Google's servers, so each check
  uploads the file to synthid.com, just as if you'd used the upload box yourself. synthid.com's
  privacy notice says the file is deleted once the result is returned, and a signature of it is
  kept for 24 hours to enforce quotas.
- **synthid.com's terms.** You agree not to "bypass the user interface to programmatically submit
  requests … or use the frontend as an automated API to run bulk media verification queries", and
  Google may suspend access for violations. This extension goes through the site's own upload box
  and makes exactly one check per click, with no bulk or automatic scanning. It never accepts the
  terms for you. Still, read the terms and decide for yourself whether this is a use you're
  comfortable with.
- You need a synthid.com account (Google, Apple or ChatGPT sign-in). There is a daily quota.

## Install

**Chrome, Edge, Brave:** open `chrome://extensions`, turn on *Developer mode*, click *Load
unpacked* and choose this folder. Warnings about `background.scripts` and
`browser_specific_settings` are expected: those keys are for Firefox, and Chrome ignores them.

**Firefox (128+):** open `about:debugging#/runtime/this-firefox`, click *Load Temporary
Add-on…* and choose `manifest.json`. A temporary add-on is removed when Firefox restarts. To
keep it installed, sign it as an unlisted add-on with
[`web-ext sign`](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/#web-ext-sign).
If no buttons appear, go to `about:addons` → SynthID Checker → Permissions and allow access to
all websites.

**Firefox for Android:** run it from your computer with
`npx web-ext run --target=firefox-android` (see the
[Android guide](https://extensionworkshop.com/documentation/develop/developing-extensions-for-firefox-for-android/)),
or install a signed copy.

## First run

The first time you click a button, the extension opens synthid.com and brings it to the front
because you need to sign in and accept the terms. Do that, then click the button again. After
that, checks open synthid.com in an inactive tab and close it when they're done.

## Downloading videos

The download button saves the video file, so you can keep it or upload it to synthid.com
yourself. It finds the file the same way a check does:

- **Instagram and Threads:** the post's own file, with sound, at the best quality the site
  offers, named after the post (`instagram_<user>_<post>.mp4`). Shift+click saves every video in
  the post, such as all of a carousel's.
- **Facebook**, and Instagram videos it can't place in a post: the streamed file (see
  [Limitations](#limitations)). It has no sound, because Facebook keeps the sound separately.
- **Elsewhere:** the `<video>`'s file, if it has one.

A message at the bottom of the page says what was saved, or why it couldn't be. Files go to
your browser's downloads folder. Firefox for Android has no downloads API, so there the
extension downloads the file itself and saves it through the page.

## Limitations

- Instagram and Threads list each post's video files in the data their pages load. The extension
  reads them from there (on Instagram, if the post isn't loaded, it asks Instagram's API like the
  site does). This gives the whole file, with sound, without playing the video first.
- Facebook streams videos in pieces, with no file URL on the `<video>`. For Facebook (and
  Instagram videos it can't link to a post), the extension watches which video files the page
  downloads from Meta's CDN and picks the one whose length matches the video you clicked. Let the
  video play for a moment first. Only the video track is checked, because Meta stores the sound
  in a separate file. Facebook often serves AV1 video, and it's unconfirmed whether synthid.com
  accepts that codec.
- Other streaming sites (YouTube, Twitch and so on) aren't supported for checks or downloads, and
  show "streamed in pieces".
- Files over 100 MB are rejected by synthid.com. Downloads have no size limit.
- Only images and videos in the top-level page get buttons, not ones inside iframes.
- It relies on how synthid.com's page works today: its file input, its `detection_result`
  analytics event and its Firebase sign-in. If the site changes, the extension may stop
  working. Errors say so instead of guessing a result.

## How it works

| File | Role |
| --- | --- |
| `src/content.js` | Draws the buttons and badges (closed shadow DOM, so pages can't restyle them) and starts a check or download. |
| `src/background.js` | Downloads the media (`<all_urls>` permission avoids CORS), works out its real type from its first bytes, queues checks and manages the synthid.com tab. Saves downloads with the `downloads` API. |
| `src/meta-main.js` | On Instagram and Threads, in the page's own context: reads the video file URLs (`video_versions`) out of the site's API responses, without changing them, and answers lookups by post. |
| `src/meta.js` | On Instagram and Threads: works out which post a `<video>` belongs to and gets its file from `meta-main.js`. |
| `src/synthid-bridge.js` | On synthid.com: puts the file into the site's own `<input type=file>` and waits for the outcome. Stops if you need to sign in or accept the terms. |
| `src/synthid-main.js` | Runs in synthid.com's page context: relays the site's `detection_result` analytics events and Firebase sign-in state to the bridge. |
| `src/streams.js` | Finds the file behind a Facebook/Instagram stream: records the CDN files the tab requests (`webRequest`), then reads the start of each to match track type and duration. |
| `src/shared.js` | Chunked file transfer between scripts, file-type sniffing and download file names. |

Results are cached per URL (in session storage) until the browser closes, so clicking the
same image twice doesn't use quota.
