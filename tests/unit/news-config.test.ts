import { describe, expect, it } from "vitest";
import { MONITORED_ACCOUNT_SEEDS } from "../../src/news/config";
import { ORGANIZATIONS } from "../../src/news/organizations";

describe("official news account configuration", () => {
	it("includes the configured AI organizations and industry figures once", () => {
		const handles = MONITORED_ACCOUNT_SEEDS.map(({ handle }) => handle);

		expect(handles).toEqual([
			"OpenAI",
			"AnthropicAI",
			"claudeai",
			"GoogleDeepMind",
			"GoogleAIStudio",
			"OfficialLoganK",
			"Google",
			"googlegemma",
			"Kimi_Moonshot",
			"Zai_org",
			"elonmusk",
			"karpathy",
			"ilyasut",
			"sama",
			"SpaceXAI",
			"gdb",
			"thinkymachines",
			"Ali_TongyiLab",
			"Alibaba_Qwen",
			"MiniMax_AI",
			"badlogicgames",
			"ylecun",
			"cursor_ai",
			"nvidia",
			"DarioAmodei",
			"trq212",
		]);
		expect(new Set(handles.map((handle) => handle.toLowerCase())).size).toBe(
			handles.length,
		);
	});

	it("defines unique canonical organization IDs", () => {
		const ids = ORGANIZATIONS.map(({ id }) => id);

		expect(ids).toContain("openai");
		expect(ids).toContain("anthropic");
		expect(ids).toContain("xai");
		expect(ids).toContain("spacex");
		expect(ids).toContain("alibaba");
		expect(ids).toContain("moonshot-ai");
		expect(ids).toContain("zhipu-ai");
		expect(ids).toContain("tencent");
		expect(new Set(ids).size).toBe(ids.length);
	});
});
