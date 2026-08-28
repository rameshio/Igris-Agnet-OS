/**
 * IGRIS CLI router — parse argv, resolve config, build the command context, dispatch to
 * a command group, and map errors to exit codes. This is the single testable entry:
 * `run(argv, deps)` returns an exit code and writes only through the injected IO, so
 * command logic is unit-tested with a mock client and no subprocess or live server.
 *
 * The CLI is a CONTROL SURFACE: it only speaks to the canonical HTTP API. It never
 * imports the DB, never implements mission/task logic, and never bypasses approvals.
 */
import { parseArgs } from 'node:util';
import { IgrisClient, ServerUnavailableError, type FetchLike } from '@/lib/cli/client';
import { resolveConfig } from '@/lib/cli/config';
import { makeBufferIo, type Io } from '@/lib/cli/output';
import { EXIT } from '@/lib/cli/exit';
import type { Ctx } from '@/lib/cli/context';
import { statusCommand } from '@/lib/cli/commands/status';
import { modelsCommand } from '@/lib/cli/commands/models';
import { missionCommand, taskCommand, artifactCommand } from '@/lib/cli/commands/company';
import { brainCommand, intelligenceCommand } from '@/lib/cli/commands/brain';
import { flowCommand, approvalsCommand } from '@/lib/cli/commands/flow';
import { askCommand } from '@/lib/cli/commands/ask';
import { ttyConfirm } from '@/lib/cli/prompt';

export type RunDeps = {
  io?: Io;
  client?: IgrisClient;
  fetchImpl?: FetchLike;
  confirm?: (q: string) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
};

const STRING_FLAGS = ['objective', 'window', 'model', 'input', 'note', 'max', 'mission', 'query', 'base-url'] as const;

const HELP = `IGRIS — terminal control surface for the IGRIS Agent OS

Usage: igris <command> [subcommand] [args] [--flags]

Commands:
  status                         API reachability + safe company/runtime summary
  models [providers|current|use] providers, effective default, or set default (canonical)
  ask "<question>" [--model p:m] read-only company question via the configured model
  mission list|show|create|plan|step|archive
  task   list --mission <id> | show <id> | eligible <id> | dispatch <id> | retry <id>
  artifact show <id> | promote <id>
  brain  search "<q>" | entity <id> | neighborhood <id> | promote-artifact <id>
  intelligence [--window 1h|24h|7d|30d]
  flow   list | show <id> | run <id> [--input "<text>"]
  approvals                      list pending human approvals
  approval approve|reject <id> [--note "<n>"]
  shell                          interactive REPL

Global flags:
  --json          machine-readable output
  --yes           skip confirmation on mutations (never bypasses Phase-E approval)
  --base-url URL  target server (default $IGRIS_BASE_URL or http://localhost:4100)
  --help          show help

Exit codes: 0 ok · 1 failure · 2 invalid input · 3 server unavailable · 4 not completed`;

const GROUPS: Record<string, (ctx: Ctx) => Promise<number>> = {
  status: statusCommand,
  models: modelsCommand,
  ask: askCommand,
  mission: missionCommand,
  task: taskCommand,
  artifact: artifactCommand,
  brain: brainCommand,
  intelligence: intelligenceCommand,
  flow: flowCommand,
  approvals: approvalsCommand,
  approval: approvalsCommand, // alias — args carry approve|reject
};

/** Parse argv into { group, args, flags } using node:util (tolerant of unknown flags). */
export function parseArgv(argv: string[]): { group?: string; args: string[]; flags: Record<string, string | boolean | undefined> } {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      json: { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      help: { type: 'boolean', short: 'h' },
      ...Object.fromEntries(STRING_FLAGS.map((f) => [f, { type: 'string' as const }])),
    },
  });
  return { group: positionals[0], args: positionals.slice(1), flags: values as Record<string, string | boolean | undefined> };
}

export async function run(argv: string[], deps: RunDeps = {}): Promise<number> {
  const io = deps.io ?? { out: (s) => console.log(s), err: (s) => console.error(s) };
  const { group, args, flags } = parseArgv(argv);

  if (!group || group === 'help' || (flags.help && !GROUPS[group])) {
    io.out(HELP);
    return EXIT.OK;
  }
  if (group === 'shell') {
    const { runShell } = await import('@/lib/cli/shell');
    return runShell(deps);
  }

  const handler = GROUPS[group];
  if (!handler) {
    io.err(`error: unknown command "${group}" — run \`igris --help\``);
    return EXIT.INVALID_INPUT;
  }

  const config = resolveConfig({ json: Boolean(flags.json), yes: Boolean(flags.yes), baseUrl: typeof flags['base-url'] === 'string' ? (flags['base-url'] as string) : undefined }, deps.env);
  const client = deps.client ?? new IgrisClient(config.baseUrl, deps.fetchImpl);
  const ctx: Ctx = { client, io, config, args, flags, confirm: deps.confirm ?? ttyConfirm };

  try {
    return await handler(ctx);
  } catch (err) {
    if (err instanceof ServerUnavailableError) {
      io.err(err.message);
      io.err('Start it with:  npm run dev   (then retry)');
      return EXIT.SERVER_UNAVAILABLE;
    }
    io.err(`error: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.FAILURE;
  }
}

/** Convenience for tests: run and return { code, stdout, stderr }. */
export async function runCaptured(argv: string[], deps: RunDeps = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const io = makeBufferIo();
  const code = await run(argv, { ...deps, io });
  return { code, stdout: io.stdout.join('\n'), stderr: io.stderr.join('\n') };
}
