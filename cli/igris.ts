#!/usr/bin/env node
/**
 * IGRIS CLI entry — thin. Parses argv, runs the command router, propagates the exit code.
 * All logic lives in lib/cli/* (HTTP-only control surface); this file just wires stdio.
 * Run via `npm run cli -- <args>`, or the `igris` bin after `npm link`.
 */
import { run } from '@/lib/cli/router';

// Set exitCode and let the loop drain (avoids a Windows libuv teardown assertion that
// `process.exit()` can trigger while HTTP keep-alive sockets are closing). A short
// unref'd fallback forces exit if a stray handle would otherwise keep the process alive.
run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 200).unref();
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 200).unref();
  });
