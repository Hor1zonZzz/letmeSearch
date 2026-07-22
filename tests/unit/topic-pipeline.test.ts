import { afterEach, describe, expect, it, vi } from "vitest";
import { NewsDatabase } from "../../src/news/database";
import { normalizeTwitterApiTweet } from "../../src/news/normalizer";
import type { PostForTriage, PostTopicAnalysis } from "../../src/news/types";
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

function analysis(postId: string): PostTopicAnalysis {
	return {
		postId,
		decision: "important",
		isImportant: true,
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

	it("queues important posts without resolving Topics", async () => {
		const database = new NewsDatabase(":memory:");
		databases.push(database);
		database.seedAccounts([{ handle: "claudeai", organization: "Anthropic" }]);
		const [account] = database.listEnabledAccounts();
		if (!account) throw new Error("Expected account");
		const first = database.upsertPost(
			account.id,
			normalizeTwitterApiTweet(
				rawTweet("x-1", "Wed Jul 22 09:00:00 +0000 2026"),
			),
		).post;
		const second = database.upsertPost(
			account.id,
			normalizeTwitterApiTweet(
				rawTweet("x-2", "Wed Jul 22 10:00:00 +0000 2026"),
			),
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
		const classifier = vi.fn(async (_posts: PostForTriage[]) => [
			analysis(first.id),
			analysis(second.id),
		]);
		const stats = await runTopicPipeline({
			database,
			classifier,
			now: () => new Date("2026-07-22T11:00:00.000Z"),
		});

		expect(stats).toMatchObject({
			postsAttempted: 2,
			postsAnalyzed: 2,
			importantPosts: 2,
			postsQueuedForResolution: 2,
			topicsCreated: 0,
			postsAttachedToTopics: 0,
			errors: [],
		});
		expect(database.listTopicsForSearch("2026-07-15T00:00:00.000Z", "2026-07-23T00:00:00.000Z")).toEqual([]);
		expect(
			database.listPendingTopicResolutions(10, 1, "2026-07-22T11:00:00.000Z"),
		).toHaveLength(2);
		expect(database.listPostsForTopicAnalysis()).toEqual([]);
		expect(classifier).toHaveBeenCalledOnce();
		expect(classifier.mock.calls[0]?.[0].map((post) => post.xPostId)).toEqual([
			"x-2",
			"x-1",
		]);
	});

	it("does not reclassify Posts older than 72 hours", async () => {
		const database = new NewsDatabase(":memory:");
		databases.push(database);
		database.seedAccounts([{ handle: "claudeai", organization: "Anthropic" }]);
		const [account] = database.listEnabledAccounts();
		if (!account) throw new Error("Expected account");
		const oldPost = database.upsertPost(
			account.id,
			normalizeTwitterApiTweet(
				rawTweet("old-classification", "Sat Jul 18 09:00:00 +0000 2026"),
			),
		).post;
		database.savePostArticle({
			postId: oldPost.id,
			status: "not_article",
			title: null,
			previewText: null,
			fullText: null,
			contents: null,
			rawPayload: null,
			fetchedAt: "2026-07-22T10:01:00.000Z",
		});
		const classifier = vi.fn(async () => [analysis(oldPost.id)]);

		const stats = await runTopicPipeline({
			database,
			classifier,
			now: () => new Date("2026-07-22T11:00:00.000Z"),
		});

		expect(stats.postsAttempted).toBe(0);
		expect(classifier).not.toHaveBeenCalled();
		expect(database.listPostsForTopicAnalysis()).toHaveLength(1);
	});

	it("excludes topics whose newest source post is older than 72 hours", () => {
		const database = new NewsDatabase(":memory:");
		databases.push(database);
		database.seedAccounts([{ handle: "claudeai", organization: "Anthropic" }]);
		database.seedOrganizations([
			{
				id: "anthropic",
				nameZh: "Anthropic",
				nameEn: "Anthropic",
				aliases: [],
			},
		]);
		const [account] = database.listEnabledAccounts();
		if (!account) throw new Error("Expected account");
		const oldPost = database.upsertPost(
			account.id,
			normalizeTwitterApiTweet(
				rawTweet("old", "Wed Jul 01 09:00:00 +0000 2026"),
			),
		).post;
		const item = {
			...analysis(oldPost.id),
			organizationIds: ["anthropic"],
		};
		const now = "2026-07-22T11:00:00.000Z";
		database.savePostTopicAnalysis(item, 1, now);
		database.queuePostTopicResolution(item.postId, 2, now);
		if (!item.topicCandidate) throw new Error("Expected Topic candidate");
		database.commitTopicBatch({
			postIds: [item.postId],
			decision: "create",
			targetTopicId: null,
			expectedTopicRevision: null,
			topic: item.topicCandidate,
			searchTrace: { searches: [] },
			modelRunId: "topic-pipeline-test",
			resolutionVersion: 2,
			now,
		});

		expect(database.listTopicsForSearch("2026-07-19T11:00:00.000Z", "2026-07-23T00:00:00.000Z")).toEqual([]);
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
