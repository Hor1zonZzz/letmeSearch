import { describe, expect, it, vi } from "vitest";
import {
	classifyTopicPosts,
	resolveTopicCandidate,
} from "../../src/news/topic-classifier";
import type { NewsTopic, PostForTriage, TopicCandidate } from "../../src/news/types";

function post(): PostForTriage {
	return {
		id: "post-1",
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
			return modelResponse({
				analyses: [{
					postId: "post-1",
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
			decision: "important",
			isImportant: true,
			organizationIds: ["anthropic"],
			topicCandidate: candidate,
		});
	});

	it("rejects ignored posts that return a topic", async () => {
		await expect(classifyTopicPosts([post()], async () => modelResponse({
			analyses: [{
				postId: "post-1",
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

	it("selects only a supplied active topic ID", async () => {
		const activeTopic: NewsTopic = {
			id: "topic-1",
			...candidate,
			status: "active",
			revision: 0,
			organizationIds: ["anthropic"],
			firstSeenAt: "2026-07-21T10:00:00.000Z",
			lastUpdatedAt: "2026-07-22T09:00:00.000Z",
		};
		const request = vi.fn(async () => modelResponse({
			existingTopicId: "topic-1",
			createNew: false,
			reason: "Same product update",
		}));

		const result = await resolveTopicCandidate({
			candidate,
			organizationIds: ["anthropic"],
			activeTopics: [activeTopic],
			request,
		});

		expect(result).toBe("topic-1");
		expect(request).toHaveBeenCalledOnce();
	});
});
