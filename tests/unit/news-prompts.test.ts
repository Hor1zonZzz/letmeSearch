import { describe, expect, it } from "vitest";
import { classificationPrompt } from "../../src/news/prompts";
import type { PostForAnalysis } from "../../src/news/types";

describe("news prompts", () => {
	it("provides authoritative account identity instead of asking the model to guess it", () => {
		const post: PostForAnalysis = {
			id: "post-1",
			xPostId: "x-1",
			accountId: "account-1",
			eventId: null,
			postType: "original",
			content: "We're partnering with Isomorphic Labs.",
			publishedAt: "2026-07-16T11:44:52.000Z",
			observedAt: "2026-07-16T11:45:00.000Z",
			tweetUrl: "https://x.com/GoogleDeepMind/status/x-1",
			quotedXPostId: null,
			quotedPost: null,
			processingStatus: "pending",
			accountHandle: "GoogleDeepMind",
			accountOrganization: "Google DeepMind",
		};

		const prompt = classificationPrompt([post]);

		expect(prompt).toContain('"officialHandle":"GoogleDeepMind"');
		expect(prompt).toContain('"officialOrganization":"Google DeepMind"');
		expect(prompt).toContain("never guess the publisher");
		expect(prompt).toContain('{"analyses":[');
		expect(prompt).toContain("Do not wrap the JSON in Markdown");
		expect(prompt).toContain("Judge each post independently");
		expect(prompt).toContain(
			"Never use another post in this batch to add facts",
		);
	});
});
