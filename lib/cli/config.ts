/**
 * IGRIS CLI config — non-secret only. Resolution order for the base URL:
 *   IGRIS_BASE_URL env  →  ~/.igris/config.json  →  http://localhost:4100
 *
 * The home config may hold ONLY safe values (baseUrl, outputFormat, defaultProfile);
 * any credential-looking field is ignored. Provider API keys live server-side, never here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_BASE_URL = 'http://localhost:4100';

export type CliConfig = {
  baseUrl: string;
  json: boolean;
  yes: boolean;
};

export function homeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.IGRIS_CONFIG_PATH ?? path.join(os.homedir(), '.igris', 'config.json');
}

/** Read the safe home config, dropping any credential-looking field. Never throws. */
export function readHomeConfig(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  try {
    const raw = JSON.parse(fs.readFileSync(homeConfigPath(env), 'utf8')) as Record<string, unknown>;
    const safe: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (/key|token|secret|password/i.test(k)) continue; // never accept credentials from config
      if (typeof v === 'string') safe[k] = v;
    }
    return safe;
  } catch {
    return {};
  }
}

/** Resolve the effective config from env, home config, and parsed flags. */
export function resolveConfig(
  flags: { json?: boolean; yes?: boolean; baseUrl?: string },
  env: NodeJS.ProcessEnv = process.env,
): CliConfig {
  const home = readHomeConfig(env);
  const baseUrl = flags.baseUrl?.trim() || env.IGRIS_BASE_URL?.trim() || home.baseUrl || DEFAULT_BASE_URL;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    json: Boolean(flags.json) || home.outputFormat === 'json',
    yes: Boolean(flags.yes),
  };
}
