// Dependency-free test runner: imports the test files directly so it works even in
// sandboxes where `node --test` cannot spawn its child processes.
// usage: node test/run-all.mjs
import './lang.test.js';
import './sim.test.js';
import './integration.test.js';
import './zip.test.js';
