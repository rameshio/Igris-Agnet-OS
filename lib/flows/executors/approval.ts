/**
 * Human Approval executor (Phase E).
 *
 * The approval node is a DURABLE PAUSE-POINT, not a normal executor: the engine
 * intercepts approval nodes (`handleApproval` in engine.ts) to open a pending
 * `flow_approvals` request and stop the run, then applies the human's decision on
 * resume. This executor therefore exists only to (a) validate the node's config
 * and (b) register the type as `executable` so the validator lets a workflow with
 * an approval node run. `execute` is never reached; it throws defensively so a
 * future refactor that accidentally routes an approval node through `runNode`
 * fails loudly instead of silently auto-approving.
 */
import type { NodeExecutor } from '@/lib/flows/registry';
import { validateNodeConfig } from '@/lib/flows/registry';
import { NodeExecError } from '@/lib/flows/errors';

export const approvalExecutor: NodeExecutor = {
  type: 'approval',
  executable: true,
  validateConfig: (config) => validateNodeConfig('approval', config),
  execute: async () => {
    // Unreachable: the engine handles approval pause/resume directly. Never
    // auto-resolve — only a human, via the approval API, decides.
    throw new NodeExecError('approval_not_directly_executable', 'Human Approval nodes are resolved by the engine, not executed directly.');
  },
};
