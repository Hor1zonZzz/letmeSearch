export const MONITORED_ACCOUNT_SEEDS = [
	{ handle: "OpenAI", organization: "OpenAI" },
	{ handle: "AnthropicAI", organization: "Anthropic" },
	{ handle: "claudeai", organization: "Anthropic" },
	{ handle: "GoogleDeepMind", organization: "Google DeepMind" },
	{ handle: "GoogleAIStudio", organization: "Google AI Studio" },
	{ handle: "googleaidevs", organization: "Google AI Developers" },
	{ handle: "OfficialLoganK", organization: "Logan Kilpatrick" },
	{ handle: "Google", organization: "Google" },
	{ handle: "googlegemma", organization: "Google Gemma" },
	{ handle: "Kimi_Moonshot", organization: "Kimi / Moonshot AI" },
	{ handle: "Zai_org", organization: "Z.ai" },
	{ handle: "elonmusk", organization: "Elon Musk" },
	{ handle: "karpathy", organization: "Andrej Karpathy" },
	{ handle: "ilyasut", organization: "Ilya Sutskever" },
	{ handle: "sama", organization: "Sam Altman" },
	{ handle: "SpaceXAI", organization: "SpaceXAI" },
	{ handle: "gdb", organization: "Greg Brockman" },
	{ handle: "thinkymachines", organization: "Thinking Machines Lab" },
	{ handle: "Ali_TongyiLab", organization: "Alibaba Tongyi Lab" },
	{ handle: "Alibaba_Qwen", organization: "Alibaba Qwen" },
	{ handle: "MiniMax_AI", organization: "MiniMax" },
	{ handle: "badlogicgames", organization: "Mario Zechner" },
	{ handle: "ylecun", organization: "Yann LeCun" },
	{ handle: "cursor_ai", organization: "Cursor" },
	{ handle: "nvidia", organization: "NVIDIA" },
	{ handle: "DarioAmodei", organization: "Dario Amodei" },
	{ handle: "trq212", organization: "Thariq Shihipar" },
] as const;

export const DEFAULT_POSTS_PER_ACCOUNT = 5;
export const MAX_POSTS_PER_ACCOUNT = 20;
export const ANALYSIS_VERSION = 1;
export const TOPIC_ANALYSIS_VERSION = 3;
export const TOPIC_RESOLUTION_VERSION = 1;
export const TOPIC_MATCH_WINDOW_HOURS = 72;
