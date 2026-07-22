import { describe, expect, it, vi } from "vitest";
import { classifyTopicPosts } from "../../src/news/topic-classifier";
import type { PostForTriage, TopicCandidate } from "../../src/news/types";

function post(): PostForTriage {
	return {
		id: "7b559db5-500b-4bef-a55a-ae80fe8f58cd",
		xPostId: "x-1",
		accountId: "account-1",
		eventId: null,
		postType: "original",
		content: "Claude Code adds dynamic workflows",
		publishedAt: "2026-07-22T10:00:00.000Z",
		observedAt: "2026-07-22T10:01:00.000Z",
		tweetUrl: "https://x.com/claudeai/status/x-1",
		quotedXPostId: null,
		quotedPost: null,
		processingStatus: "pending",
		accountHandle: "claudeai",
		accountDisplayName: "Claude",
		rawPayload: {},
		articleTitle: "Dynamic workflows",
		articlePreview: "Claude can build a harness",
		articleText: "Complete article body",
	};
}

const candidate: TopicCandidate = {
	titleZh: "Claude Code 新增动态工作流",
	titleEn: "Claude Code adds dynamic workflows",
	summaryZh: "Claude Code 可以动态构建任务工作流。",
	summaryEn: "Claude Code can dynamically build task workflows.",
	type: "product_update",
};

function modelResponse(value: unknown) {
	return { content: JSON.stringify(value), finishReason: "stop" };
}

describe("topic classifier", () => {
	it("returns a derived important flag and sends the complete article", async () => {
		const request = vi.fn(async (prompt: string) => {
			expect(prompt).toContain("Complete article body");
			expect(prompt).toContain('"postRef":"p1"');
			expect(prompt).not.toContain("7b559db5-500b-4bef-a55a-ae80fe8f58cd");
			return modelResponse({
				analyses: [{
					postRef: "p1",
					decision: "important",
					domain: "ai_technology",
					organizationIds: ["anthropic", "anthropic"],
					unknownOrganizationCandidates: [],
					topicCandidate: candidate,
					reason: "Concrete product update",
					confidence: 0.95,
				}],
			});
		});

		const [analysis] = await classifyTopicPosts([post()], request);

		expect(analysis).toMatchObject({
			postId: "7b559db5-500b-4bef-a55a-ae80fe8f58cd",
			decision: "important",
			isImportant: true,
			organizationIds: ["anthropic"],
			topicCandidate: candidate,
		});
	});

	it("rejects ignored posts that return a topic", async () => {
		await expect(classifyTopicPosts([post()], async () => modelResponse({
			analyses: [{
				postRef: "p1",
				decision: "ignore",
				domain: "other",
				organizationIds: [],
				unknownOrganizationCandidates: [],
				topicCandidate: candidate,
				reason: "Ignore",
				confidence: 0.8,
			}],
		}))).rejects.toThrow("Ignored post");
	});

});
