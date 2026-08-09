/**
 * Model-provider catalog. Each provider is reachable over the OpenAI-compatible
 * `/chat/completions` shape with a Bearer API key, so one small client
 * (lib/connectors/openai-compatible.ts) drives all of them. Keys are stored in
 * .env.local (gitignored) via the Models board; the `models` lists are a
 * curated starting point — any model id can be typed, and `POST /api/models`
 * `action:"test"` fetches the provider's live `/models` list to confirm.
 *
 * An agent selects a model as the string `providerId:modelId` (e.g.
 * `openai:gpt-4o`). See lib/models/resolve.ts.
 */
export type ModelProvider = {
  id: string;
  name: string;
  envKey: string;
  baseUrl: string;
  docsUrl: string;
  models: string[];
  /** Whether an API key is required (default true; Ollama/custom may be false). */
  requiresKey?: boolean;
  /** Local runtime (e.g. Ollama) — shown separately from cloud in the UI. */
  local?: boolean;
  /** The base URL may be overridden per connection (local + custom endpoints). */
  allowBaseUrl?: boolean;
};

export const MODEL_PROVIDERS: ModelProvider[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com/v1',
    docsUrl: 'https://platform.openai.com/api-keys',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o3', 'o3-mini', 'o4-mini'],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    baseUrl: 'https://api.anthropic.com/v1',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    models: ['claude-sonnet-4', 'claude-opus-4', 'claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest'],
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    envKey: 'XAI_API_KEY',
    baseUrl: 'https://api.x.ai/v1',
    docsUrl: 'https://console.x.ai',
    models: ['grok-4', 'grok-3', 'grok-3-mini', 'grok-2-latest'],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    envKey: 'DEEPSEEK_API_KEY',
    baseUrl: 'https://api.deepseek.com/v1',
    docsUrl: 'https://platform.deepseek.com/api_keys',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'groq',
    name: 'Groq',
    envKey: 'GROQ_API_KEY',
    baseUrl: 'https://api.groq.com/openai/v1',
    docsUrl: 'https://console.groq.com/keys',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'qwen-2.5-32b'],
  },
  {
    id: 'mistral',
    name: 'Mistral',
    envKey: 'MISTRAL_API_KEY',
    baseUrl: 'https://api.mistral.ai/v1',
    docsUrl: 'https://console.mistral.ai/api-keys',
    models: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest'],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter (any model)',
    envKey: 'OPENROUTER_API_KEY',
    baseUrl: 'https://openrouter.ai/api/v1',
    docsUrl: 'https://openrouter.ai/keys',
    models: [
      'openai/gpt-4o',
      'anthropic/claude-3.5-sonnet',
      'google/gemini-2.0-flash-001',
      'meta-llama/llama-3.3-70b-instruct',
      'deepseek/deepseek-chat',
    ],
  },
  {
    id: 'together',
    name: 'Together AI',
    envKey: 'TOGETHER_API_KEY',
    baseUrl: 'https://api.together.xyz/v1',
    docsUrl: 'https://api.together.ai/settings/api-keys',
    models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-72B-Instruct-Turbo'],
  },
  {
    id: 'google',
    name: 'Google (Gemini)',
    envKey: 'GOOGLE_API_KEY',
    // Google's official OpenAI-compatible endpoint (not a fake shim).
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    docsUrl: 'https://aistudio.google.com/apikey',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
  },
  {
    id: 'nvidia',
    name: 'NVIDIA',
    envKey: 'NVIDIA_API_KEY',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    docsUrl: 'https://build.nvidia.com',
    models: ['nvidia/llama-3.3-nemotron-super-49b-v1', 'meta/llama-3.3-70b-instruct', 'deepseek-ai/deepseek-r1'],
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    envKey: 'OLLAMA_API_KEY', // usually unused; Ollama needs no key
    baseUrl: 'http://localhost:11434/v1',
    docsUrl: 'https://ollama.com',
    models: [],
    requiresKey: false,
    local: true,
    allowBaseUrl: true,
  },
  {
    id: 'custom',
    name: 'Custom (OpenAI-compatible)',
    envKey: 'CUSTOM_OPENAI_API_KEY',
    baseUrl: '',
    docsUrl: 'https://platform.openai.com/docs/api-reference',
    models: [],
    requiresKey: false,
    allowBaseUrl: true,
  },
];

export function providerById(id: string): ModelProvider | undefined {
  return MODEL_PROVIDERS.find((p) => p.id === id);
}

/** Whether this provider needs an API key (default: yes). */
export function providerRequiresKey(p: ModelProvider): boolean {
  return p.requiresKey !== false;
}
