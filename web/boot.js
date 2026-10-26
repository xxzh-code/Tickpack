// Entry point for the Tickpack web app.
//
// The only module the UI imports from the compiler/simulator side is api.js
// (see docs/LANG.md §6). Everything else lives in web/**.

import { compile, Simulator, SAMPLES, PRELUDE } from '../src/api.js';

async function boot() {
  try {
    const { startApp } = await import('./app.js');
    startApp({ compile, Simulator, SAMPLES, PRELUDE }, { mode: 'real' });
  } catch (err) {
    console.error('[tickpack] failed to start app', err);
    document.body.dataset.appError = String((err && err.message) || err);
    const banner = document.createElement('pre');
    banner.className = 'boot-error';
    banner.textContent = 'Tickpack failed to start:\n\n' + ((err && err.stack) || err);
    document.body.appendChild(banner);
  }
}

boot();
