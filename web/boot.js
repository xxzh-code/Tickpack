// Entry point for the Tickpack web app.
//
// The only module the UI imports from the compiler/simulator side is api.js
// (see docs/LANG.md §6). Everything else lives in web/**. The app receives the
// whole api object and drives the core `TickpackSession` from it.

import * as api from '../src/api.js';
import { startApp } from './app.js';

function boot() {
  try {
    startApp(api);
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
