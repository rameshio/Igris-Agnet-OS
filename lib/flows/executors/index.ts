/**
 * Registers the Phase-C executable executors, overriding the config-only stubs
 * for input/agent/output. Importing this module wires them into the shared
 * NodeExecutorRegistry. The engine imports this for its side effect.
 */
import { nodeExecutorRegistry } from '@/lib/flows/registry';
import { inputExecutor } from '@/lib/flows/executors/input';
import { agentExecutor } from '@/lib/flows/executors/agent';
import { outputExecutor } from '@/lib/flows/executors/output';
import { transformExecutor } from '@/lib/flows/executors/transform';
import { decisionExecutor } from '@/lib/flows/executors/decision';
import { parallelExecutor } from '@/lib/flows/executors/parallel';
import { joinExecutor } from '@/lib/flows/executors/join';
import { approvalExecutor } from '@/lib/flows/executors/approval';

nodeExecutorRegistry.register(inputExecutor);
nodeExecutorRegistry.register(agentExecutor);
nodeExecutorRegistry.register(outputExecutor);
// Phase D logic/control nodes:
nodeExecutorRegistry.register(transformExecutor);
nodeExecutorRegistry.register(decisionExecutor);
nodeExecutorRegistry.register(parallelExecutor);
nodeExecutorRegistry.register(joinExecutor);
// Phase E human-approval gate (engine-intercepted; see executors/approval.ts):
nodeExecutorRegistry.register(approvalExecutor);
