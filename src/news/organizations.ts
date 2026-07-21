export const ORGANIZATIONS = [
	{
		id: "openai",
		nameZh: "OpenAI",
		nameEn: "OpenAI",
		aliases: ["ChatGPT", "GPT", "Codex", "Sora"],
	},
	{
		id: "anthropic",
		nameZh: "Anthropic",
		nameEn: "Anthropic",
		aliases: ["Claude", "Claude Code"],
	},
	{
		id: "xai",
		nameZh: "xAI",
		nameEn: "xAI",
		aliases: ["SpaceXAI", "Grok"],
	},
	{
		id: "spacex",
		nameZh: "SpaceX",
		nameEn: "SpaceX",
		aliases: ["Starship", "Starlink"],
	},
	{
		id: "google-deepmind",
		nameZh: "Google DeepMind",
		nameEn: "Google DeepMind",
		aliases: ["Google AI", "Gemini", "AlphaFold"],
	},
	{
		id: "alibaba",
		nameZh: "阿里巴巴",
		nameEn: "Alibaba",
		aliases: ["通义", "通义千问", "Tongyi", "Qwen"],
	},
	{
		id: "moonshot-ai",
		nameZh: "月之暗面",
		nameEn: "Moonshot AI",
		aliases: ["Kimi", "Kimi.ai"],
	},
	{
		id: "zhipu-ai",
		nameZh: "智谱 AI",
		nameEn: "Zhipu AI",
		aliases: ["Z.ai", "GLM"],
	},
	{
		id: "tencent",
		nameZh: "腾讯",
		nameEn: "Tencent",
		aliases: ["混元", "Hunyuan", "元宝"],
	},
	{
		id: "nvidia",
		nameZh: "英伟达",
		nameEn: "NVIDIA",
		aliases: ["CUDA", "Blackwell", "DGX"],
	},
	{
		id: "meta",
		nameZh: "Meta",
		nameEn: "Meta",
		aliases: ["Llama", "Meta AI"],
	},
	{
		id: "microsoft",
		nameZh: "微软",
		nameEn: "Microsoft",
		aliases: ["Azure AI", "Microsoft Copilot"],
	},
	{
		id: "amazon",
		nameZh: "亚马逊",
		nameEn: "Amazon / AWS",
		aliases: ["AWS", "Bedrock", "Nova"],
	},
	{
		id: "baidu",
		nameZh: "百度",
		nameEn: "Baidu",
		aliases: ["文心", "ERNIE"],
	},
	{
		id: "bytedance",
		nameZh: "字节跳动",
		nameEn: "ByteDance",
		aliases: ["豆包", "Doubao", "Seed"],
	},
	{
		id: "huawei",
		nameZh: "华为",
		nameEn: "Huawei",
		aliases: ["盘古", "Pangu", "昇腾", "Ascend"],
	},
	{
		id: "deepseek",
		nameZh: "DeepSeek",
		nameEn: "DeepSeek",
		aliases: ["深度求索"],
	},
	{
		id: "minimax",
		nameZh: "MiniMax",
		nameEn: "MiniMax",
		aliases: ["海螺", "Hailuo"],
	},
	{
		id: "mistral",
		nameZh: "Mistral AI",
		nameEn: "Mistral AI",
		aliases: ["Le Chat"],
	},
	{
		id: "cursor",
		nameZh: "Cursor",
		nameEn: "Anysphere / Cursor",
		aliases: ["Anysphere"],
	},
	{
		id: "thinking-machines",
		nameZh: "Thinking Machines Lab",
		nameEn: "Thinking Machines Lab",
		aliases: ["Thinking Machines", "TML"],
	},
] as const;

export type OrganizationId = (typeof ORGANIZATIONS)[number]["id"];

export const ORGANIZATION_IDS = ORGANIZATIONS.map(({ id }) => id) as [
	OrganizationId,
	...OrganizationId[],
];
