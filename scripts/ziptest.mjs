import { compile } from '../src/api.js';
import { SAMPLES } from '../src/samples.js';
import { packToZip } from '../src/zip.js';
import { writeFileSync, mkdirSync } from 'node:fs';
const out = compile(SAMPLES.find(s => s.id === 'square').source);
const zip = packToZip(out.files);
mkdirSync('shots', { recursive: true });
writeFileSync('shots/tickpack-test.zip', zip);
console.log('zip bytes =', zip.length, 'files =', Object.keys(out.files).length);

