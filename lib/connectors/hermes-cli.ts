/**
 * Local Hermes brain — an LLM provider that runs the agent's thinking through
 * the Hermes CLI on this machine instead of the cloud gateway. Invokes
 *   hermes chat -q "<prompt>" --quiet
 * (`-q` = single query, `--quiet` = programmatic mode) and returns stdout.
 *
 * Safe by construction: the prompt is passed as its own argv element with
 * shell:false, so nothing in the prompt is ever interpreted by a shell.
 * Config (all optional, read fresh from .env.local):
 *   HERMES_CLI_BIN         path/name of the CLI (default: "hermes")
 *   HERMES_CLI_ARGS        arg template; must contain {prompt} (default below)
 *   HERMES_CLI_TIMEOUT_MS  hard timeout (default 180000)
 */
import type { LlmProvider, LlmMessage } from '@/lib/connectors/llm';
import { runtimeEnv } from '@/lib/creds';

const DEFAULT_ARGS = 'chat -q {prompt} --quiet';
const PROMPT_TOKEN = '{prompt}';

/** Fold the system prompt + conversation into the single query Hermes takes. */
function buildPrompt(system: string | undefined, messages: LlmMessage[]): string {
  const convo = messages
    .filter((m) => m.role !== 'tool')
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n');
  return [system, convo].filter(Boolean).join('\n\n');
}

export function createHermesCliProvider(): LlmProvider {
  return {
    name: 'hermes-cli',
    async chat(req) {
      const env = runtimeEnv();
      const bin = env.HERMES_CLI_BIN?.trim() || 'hermes';
      const timeoutMs = Number(env.HERMES_CLI_TIMEOUT_MS) || 180_000;
      const template = (env.HERMES_CLI_ARGS?.trim() || DEFAULT_ARGS).split(/\s+/).filter(Boolean);

      const prompt = buildPrompt(req.system, req.messages);
      const args = template.map((a) => (a === PROMPT_TOKEN ? prompt : a));
      if (!template.includes(PROMPT_TOKEN)) args.push(prompt); // fallback: prompt last
      if (req.model) args.push('-m', req.model);

      const { spawn } = await import('node:child_process');
      const text = await new Promise<string>((resolve, reject) => {
        const child = spawn(bin, args, { windowsHide: true });
        let out = '';
        let err = '';
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`Hermes timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        child.stdout.on('data', (d) => (out += d.toString()));
        child.stderr.on('data', (d) => (err += d.toString()));
        child.on('error', (e) =>
          reject(new Error(`Could not run '${bin}' — is Hermes installed and on PATH? (${e.message})`)),
        );
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(out.trim());
          else reject(new Error(`Hermes exited ${code}: ${(err || out).trim().slice(0, 400) || 'no output'}`));
        });
      });

      return { text, toolCalls: [] };
    },
  };
}
