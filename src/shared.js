// Helpers shared by the background worker, the page content script and the synthid.com bridge.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;

  // synthid.com rejects anything larger than this.
  const MAX_BYTES = 100 * 1024 * 1024;

  // Chrome extension messaging only carries JSON, so media is sent over a port as base64 chunks.
  const CHUNK_BYTES = 2 * 1024 * 1024;

  function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function sendBlob(port, blob, meta = {}) {
    port.postMessage({ t: 'file-start', type: blob.type, size: blob.size, ...meta });
    for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
      const bytes = new Uint8Array(await blob.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
      port.postMessage({ t: 'file-chunk', data: bytesToBase64(bytes) });
    }
    port.postMessage({ t: 'file-end' });
  }

  // Returns a handler to feed every port message into. It reassembles a blob sent with
  // sendBlob, calls onBlob(blob, meta) when complete, and returns true for messages it consumed.
  function createBlobReceiver(onBlob) {
    let meta = null;
    let parts = [];
    return (msg) => {
      if (msg?.t === 'file-start') {
        meta = msg;
        parts = [];
        return true;
      }
      if (msg?.t === 'file-chunk' && meta) {
        parts.push(base64ToBytes(msg.data));
        return true;
      }
      if (msg?.t === 'file-end' && meta) {
        const blob = new Blob(parts, { type: meta.type });
        const done = meta;
        meta = null;
        parts = [];
        onBlob(blob, done);
        return true;
      }
      return false;
    };
  }

  // Works out the real media type from the first bytes of a file. Servers often send a
  // generic or wrong Content-Type, and synthid.com only accepts specific MIME types.
  function sniffMediaType(bytes) {
    const ascii = (start, length) => String.fromCharCode(...bytes.subarray(start, start + length));
    const startsWith = (sig) => sig.every((value, i) => bytes[i] === value);
    const type = (mime, ext) => ({ mime, ext, kind: mime.split('/')[0] });

    if (startsWith([0xff, 0xd8, 0xff])) return type('image/jpeg', 'jpg');
    if (startsWith([0x89, 0x50, 0x4e, 0x47])) return type('image/png', 'png');
    if (ascii(0, 4) === 'GIF8') return type('image/gif', 'gif');
    if (ascii(0, 2) === 'BM') return type('image/bmp', 'bmp');
    if (ascii(0, 4) === 'RIFF') {
      if (ascii(8, 4) === 'WEBP') return type('image/webp', 'webp');
      if (ascii(8, 4) === 'WAVE') return type('audio/wav', 'wav');
    }
    if (startsWith([0x49, 0x49, 0x2a, 0x00]) || startsWith([0x4d, 0x4d, 0x00, 0x2a])) {
      return type('image/tiff', 'tiff');
    }
    if (ascii(4, 4) === 'ftyp') {
      // ISO base media file: check the major brand and the compatible brands in the ftyp box.
      const boxSize = Math.min(((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0, bytes.length);
      const brands = [ascii(8, 4)];
      for (let offset = 16; offset + 4 <= boxSize; offset += 4) brands.push(ascii(offset, 4));
      if (brands.some((b) => b === 'avif' || b === 'avis')) return type('image/avif', 'avif');
      if (brands.some((b) => ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'].includes(b))) {
        return type('image/heic', 'heic');
      }
      if (brands[0] === 'qt  ') return type('video/quicktime', 'mov');
      if (brands[0] === 'M4A ') return type('audio/x-m4a', 'm4a');
      return type('video/mp4', 'mp4');
    }
    if (startsWith([0x1a, 0x45, 0xdf, 0xa3])) return type('video/webm', 'webm');
    if (ascii(0, 4) === 'OggS') return type('audio/ogg', 'ogg');
    if (ascii(0, 4) === 'fLaC') return type('audio/flac', 'flac');
    if (ascii(0, 3) === 'ID3') return type('audio/mpeg', 'mp3');
    if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
      // MPEG audio frame sync: layer bits of 00 mean ADTS AAC, anything else is MP3.
      return (bytes[1] & 0x06) === 0 ? type('audio/aac', 'aac') : type('audio/mpeg', 'mp3');
    }
    return null;
  }

  // A download file name from parts like site, user and post ID, skipping missing ones.
  function fileName(parts, ext) {
    return `${parts.filter(Boolean).join('_').replace(/[^\w.-]+/g, '_')}.${ext}`;
  }

  // The current time for file names, e.g. 2026-10-24-13-47-05 (UTC).
  const timestamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

  globalThis.SynthIDShared = { api, MAX_BYTES, sendBlob, createBlobReceiver, sniffMediaType, fileName, timestamp };
})();
