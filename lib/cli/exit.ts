/**
 * IGRIS CLI exit codes — meaningful + documented for scripting.
 *   0 success · 1 generic failure · 2 invalid input · 3 server unavailable
 *   4 approval required / action not completed
 */
export const EXIT = {
  OK: 0,
  FAILURE: 1,
  INVALID_INPUT: 2,
  SERVER_UNAVAILABLE: 3,
  ACTION_NOT_COMPLETED: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
