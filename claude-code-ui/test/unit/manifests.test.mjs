/*
 * The dev manifest exists so a test dependency never has to be added to the
 * runtime one (which the Dockerfile copies, and whose every change busts the
 * npm install layer). The price of that split is drift: tests would happily
 * exercise a different express or ws than the image ships.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => JSON.parse(readFileSync(path.join(APP_ROOT, p), 'utf8'));

const runtime = read('server/package.json');
const dev = read('package.json');

describe('the runtime and dev manifests', () => {
  test('agree on every dependency they share', () => {
    for (const [name, range] of Object.entries(runtime.dependencies)) {
      if (!(name in dev.devDependencies)) continue;
      assert.equal(dev.devDependencies[name], range,
        `${name} is ${range} at runtime but ${dev.devDependencies[name]} under test`);
    }
  });

  test('cover everything the server imports at runtime', () => {
    const source = readFileSync(path.join(APP_ROOT, 'server', 'index.js'), 'utf8');
    const imported = [...source.matchAll(/^import .*? from '([^'.][^']*)';$/gm)]
      .map((m) => m[1])
      .filter((s) => !s.startsWith('node:'))
      .filter((s) => !['http', 'fs', 'child_process', 'util', 'path', 'crypto'].includes(s));
    for (const dep of new Set(imported)) {
      assert.ok(dep in runtime.dependencies, `server/index.js imports ${dep}, which is not a runtime dependency`);
    }
  });
});

describe('the Agent SDK', () => {
  test('is pinned exactly, so the published image is reproducible', () => {
    const version = runtime.dependencies['@anthropic-ai/claude-agent-sdk'];
    assert.match(version, /^\d+\.\d+\.\d+$/,
      'a range would let the image drift between builds of the same app version');
  });
});

describe('the dev manifest', () => {
  test('is private, so it can never be published by accident', () => {
    assert.equal(dev.private, true);
  });
});
