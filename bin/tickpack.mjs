#!/usr/bin/env node
// Tickpack CLI — the Node shell entry point (`tickpack` / `tpk`).
//
// Core stays platform-agnostic (src/**); this file is a shell: it reads/writes
// files and starts the local server, exactly like web/host-web.js does for the
// browser. See docs/ARCH.md.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { compile } from '../src/lang/compile.js';
import { packToZip } from '../src/zip.js';
import { SAMPLES } from '../src/samples.js';
import { startServer } from '../server.mjs';

const HELP = `Tickpack CLI

用法:
  tickpack                      启动本地服务器（默认 8123，可设 TICKPACK_PORT）
  tickpack serve [--port 8123]  同上
  tickpack build <file.tpk>     把 .tpk 程序编译成可安装的数据包 zip
        [-o <out.zip>]          （默认 dist/tickpack-datapack.zip）
  tickpack pack <sample>        编译内置示例；示例: ${SAMPLES.map((s) => s.id).join(', ')}
        [-o <out.zip>]
  tickpack list                 列出内置示例
  tickpack --help | --version

短别名: tpk
`;

function argValue(args, flag, fallback) {
  const i = args.indexOf(flag);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('-')) return args[i + 1];
  return fallback;
}

async function writePack(source, outPath, label) {
  const result = compile(source);
  if (!result.ok) {
    console.error(`编译失败（${label}）：`);
    for (const d of result.diagnostics || []) {
      console.error(`  ${d.line ? `第 ${d.line} 行: ` : ''}${d.message}`);
    }
    process.exitCode = 1;
    return;
  }
  const out = resolve(outPath);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, packToZip(result.files));
  const files = Object.keys(result.files).length;
  console.log(`已生成 ${out}（${files} 个文件）`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === 'serve') {
    const port = argValue(argv, '--port', process.env.TICKPACK_PORT || process.env.PORT);
    startServer({ port: port ? Number(port) : undefined });
    return;
  }
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(HELP);
    return;
  }
  if (cmd === '--version' || cmd === '-v') {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(`tickpack ${pkg.version}`);
    return;
  }
  if (cmd === 'list') {
    for (const s of SAMPLES) console.log(`${s.id.padEnd(10)} ${s.title}`);
    return;
  }
  if (cmd === 'build') {
    const file = argv[1];
    if (!file || file.startsWith('-')) {
      console.error('用法: tickpack build <file.tpk> [-o out.zip]');
      process.exitCode = 2;
      return;
    }
    const source = await readFile(resolve(file), 'utf8');
    const ext = extname(file);
    const defaultOut = `dist/${basename(file, ext || '.tpk')}-datapack.zip`;
    await writePack(source, argValue(argv, '-o', process.env.TICKPACK_OUT || defaultOut), file);
    return;
  }
  if (cmd === 'pack') {
    const id = argv[1];
    const sample = SAMPLES.find((s) => s.id === id);
    if (!sample) {
      console.error(`未知示例 '${id || ''}'；可用: ${SAMPLES.map((s) => s.id).join(', ')}`);
      process.exitCode = 2;
      return;
    }
    await writePack(sample.source, argValue(argv, '-o', `dist/tickpack-${sample.id}-datapack.zip`), sample.id);
    return;
  }

  console.error(`未知命令 '${cmd}'。\n\n${HELP}`);
  process.exitCode = 2;
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
