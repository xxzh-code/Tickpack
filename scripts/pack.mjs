// Build a ready-to-install datapack .zip from one of the samples.
// usage: node scripts/pack.mjs [sampleId]        (default: square)
// writes: dist/tickpack-<sample>-datapack.zip
import { mkdirSync, writeFileSync } from 'node:fs';
import { compile } from '../src/api.js';
import { SAMPLES } from '../src/samples.js';
import { packToZip } from '../src/zip.js';

const id = process.argv[2] || 'square';
const sample = SAMPLES.find((s) => s.id === id);
if (!sample) {
  console.error(`unknown sample '${id}'. known: ${SAMPLES.map((s) => s.id).join(', ')}`);
  process.exit(1);
}
const out = compile(sample.source);
if (!out.ok) {
  console.error('compile failed:', JSON.stringify(out.diagnostics, null, 2));
  process.exit(1);
}
mkdirSync('dist', { recursive: true });
const zipPath = `dist/tickpack-${sample.id}-datapack.zip`;
const bytes = packToZip(out.files);
writeFileSync(zipPath, bytes);
console.log(`${zipPath} — ${bytes.length} bytes, ${Object.keys(out.files).length} files (sample: ${sample.title})`);
console.log('install: saves/<world>/datapacks/tickpack/ <- unzip here, then /reload');
