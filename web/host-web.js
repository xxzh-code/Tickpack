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
//   storageGet(key) / storageSet(key, value) / storageRemove(key)
//   canExport / canImport / canPersist       (capability flags)
//
// Everything is created lazily inside the methods so importing this module in a
// non-browser context (e.g. a Node smoke test) does not touch the DOM.

const TEXT_MIME = 'text/plain;charset=utf-8';

export function createWebHost({ doc = null, nav = null, win = null } = {}) {
  const getDoc = () => doc || (typeof document !== 'undefined' ? document : null);
  const getNav = () => nav || (typeof navigator !== 'undefined' ? navigator : null);
  const getWin = () => win || (typeof window !== 'undefined' ? window : null);

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

  return {
    exportDatapack,
    importTextFile,
    exportTextFile,
    copyText,
    storageGet,
    storageSet,
    storageRemove,
    canExport: typeof Blob !== 'undefined' && typeof URL !== 'undefined'
      && typeof URL.createObjectURL === 'function',
    canImport: typeof FileReader !== 'undefined' || typeof Blob !== 'undefined' || !!getWin(),
    canPersist: !!getWin(),
  };
}
