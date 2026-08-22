/**
 * `igris shell` — a minimal interactive REPL over the same command router. Each line is
 * tokenized (quote-aware) and dispatched through `run()`, so the shell has no separate
 * logic and inherits every safety rule (confirmation, approvals, no DB access). Standard
 * Node readline — no heavy TUI dependency.
 */
import readline from 'node:readline';
import { EXIT } from '@/lib/cli/exit';
import type { RunDeps } from '@/lib/cli/router';

/** Quote-aware tokenizer: splits a line into argv, honoring "double" and 'single' quotes. */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

export async function runShell(deps: RunDeps = {}): Promise<number> {
  // Import lazily to avoid a router↔shell import cycle at module load.
  const { run } = await import('@/lib/cli/router');
  const io = deps.io ?? { out: (s: string) => console.log(s), err: (s: string) => console.error(s) };
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'IGRIS> ' });
  // Confirmations reuse the shell's own readline so prompts don't fight a second interface.
  const confirm = (q: string) => new Promise<boolean>((resolve) => rl.question(q, (a) => resolve(/^y(es)?$/i.test(a.trim()))));

  io.out('IGRIS interactive shell — type `help`, or `exit` to quit.');
  rl.prompt();
  await new Promise<void>((resolve) => {
    rl.on('line', async (line) => {
      const argv = tokenize(line.trim());
      const cmd = argv[0];
      if (!cmd) return rl.prompt();
      if (cmd === 'exit' || cmd === 'quit') return rl.close();
      if (cmd === 'shell') {
        io.err('already in the shell');
        return rl.prompt();
      }
      try {
        await run(argv, { ...deps, io, confirm });
      } catch (err) {
        io.err(`error: ${err instanceof Error ? err.message : String(err)}`);
      }
      rl.prompt();
    });
    rl.on('close', () => resolve());
  });
  return EXIT.OK;
}
