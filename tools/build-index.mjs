// Builds lessons/index.json — the list of lesson files the website loads.
// Runs automatically in the GitHub Action; run it yourself when testing locally:
//   node tools/build-index.mjs
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../lessons/', import.meta.url));

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (entry.name.toLowerCase().endsWith('.json') && full !== join(root, 'index.json')) out.push(full);
  }
  return out;
}

const files = (await walk(root)).sort();
let problems = 0;
for (const file of files) {
  try {
    JSON.parse((await readFile(file, 'utf8')).replace(/^﻿/, ''));
  } catch (e) {
    problems++;
    console.log(`::warning file=lessons/${relative(root, file).split(sep).join('/')}::Invalid JSON — ${e.message}`);
  }
}

const list = files.map(f => relative(root, f).split(sep).join('/'));
await writeFile(join(root, 'index.json'), JSON.stringify({ files: list }, null, 2) + '\n');
console.log(`Wrote lessons/index.json with ${list.length} file(s)${problems ? `, ${problems} with problems` : ''}.`);
