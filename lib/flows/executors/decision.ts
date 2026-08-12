/**
 * Decision executor (Phase D) — deterministic machine routing (NOT an LLM, spec §10).
 *
 * Evaluates an ordered rule list FIRST-MATCH (spec §55) via the shared condition
 * evaluator, then selects the matching rule's route (or `defaultRoute`). The
 * selected route is written to `output.data.selectedRoute`; the engine uses it to
 * decide which outgoing edges (by `sourceHandle`) are active. `evaluated` records
 * every rule outcome so the Run Inspector can reconstruct the decision (spec §38).
 */
import { validateNodeConfig, type NodeExecutor } from '@/lib/flows/registry';
import { NodeExecError } from '@/lib/flows/errors';
import { evaluateCondition, type Condition } from '@/lib/flows/conditions';

type DecisionConfig = { rules?: { route: string; condition: Condition }[]; defaultRoute?: string };

export const decisionExecutor: NodeExecutor = {
  type: 'decision',
  executable: true,
  validateConfig: (c) => validateNodeConfig('decision', c),
  async execute(ctx) {
    const cfg = ctx.node.config as DecisionConfig;
    const rules = cfg.rules ?? [];
    const evaluated: { route: string; matched: boolean }[] = [];
    let selected: string | null = null;

    for (const rule of rules) {
      const matched = evaluateCondition(rule.condition, ctx.scope); // throws on invalid/missing ref
      evaluated.push({ route: rule.route, matched });
      if (matched) {
        selected = rule.route;
        break; // first match wins (exclusive routing)
      }
    }

    if (selected === null) {
      if (cfg.defaultRoute) selected = cfg.defaultRoute;
      else throw new NodeExecError('decision_no_route', 'No decision rule matched and no default route is configured.');
    }

    return { output: { text: selected, data: { selectedRoute: selected, evaluated } } };
  },
};
