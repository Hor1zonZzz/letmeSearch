import { describe, expect, it } from "vitest";
import { MONITORED_ACCOUNT_SEEDS } from "../../src/news/config";

describe("official news account configuration", () => {
	it("includes the configured AI organizations and industry figures once", () => {
		const handles = MONITORED_ACCOUNT_SEEDS.map(({ handle }) => handle);

		expect(handles).toEqual([
			"OpenAI",
			"AnthropicAI",
			"claudeai",
			"GoogleDeepMind",
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
			"cursor_ai",
			"nvidia",
			"DarioAmodei",
			"trq212",
		]);
		expect(new Set(handles.map((handle) => handle.toLowerCase())).size).toBe(
			handles.length,
		);
	});
});
