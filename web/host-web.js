// Browser platform adapter (SHELL LAYER).
//
// This is the ONLY module in web/** that performs platform side effects for the
// core: file download/import, clipboard, and browser persistence. The core
// (src/session.js) builds packs/zip bytes and knows nothing about any of this.
// A desktop (Electron/Tauri) or CLI shell implements the same interface
// differently (write directory / fs.readFile / config file) and app.js does not
// care.
//
// Host interface (documented in docs/ARCH.md):
//   exportDatapack({ filename, files, zip }) -> Promise<string>
//   importTextFile({ accept })               -> Promise<{name,text}|null>
//   exportTextFile({ filename, text, mime }) -> Promise<string>
//   copyText(text)                           -> Promise<boolean>
//   playSound({ name, pitch, volume })       -> boolean
//   storageGet(key) / storageSet(key, value) / storageRemove(key)
//   canExport / canImport / canPersist / sound (capability flags)
//
// Everything is created lazily inside the methods so importing this module in a
// non-browser context (e.g. a Node smoke test) does not touch the DOM.

const TEXT_MIME = 'text/plain;charset=utf-8';

export function createWebHost({ doc = null, nav = null, win = null } = {}) {
  const getDoc = () => doc || (typeof document !== 'undefined' ? document : null);
  const getNav = () => nav || (typeof navigator !== 'undefined' ? navigator : null);
  const getWin = () => win || (typeof window !== 'undefined' ? window : null);

  let audioCtx = null;
  let audioGestureBound = false;

  function bindAudioGesture() {
    const w = getWin();
    if (!w || audioGestureBound || typeof w.addEventListener !== 'function') return;
    audioGestureBound = true;
    const resume = () => {
      const ctx = ensureAudio();
      if (ctx && ctx.state === 'suspended') {
        try {
          const p = ctx.resume();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch { /* ignore */ }
      }
    };
    w.addEventListener('pointerdown', resume, { once: true, passive: true });
    w.addEventListener('keydown', resume, { once: true });
  }

  function ensureAudio() {
    const w = getWin();
    if (!w) return null;
    const Ctor = w.AudioContext || w.webkitAudioContext;
    if (typeof Ctor !== 'function') return null;
    if (!audioCtx) {
      try { audioCtx = new Ctor(); } catch { return null; }
      bindAudioGesture();
    }
    if (audioCtx.state === 'suspended') {
      try {
        const p = audioCtx.resume();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch { /* ignore */ }
    }
    return audioCtx;
  }

  /**
   * Short Web Audio blip for a simulator `sound` event. No files/network.
   * Returns false when muted, unsupported, or the context cannot be created.
   */
  function playSound({ name = '', pitch = 1, volume = 1 } = {}) {
    if (storageGet('tickpack.sound') === '0') return false;
    const ctx = ensureAudio();
    if (!ctx) return false;
    // Autoplay policy: don't queue a burst of sealed oscillators while the
    // context is still locked; a later pointer/key gesture resumes it.
    if (ctx.state !== 'running') return false;
    const key = String(name || '').toLowerCase();
    const p = Number(pitch);
    const v = Number(volume);
    const pitchValue = Math.min(2, Math.max(0.5, Number.isFinite(p) ? p : 1));
    const volumeValue = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 1));

    let base = 440;
    let type = 'triangle';
    let duration = 0.09;
    if (/hat|click|tap|snare|drum|wood|stone/.test(key)) {
      base = 620;
      type = 'square';
      duration = 0.045;
    } else if (/bell|chime|note|harp|pling|glass/.test(key)) {
      base = 880;
      type = 'sine';
      duration = 0.09;
    } else if (/bass|boom|explode|thunder/.test(key)) {
      base = 120;
      type = 'sawtooth';
      duration = 0.12;
    }
    duration = Math.max(0.03, Math.min(0.12, duration));
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(base * pitchValue, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.14 * volumeValue), t0 + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
    return true;
  }

  function downloadBlob(blob, filename) {
    const d = getDoc();
    if (!d || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      throw new Error('this host cannot create downloads');
    }
    const url = URL.createObjectURL(blob);
    const a = d.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    (d.body || d.documentElement).appendChild(a);
    try {
      a.click();
    } finally {
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return filename;
  }

  async function exportDatapack(bundle) {
    if (!bundle || !(bundle.zip instanceof Uint8Array) || !bundle.zip.length) {
      throw new Error('exportDatapack: expected { filename, files, zip }');
    }
    const blob = new Blob([bundle.zip], { type: 'application/zip' });
    return downloadBlob(blob, bundle.filename || 'tickpack-datapack.zip');
  }

  /**
   * Ask the user for a text file and return its content.
   * Desktop shells would show their native open dialog here.
   * @returns {Promise<{name: string, text: string}|null>} null on cancel
   */
  async function importTextFile({ accept = '.tpk,.tp,.txt,text/plain' } = {}) {
    const w = getWin();
    // Preferred: File System Access API (Chromium, localhost/secure context).
    if (w && typeof w.showOpenFilePicker === 'function') {
      try {
        const handles = await w.showOpenFilePicker({
          multiple: false,
          types: [{
            description: 'Tickpack 程序',
            accept: { 'text/plain': ['.tpk', '.tp', '.txt'] },
          }],
        });
        const file = await handles[0].getFile();
        return { name: file.name, text: await file.text() };
      } catch (err) {
        if (err && err.name === 'AbortError') return null;
        // Fall back to the classic <input type=file> below.
      }
    }

    const d = getDoc();
    if (!d) return null;
    return new Promise((resolve) => {
      const input = d.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.style.display = 'none';
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        input.remove();
        resolve(value);
      };
      input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        if (!file) return finish(null);
        try {
          finish({ name: file.name, text: await file.text() });
        } catch {
          finish(null);
        }
      });
      // No cross-browser cancel event: if focus returns and nothing was picked,
      // resolve null so the app does not await forever.
      w?.addEventListener('focus', () => {
        setTimeout(() => {
          if (!input.files || input.files.length === 0) finish(null);
        }, 500);
      }, { once: true });
      (d.body || d.documentElement).appendChild(input);
      input.click();
    });
  }

  /** Save a text file (e.g. the current .tpk program). */
  async function exportTextFile({ filename = 'tickpack-program.tpk', text = '', mime = TEXT_MIME } = {}) {
    const blob = new Blob([String(text)], { type: mime });
    return downloadBlob(blob, filename);
  }

  async function copyText(text) {
    const value = String(text == null ? '' : text);
    const navRef = getNav();
    if (navRef && navRef.clipboard && typeof navRef.clipboard.writeText === 'function') {
      try {
        await navRef.clipboard.writeText(value);
        return true;
      } catch {
        // fall through to the legacy path
      }
    }
    const d = getDoc();
    if (!d) return false;
    try {
      const ta = d.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      (d.body || d.documentElement).appendChild(ta);
      ta.select();
      const ok = typeof d.execCommand === 'function' ? d.execCommand('copy') : false;
      ta.remove();
      return !!ok;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------ persistence
  // The shell owns where preferences live. Web: localStorage. Desktop: file.

  function storageGet(key) {
    const w = getWin();
    try {
      return w && w.localStorage ? w.localStorage.getItem(key) : null;
    } catch {
      return null;
    }
  }

  function storageSet(key, value) {
    const w = getWin();
    try {
      if (w && w.localStorage) w.localStorage.setItem(key, String(value));
      return true;
    } catch {
      return false;
    }
  }

  function storageRemove(key) {
    const w = getWin();
    try {
      if (w && w.localStorage) w.localStorage.removeItem(key);
      return true;
    } catch {
      return false;
    }
  }

  bindAudioGesture();

  return {
    exportDatapack,
    importTextFile,
    exportTextFile,
    copyText,
    playSound,
    storageGet,
    storageSet,
    storageRemove,
    canExport: typeof Blob !== 'undefined' && typeof URL !== 'undefined'
      && typeof URL.createObjectURL === 'function',
    canImport: typeof FileReader !== 'undefined' || typeof Blob !== 'undefined' || !!getWin(),
    canPersist: !!getWin(),
    sound: true,
  };
}
