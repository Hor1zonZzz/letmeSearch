import { afterEach, describe, expect, it, vi } from "vitest";
import { NewsDatabase } from "../../src/news/database";
import { normalizeTwitterApiTweet } from "../../src/news/normalizer";
import type { PostTopicAnalysis } from "../../src/news/types";
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

function analysis(
	postId: string,
	decision: "important" | "observe",
): PostTopicAnalysis {
	return {
		postId,
		decision,
		isImportant: decision === "important",
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

	it("queues important and observed posts without resolving Topics", async () => {
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
		const classifier = vi.fn(async () => [
			analysis(first.id, "important"),
			analysis(second.id, "observe"),
		]);
		const stats = await runTopicPipeline({
			database,
			classifier,
			now: () => new Date("2026-07-22T11:00:00.000Z"),
		});

		expect(stats).toMatchObject({
			postsAttempted: 2,
			postsAnalyzed: 2,
			importantPosts: 1,
			observedPosts: 1,
			postsQueuedForResolution: 2,
			topicsCreated: 0,
			postsAttachedToTopics: 0,
			errors: [],
		});
		expect(database.listActiveTopics("2026-07-15T00:00:00.000Z")).toEqual([]);
		expect(database.listPendingTopicResolutions(
			10,
			1,
			"2026-07-22T11:00:00.000Z",
		)).toHaveLength(2);
		expect(database.listPostsForTopicAnalysis()).toEqual([]);
		expect(classifier).toHaveBeenCalledOnce();
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
		database.commitPostTopicAnalysis({
			analysis: {
				...analysis(oldPost.id, "important"),
				organizationIds: ["anthropic"],
			},
			analysisVersion: 1,
			existingTopicId: null,
			now: "2026-07-22T11:00:00.000Z",
		});

		expect(database.listActiveTopics("2026-07-19T11:00:00.000Z")).toEqual([]);
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
