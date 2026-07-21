import { afterEach, describe, expect, it, vi } from "vitest";
import { NewsDatabase } from "../../src/news/database";
import { normalizeTwitterApiTweet } from "../../src/news/normalizer";
import {
	runTopicBacklog,
	runTopicPipeline,
} from "../../src/news/topic-pipeline";

function rawTweet(id: string, createdAt: string): Record<string, unknown> {
	return {
		id,
		text: `Claude Code update ${id}`,
		createdAt,
		twitterUrl: `https://x.com/claudeai/status/${id}`,
		isReply: false,
		inReplyToId: "",
		quoted_tweet: null,
		retweeted_tweet: null,
		author: {
			id: "claude-id",
			userName: "claudeai",
			name: "Claude",
			followers: 1_000_000,
		},
	};
}

function analysis(postId: string, decision: "important" | "observe") {
	return {
		postId,
		decision,
		domain: "ai_technology",
		organizationIds: ["anthropic"],
		unknownOrganizationCandidates: [],
		topicCandidate: {
			titleZh: "Claude Code 新增动态工作流",
			titleEn: "Claude Code adds dynamic workflows",
			summaryZh: "Claude Code 可以动态构建任务工作流。",
			summaryEn: "Claude Code can dynamically build task workflows.",
			type: "product_update",
		},
		reason: "Product update",
		confidence: 0.95,
	};
}

describe("topic pipeline", () => {
	const databases: NewsDatabase[] = [];

	afterEach(() => {
		for (const database of databases.splice(0)) database.close();
	});

	it("groups important and observed posts into one active topic", async () => {
		const database = new NewsDatabase(":memory:");
		databases.push(database);
		database.seedAccounts([{ handle: "claudeai", organization: "Anthropic" }]);
		const [account] = database.listEnabledAccounts();
		if (!account) throw new Error("Expected account");
		const first = database.upsertPost(
			account.id,
			normalizeTwitterApiTweet(rawTweet("x-1", "Wed Jul 22 09:00:00 +0000 2026")),
		).post;
		const second = database.upsertPost(
			account.id,
			normalizeTwitterApiTweet(rawTweet("x-2", "Wed Jul 22 10:00:00 +0000 2026")),
		).post;
		for (const post of [first, second]) {
			database.savePostArticle({
				postId: post.id,
				status: "not_article",
				title: null,
				previewText: null,
				fullText: null,
				contents: null,
				rawPayload: null,
				fetchedAt: "2026-07-22T10:01:00.000Z",
			});
		}
		const classificationRequest = vi.fn(async () => ({
			content: JSON.stringify({
				analyses: [analysis(first.id, "important"), analysis(second.id, "observe")],
			}),
			finishReason: "stop",
		}));
		const resolutionRequest = vi.fn(async (prompt: string) => {
			const match = prompt.match(/"id":"([^"]+)"/);
			if (!match?.[1]) throw new Error("Expected an active topic ID");
			return {
				content: JSON.stringify({
					existingTopicId: match[1],
					createNew: false,
					reason: "Same Claude Code update",
				}),
				finishReason: "stop",
			};
		});

		const stats = await runTopicPipeline({
			database,
			classificationRequest,
			resolutionRequest,
			now: () => new Date("2026-07-22T11:00:00.000Z"),
		});

		expect(stats).toMatchObject({
			postsAttempted: 2,
			postsAnalyzed: 2,
			importantPosts: 1,
			observedPosts: 1,
			topicsCreated: 1,
			postsAttachedToTopics: 2,
			errors: [],
		});
		expect(database.listActiveTopics("2026-07-15T00:00:00.000Z")).toHaveLength(1);
		expect(database.listPostsForTopicAnalysis()).toEqual([]);
		expect(resolutionRequest).toHaveBeenCalledOnce();
	});

	it("prevents overlapping topic backlog jobs", async () => {
		const database = new NewsDatabase(":memory:");
		databases.push(database);

		const first = runTopicBacklog({ database });
		await expect(runTopicBacklog({ database })).rejects.toThrow(
			"already running",
		);
		await expect(first).resolves.toMatchObject({ postsAttempted: 0 });
	});
});
