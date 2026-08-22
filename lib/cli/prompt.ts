/**
 * Interactive y/N confirmation for mutations. Reads a single line from the TTY; in a
 * non-interactive session (no TTY) it returns false so a mutation is never performed
 * without an explicit `--yes`. Never echoes secrets.
 */
import readline from 'node:readline';

export async function ttyConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
