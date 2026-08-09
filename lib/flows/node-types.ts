/**
 * Client-safe metadata for each workflow node type: label, category, color,
 * icon key, and — honestly — whether it can execute yet and which phase makes
 * it runnable. The canvas palette and node rendering read this. No DB / server
 * imports so it is safe to bundle to the client.
 *
 * Phase A builds the definition/persistence foundation only: no node executes
 * through the NEW engine yet (that is Phase C+). `executable: false` everywhere
 * is the truth today; each type advertises the phase that will light it up so
 * the UI never pretends an unsupported node works.
 */
import type { NodeType } from '@/lib/flows/schema';

export type NodeCategory = 'io' | 'agent' | 'tool' | 'logic' | 'human' | 'memory' | 'transform' | 'control';

export type NodeTypeMeta = {
  type: NodeType;
  label: string;
  category: NodeCategory;
  /** Distinct hue per category — always paired with an icon + text, never color alone. */
  color: string;
  /** lucide-react icon name; the canvas maps this to the component. */
  icon: string;
  /** True once the engine can run this node type. Phase A: none yet. */
  executable: boolean;
  /** The phase that makes this node runnable (for honest "not yet" messaging). */
  runnablePhase: 'C' | 'D' | 'E' | 'F' | 'later';
  description: string;
};

export const NODE_TYPE_META: Record<NodeType, NodeTypeMeta> = {
  input: {
    type: 'input',
    label: 'Input',
    category: 'io',
    color: '#9aa0a6',
    icon: 'LogIn',
    executable: false,
    runnablePhase: 'C',
    description: 'Provides the initial workflow data (text, JSON, URL, file).',
  },
  agent: {
    type: 'agent',
    label: 'AI Agent',
    category: 'agent',
    color: '#4c8dff',
    icon: 'Bot',
    executable: false,
    runnablePhase: 'C',
    description: 'Runs a configured IGRIS agent on its selected model.',
  },
  tool: {
    type: 'tool',
    label: 'Tool',
    category: 'tool',
    color: '#2fd36f',
    icon: 'Wrench',
    executable: false,
    runnablePhase: 'later',
    description: 'Executes a tool (MCP, HTTP, email, search…) — not an AI agent.',
  },
  decision: {
    type: 'decision',
    label: 'Decision',
    category: 'logic',
    color: '#ff9f45',
    icon: 'GitFork',
    executable: false,
    runnablePhase: 'D',
    description: 'Conditional routing into named branches.',
  },
  approval: {
    type: 'approval',
    label: 'Human Approval',
    category: 'human',
    color: '#ffd23f',
    icon: 'UserCheck',
    executable: false,
    runnablePhase: 'E',
    description: 'Pauses the run until a human approves / rejects.',
  },
  memory: {
    type: 'memory',
    label: 'Memory (G-Brain)',
    category: 'memory',
    color: '#b57bff',
    icon: 'Database',
    executable: false,
    runnablePhase: 'F',
    description: 'Explicitly reads from or writes to G-Brain knowledge.',
  },
  transform: {
    type: 'transform',
    label: 'Transform',
    category: 'transform',
    color: '#3fd0d6',
    icon: 'Shuffle',
    executable: false,
    runnablePhase: 'D',
    description: 'Reshapes workflow data (select / map / merge / format).',
  },
  parallel: {
    type: 'parallel',
    label: 'Parallel',
    category: 'control',
    color: '#8ea0b6',
    icon: 'Split',
    executable: false,
    runnablePhase: 'D',
    description: 'Fans out into parallel branches.',
  },
  join: {
    type: 'join',
    label: 'Join',
    category: 'control',
    color: '#8ea0b6',
    icon: 'Merge',
    executable: false,
    runnablePhase: 'D',
    description: 'Synchronizes parallel branches back together.',
  },
  output: {
    type: 'output',
    label: 'Output',
    category: 'io',
    color: '#9aa0a6',
    icon: 'LogOut',
    executable: false,
    runnablePhase: 'C',
    description: 'The final workflow result (display / save / draft / notify).',
  },
};

export const NODE_TYPE_LIST: NodeTypeMeta[] = Object.values(NODE_TYPE_META);
