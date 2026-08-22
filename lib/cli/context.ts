/**
 * Shared command context + small helpers for the IGRIS CLI. Every command receives a
 * `Ctx` (client + io + config + parsed args + a confirm fn) and returns an exit code.
 * Mutations MUST route through `ensureConfirmed` so a preview is shown and confirmation
 * is required unless `--yes`; even `--yes` cannot bypass server-side Phase-E approval.
 */
import type { IgrisClient } from '@/lib/cli/client';
import type { Io } from '@/lib/cli/output';
import type { CliConfig } from '@/lib/cli/config';
import { EXIT } from '@/lib/cli/exit';

export type Flags = Record<string, string | boolean | undefined>;

export type Ctx = {
  client: IgrisClient;
  io: Io;
  config: CliConfig;
  /** Positionals AFTER the group name (e.g. for `mission show X` → ['show', 'X']). */
  args: string[];
  flags: Flags;
  /** Ask the operator to confirm a mutation. Injectable for tests. */
  confirm: (question: string) => Promise<boolean>;
};

/** Read a string flag by any of the given names. */
export function flag(ctx: Ctx, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = ctx.flags[n];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

/** Print a usage error and return the INVALID_INPUT exit code. */
export function invalid(ctx: Ctx, message: string): number {
  ctx.io.err(`error: ${message}`);
  return EXIT.INVALID_INPUT;
}

/**
 * Show a preview and require confirmation for a mutation. Returns true to proceed.
 * `--yes` skips the prompt; a non-interactive session without `--yes` refuses (the
 * caller returns ACTION_NOT_COMPLETED). This never bypasses Phase-E approval — the
 * server owns that regardless of the answer here.
 */
export async function ensureConfirmed(ctx: Ctx, preview: string): Promise<boolean> {
  ctx.io.out(preview);
  if (ctx.config.yes) return true;
  return ctx.confirm('Continue? [y/N] ');
}

/** Map a non-2xx API response to a readable error line + a sensible exit code. */
export function reportApiError(ctx: Ctx, status: number, data: unknown): number {
  const msg = (data as { error?: string })?.error ?? `HTTP ${status}`;
  ctx.io.err(`error: ${msg}`);
  if (status === 400 || status === 404 || status === 422) return EXIT.INVALID_INPUT;
  if (status === 409) return EXIT.ACTION_NOT_COMPLETED; // e.g. workflow not published / needs approval
  return EXIT.FAILURE;
}
