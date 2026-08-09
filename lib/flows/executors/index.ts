/**
 * Registers the Phase-C executable executors, overriding the config-only stubs
 * for input/agent/output. Importing this module wires them into the shared
 * NodeExecutorRegistry. The engine imports this for its side effect.
 */
import { nodeExecutorRegistry } from '@/lib/flows/registry';
import { inputExecutor } from '@/lib/flows/executors/input';
import { agentExecutor } from '@/lib/flows/executors/agent';
import { outputExecutor } from '@/lib/flows/executors/output';

nodeExecutorRegistry.register(inputExecutor);
nodeExecutorRegistry.register(agentExecutor);
nodeExecutorRegistry.register(outputExecutor);
