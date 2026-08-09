import { afterEach, describe, expect, test, vi } from 'vitest';
import { createHermesCliProvider } from '@/lib/connectors/hermes-cli';

// Stand in for the real `hermes` binary with `node`, echoing the prompt back so
// we can prove the provider builds args, spawns the process, and returns stdout
// as the answer — cross-platform, no Hermes install needed.
afterEach(() => vi.unstubAllEnvs());

describe('Hermes CLI brain provider', () => {
  test('runs the configured command and returns its stdout as the answer', async () => {
    vi.stubEnv('HERMES_CLI_BIN', process.execPath); // the node binary
    vi.stubEnv('HERMES_CLI_ARGS', '-e process.stdout.write(process.argv[1]||"") {prompt}');
    const res = await createHermesCliProvider().chat({
      system: 'SYS',
      messages: [{ role: 'user', content: 'hello world' }],
    });
    expect(res.text).toContain('hello world'); // the prompt was piped through and echoed
    expect(res.text).toContain('SYS'); // system prompt folded into the query
    expect(res.toolCalls).toEqual([]);
  });

  test('passes the prompt as a single argv element (no shell interpolation)', async () => {
    vi.stubEnv('HERMES_CLI_BIN', process.execPath);
    vi.stubEnv('HERMES_CLI_ARGS', '-e process.stdout.write(process.argv[1]||"") {prompt}');
    // characters that would break a shell must pass through untouched
    const nasty = 'a"b; rm -rf / && echo $HOME `whoami`';
    const res = await createHermesCliProvider().chat({ messages: [{ role: 'user', content: nasty }] });
    expect(res.text).toContain(nasty);
  });

  test('fails honestly when the command is not found', async () => {
    vi.stubEnv('HERMES_CLI_BIN', 'definitely-not-a-real-binary-xyz');
    vi.stubEnv('HERMES_CLI_ARGS', '{prompt}');
    await expect(
      createHermesCliProvider().chat({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/Could not run|ENOENT|Hermes exited/i);
  });
});
