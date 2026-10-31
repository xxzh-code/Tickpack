// Browser platform adapter (SHELL LAYER).
//
// This is the ONLY module in web/** that performs platform side effects for the
// core: downloading a bundle to the file system and writing to the clipboard.
// The core (src/session.js) builds the files/zip and knows nothing about this.
// A desktop (Electron/Tauri) or CLI shell implements the same two methods
// differently (write a directory / write files with fs), and app.js does not care.
//
// Host interface (documented in docs/ARCH.md):
//   exportDatapack({ filename, files, zip }) -> Promise<string>  // delivered name
//   copyText(text) -> Promise<boolean>
//
// Everything is created lazily inside the methods so importing this module in a
// non-browser context (e.g. a Node smoke test) does not touch the DOM.

export function createWebHost({ doc = null, nav = null } = {}) {
  const getDoc = () => doc || (typeof document !== 'undefined' ? document : null);
  const getNav = () => nav || (typeof navigator !== 'undefined' ? navigator : null);

  async function exportDatapack(bundle) {
    if (!bundle || !(bundle.zip instanceof Uint8Array) || !bundle.zip.length) {
      throw new Error('exportDatapack: expected { filename, files, zip }');
    }
    const d = getDoc();
    if (!d || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      throw new Error('exportDatapack: this host cannot create downloads');
    }
    const blob = new Blob([bundle.zip], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = d.createElement('a');
    a.href = url;
    a.download = bundle.filename || 'tickpack-datapack.zip';
    a.rel = 'noopener';
    (d.body || d.documentElement).appendChild(a);
    try {
      a.click();
    } finally {
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return a.download;
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

  return {
    exportDatapack,
    copyText,
    /** True when this shell can deliver a download (used for UI affordances). */
    canExport: typeof Blob !== 'undefined' && typeof URL !== 'undefined'
      && typeof URL.createObjectURL === 'function',
  };
}
