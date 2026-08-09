# INCIDENTS — failures & RCAs

> Significant development/production-style failures that revealed real system
> behavior. Not for typos or ordinary compile errors. Severity: SEV-1 (critical
> outage / security / data corruption) · SEV-2 (major functionality or serious
> correctness) · SEV-3 (limited failure with workaround) · SEV-4 (minor). Do not
> inflate severity.

## Template

```
Incident ID · Date · Severity · Status
Affected area · Summary · Impact
Detection · Root cause · Resolution
Files changed · Tests added · Data impact · Security impact
Rollback/Recovery · Preventive action
```

---

### INC-001 — Flow runs falsely reported `interrupted`
- **Severity:** SEV-3 · **Status:** Resolved · **Area:** `/flows` execution (Phase C).
- **Summary:** During Phase C smoke, a running workflow showed `run: interrupted` while its agent node was still `running`; the final output was empty.
- **Impact:** Long (Hermes) runs appeared to fail even though they would have succeeded; misleading run status.
- **Detection:** Manual smoke test polling `GET /api/flows/runs/:runId`.
- **Root cause:** The run coordinator (`lib/flows/coordinator.ts`) tracked in-flight runs in a plain module-level `Set`. Next.js bundles each API route separately, so the `POST /runs` route and the `GET /runs/:id` route each got their **own** module instance and their **own** Set. The GET route's `reconcile()` saw the run as `running` but "not active" (its Set was empty) and marked it `interrupted` mid-run. The failure path had passed only because it finished fast (terminal before any poll).
- **Resolution:** Pin the active-run registry to `globalThis` (`globalThis.__igrisFlowActiveRuns`) so it is a true single process-wide singleton across route bundles.
- **Files changed:** `lib/flows/coordinator.ts`.
- **Tests added:** covered by the existing `flow-run-api.test.ts` polling-to-completion assertion (single vitest module → the bug was masked there); the fix was verified by re-running the live smoke to success. Follow-up (recommended): a test that starts a run via the route module and asserts it does not reconcile to `interrupted` while active.
- **Data impact:** none (status corrected on completion; runs are append/update). **Security impact:** none.
- **Rollback/Recovery:** revert the one-line change (would reintroduce the bug). Forward-fix preferred.
- **Preventive action:** Documented as decision D11 (`DECISIONS.md`): process-wide singletons that must survive Next per-route bundling live on `globalThis`.

---

### INC-002 — Live Telegram bot token deleted during test cleanup
- **Severity:** SEV-2 · **Status:** Resolved · **Area:** connectors / credentials.
- **Summary:** A cleanup step issued a destructive `DELETE` against a live connector during testing, removing the user's real Telegram bot token from `.env.local`.
- **Impact:** The user's connected Telegram integration stopped working until the token was re-entered.
- **Detection:** User observed the integration disconnected.
- **Root cause:** A destructive cleanup was run against the user's **live** credentials instead of a disposable/test value.
- **Resolution:** User re-added the token; the connector reconnected.
- **Preventive action:** Never run destructive cleanups against live credentials. In tests, mock `@/lib/creds` with an in-memory map so credential writes never touch the real `.env.local` (now the standard pattern — see `TESTING-GUIDE.md`).
- **Data/Security impact:** a live credential value was removed (not leaked); no exposure. **Rollback:** re-enter the credential (no automated rollback for external secrets).

---

### INC-003 — False "Connected" provider/connector status
- **Severity:** SEV-3 · **Status:** Resolved · **Area:** connectors / Models board.
- **Summary:** Some connectors reported "connected" merely because a key/URL was present, without a real check.
- **Impact:** Misleading status; a "connected" provider could still fail on use.
- **Root cause:** Presence-of-config was treated as connectivity.
- **Resolution:** Introduced honest states (e.g. `unverified`/`configured` vs `connected`); connection requires a real backend check (`POST /api/models {action:'test'}` → `recordCheck`). Status reflects the last real check.
- **Files changed:** connector status logic; `lib/models/connections.ts` `providerState`.
- **Preventive action:** Invariant "honest states" (`CODING-METHODOLOGY.md § Honest states`); status derives from a real check, never mere key presence.

---

### INC-004 — Canvas "Delete" removed the underlying agent everywhere
- **Severity:** SEV-3 · **Status:** Resolved · **Area:** flow/agent canvas UX.
- **Summary:** Deleting a node from the canvas called `DELETE /api/agents/:id`, permanently removing the agent from the whole app (not just the canvas).
- **Impact:** Accidental permanent loss of an agent from a non-destructive-looking action.
- **Root cause:** A single canvas action conflated "remove node from this graph" with "delete the agent entity."
- **Resolution:** Split into **Remove from canvas** (node-only, non-destructive) and a clearly-labeled two-step **Delete agent** (permanent). Confirmation is inline (not `window.confirm`, which was also unreliable in embedded browsers).
- **Preventive action:** Destructive vs non-destructive actions must be visually and behaviorally distinct; destructive actions require explicit two-step confirmation (relevant to Phase E approval gates).
