#!/usr/bin/env node
/**
 * Publish/pack gate (P43/P49): the advertised plugin entry must exist and
 * export exactly one unique plugin function, so OpenCode cannot invoke helper
 * exports as plugins.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  'dist/plugin/model-escalator.js',
  'dist/plugin/model-escalator.d.ts',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
];
for (const rel of required) {
  const p = resolve(root, rel);
  if (!existsSync(p)) {
    throw new Error(`assert-pack: missing ${rel}`);
  }
}

const entry = pathToFileURL(resolve(root, 'dist/plugin/model-escalator.js')).href;
const mod = await import(entry);
const fns = Object.values(mod).filter((v) => typeof v === 'function');
const unique = new Set(fns);
if (unique.size !== 1) {
  throw new Error(
    `assert-pack: expected exactly one unique plugin function on exports["."]; got ${unique.size} (${fns.map((f) => f?.name).join(', ')})`,
  );
}

console.log('assert-pack: ok — single plugin function at dist/plugin/model-escalator.js');
