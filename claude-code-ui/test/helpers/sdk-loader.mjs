/*
 * Registers the SDK resolution hook. Used as `node --import <this file> server/index.js`
 * so the server under test imports the stub instead of the real Agent SDK — no
 * 240 MB download, and every turn is deterministic.
 */
import { register } from 'node:module';

register(new URL('./sdk-hooks.mjs', import.meta.url));
