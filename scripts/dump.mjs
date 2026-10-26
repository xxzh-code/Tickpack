// Dev tool: print the generated datapack for a sample (or for a source file).
// usage: node scripts/dump.mjs [sampleId] [fileFilter]
//        node scripts/dump.mjs --source path/to/program.tp
import { readFileSync } from 'node:fs';
import { compile } from '../src/api.js';
import { SAMPLES } from '../src/samples.js';

let source;
let sampleId = 'square';
const args = process.argv.slice(2);
const srcIdx = args.indexOf('--source');
if (srcIdx >= 0) {
  source = readFileSync(args[srcIdx + 1], 'utf8');
} else {
  sampleId = args[0] || 'square';
  source = SAMPLES.find((s) => s.id === sampleId)?.source;
  if (!source) {
    console.error(`unknown sample '${sampleId}'. known: ${SAMPLES.map((s) => s.id).join(', ')}`);
    process.exit(1);
  }
}
const filter = srcIdx >= 0 ? args[srcIdx + 2] || '' : args[1] || '';

const out = compile(source);
console.log(`sample=${sampleId} ok=${out.ok} files=${Object.keys(out.files).length} meta=${JSON.stringify(out.meta)}`);
if (!out.ok) {
  console.error(JSON.stringify(out.diagnostics, null, 2));
  process.exit(1);
}
for (const [path, text] of Object.entries(out.files)) {
  if (filter && !path.includes(filter)) continue;
  console.log(`\n========== ${path} ==========`);
  console.log(text.replace(/\n$/, ''));
}
