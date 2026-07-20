export const MONITORED_ACCOUNT_SEEDS = [
	{ handle: 'OpenAI', organization: 'OpenAI' },
	{ handle: 'AnthropicAI', organization: 'Anthropic' },
	{ handle: 'GoogleDeepMind', organization: 'Google DeepMind' },
	{ handle: 'Kimi_Moonshot', organization: 'Kimi / Moonshot AI' },
	{ handle: 'Zai_org', organization: 'Z.ai' },
] as const;

export const DEFAULT_POSTS_PER_ACCOUNT = 5;
export const MAX_POSTS_PER_ACCOUNT = 20;
export const ANALYSIS_VERSION = 1;
