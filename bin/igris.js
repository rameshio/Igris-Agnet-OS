#!/usr/bin/env node
'use strict';
/**
 * Cross-platform launcher for the `igris` bin. Runs the TypeScript CLI entry through the
 * locally-installed `tsx` (no build step, works on Windows/macOS/Linux), forwarding argv
 * and the exit code. Tests invoke lib/cli/router#run directly and never spawn this.
 */
const path = require('path');
const { spawnSync } = require('child_process');

const tsxCli = path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
const entry = path.join(__dirname, '..', 'cli', 'igris.ts');

const res = spawnSync(process.execPath, [tsxCli, entry, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(res.status == null ? 1 : res.status);
