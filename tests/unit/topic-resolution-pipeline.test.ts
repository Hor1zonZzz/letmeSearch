import { afterEach, describe, expect, it } from "vitest";
import { NewsDatabase } from "../../src/news/database";
import { normalizeTwitterApiTweet } from "../../src/news/normalizer";
import { runTopicResolutionBatch } from "../../src/news/topic-resolution-pipeline";
import type { PostTopicAnalysis } from "../../src/news/types";

function rawTweet(id: string, hour: string): Record<string, unknown> {
	return {
		id,
		text: "Anthropic releases Claude Example",
		createdAt: `Wed Jul 22 ${hour}:00:00 +0000 2026`,
		twitterUrl: `https://x.com/claudeai/status/${id}`,
		isReply: false,
		quoted_tweet: null,
		retweeted_tweet: null,
		article: null,
		author: {
			id: "claude",
			userName: "claudeai",
			name: "Claude",
			followers: 1,
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
			titleZh: "Anthropic 发布 Claude Example",
			titleEn: "Anthropic Releases Claude Example",
			summaryZh: "Anthropic 发布测试模型。",
			summaryEn: "Anthropic released a test model.",
			type: "model_release",
		},
		reason: "Model release",
		confidence: 0.95,
	};
}

describe("Topic resolution pipeline", () => {
	const databases: NewsDatabase[] = [];
	afterEach(() => {
		for (const database of databases.splice(0)) database.close();
	});

	it("creates once and attaches the next same-event Post", async () => {
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
		for (const [id, hour] of [
			["x-1", "09"],
			["x-2", "10"],
		] as const) {
			const post = database.upsertPost(
				account.id,
				normalizeTwitterApiTweet(rawTweet(id, hour)),
			).post;
			database.commitPostTopicClassification({
				analysis: analysis(post.id),
				analysisVersion: 1,
				resolutionVersion: 1,
				now: "2026-07-22T11:00:00.000Z",
			});
		}

		const attemptedIds: string[] = [];
		const stats = await runTopicResolutionBatch({
			database,
			now: () => new Date("2026-07-22T12:00:00.000Z"),
			requester: async ({ posts, toolSession }) => {
				attemptedIds.push(...posts.map(({ xPostId }) => xPostId));
				const [search, , create, finish] = toolSession.tools;
				if (!search || !create || !finish)
					throw new Error("Expected Topic tools");
				const postRefs = posts.map(({ postRef }) => postRef);
				await search.run({ input: { posts: postRefs }, signal: undefined });
				await create.run({
					input: {
						posts: postRefs,
						topic: analysis(posts[0]?.postId ?? "").topicCandidate,
					},
					signal: undefined,
				});
				await finish.run({ input: {}, signal: undefined });
				return { completed: true as const };
			},
		});

		expect(stats).toMatchObject({
			accountBatchesAttempted: 1,
			accountBatchesCompleted: 1,
			postsAttempted: 2,
			postsResolved: 2,
			topicsCreated: 1,
			postsAttachedToTopics: 2,
			postsFailed: 0,
		});
		expect(attemptedIds).toEqual(["x-2", "x-1"]);
		expect(database.listTopicsForSearch(
			"2026-07-19T00:00:00.000Z",
			"2026-07-23T00:00:00.000Z",
		)).toEqual([
			expect.objectContaining({ revision: 0 }),
		]);
	});

	it("processes account batches serially and attaches a later account to the first Topic", async () => {
		const database = new NewsDatabase(":memory:");
		databases.push(database);
		database.seedAccounts([
			{ handle: "claudeai", organization: "Anthropic" },
			{ handle: "openai", organization: "OpenAI" },
		]);
		database.seedOrganizations([
			{
				id: "anthropic",
				nameZh: "Anthropic",
				nameEn: "Anthropic",
				aliases: [],
			},
		]);
		const accounts = database.listEnabledAccounts();
		for (const [index, account] of accounts.entries()) {
			const post = database.upsertPost(
				account.id,
				normalizeTwitterApiTweet(
					rawTweet(`account-${index}`, index === 0 ? "09" : "10"),
				),
			).post;
			database.commitPostTopicClassification({
				analysis: analysis(post.id),
				analysisVersion: 1,
				resolutionVersion: 2,
				now: "2026-07-22T11:00:00.000Z",
			});
		}

		const accountOrder: string[] = [];
		const stats = await runTopicResolutionBatch({
			database,
			now: () => new Date("2026-07-22T12:00:00.000Z"),
			requester: async ({ accountHandle, posts, toolSession }) => {
				accountOrder.push(accountHandle);
				const [search, add, create, finish] = toolSession.tools;
				if (!search || !add || !create || !finish)
					throw new Error("Expected Topic tools");
				const postRefs = posts.map(({ postRef }) => postRef);
				const result = await search.run({
					input: { posts: postRefs },
					signal: undefined,
				});
				const [match] = result.topics;
				if (match) {
					await add.run({
						input: { posts: postRefs, topic: match.topic },
						signal: undefined,
					});
				} else {
					const topic = analysis(posts[0]?.postId ?? "").topicCandidate;
					if (!topic) throw new Error("Expected Topic candidate");
					await create.run({
						input: { posts: postRefs, topic },
						signal: undefined,
					});
				}
				await finish.run({ input: {}, signal: undefined });
				return { completed: true as const };
			},
		});

		expect(accountOrder).toHaveLength(2);
		expect(stats).toMatchObject({
			accountBatchesAttempted: 2,
			accountBatchesCompleted: 2,
			postsResolved: 2,
			topicsCreated: 1,
			postsAttachedToTopics: 2,
		});
		const topics = database.listTopicsForSearch(
			"2026-07-19T00:00:00.000Z",
			"2026-07-23T00:00:00.000Z",
		);
		expect(topics).toHaveLength(1);
		expect(topics[0]).toMatchObject({ revision: 1 });
		expect(topics[0]?.sourcePosts).toHaveLength(2);
	});

	it("does not resolve important Posts older than 72 hours", async () => {
		const database = new NewsDatabase(":memory:");
		databases.push(database);
		database.seedAccounts([{ handle: "claudeai", organization: "Anthropic" }]);
		const [account] = database.listEnabledAccounts();
		if (!account) throw new Error("Expected account");
		const post = database.upsertPost(
			account.id,
			normalizeTwitterApiTweet({
				...rawTweet("old-resolution", "10"),
				createdAt: "Sat Jul 18 10:00:00 +0000 2026",
			}),
		).post;
		database.commitPostTopicClassification({
			analysis: analysis(post.id),
			analysisVersion: 1,
			resolutionVersion: 2,
			now: "2026-07-22T11:00:00.000Z",
		});
		let called = false;

		const stats = await runTopicResolutionBatch({
			database,
			now: () => new Date("2026-07-22T12:00:00.000Z"),
			requester: async () => {
				called = true;
				return { completed: true as const };
			},
		});

		expect(stats.postsAttempted).toBe(0);
		expect(called).toBe(false);
	});

	it("keeps completed groups when a later group fails", async () => {
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
		for (const [id, hour] of [
			["partial-1", "08"],
			["partial-2", "09"],
			["partial-3", "10"],
		] as const) {
			const post = database.upsertPost(
				account.id,
				normalizeTwitterApiTweet(rawTweet(id, hour)),
			).post;
			database.commitPostTopicClassification({
				analysis: analysis(post.id),
				analysisVersion: 1,
				resolutionVersion: 2,
				now: "2026-07-22T11:00:00.000Z",
			});
		}

		const stats = await runTopicResolutionBatch({
			database,
			now: () => new Date("2026-07-22T12:00:00.000Z"),
			requester: async ({ posts, toolSession }) => {
				const [search, , create] = toolSession.tools;
				if (!search || !create) throw new Error("Expected Topic tools");
				const completed = posts.slice(0, 2).map(({ postRef }) => postRef);
				await search.run({ input: { posts: completed }, signal: undefined });
				const topic = analysis(posts[0]?.postId ?? "").topicCandidate;
				if (!topic) throw new Error("Expected Topic candidate");
				await create.run({
					input: { posts: completed, topic },
					signal: undefined,
				});
				throw new Error("search service failed");
			},
		});

		expect(stats).toMatchObject({
			postsAttempted: 3,
			postsResolved: 2,
			postsFailed: 1,
			topicsCreated: 1,
		});
		const topics = database.listTopicsForSearch(
			"2026-07-19T00:00:00.000Z",
			"2026-07-23T00:00:00.000Z",
		);
		expect(topics[0]?.sourcePosts).toHaveLength(2);
		expect(
			database.listPendingTopicResolutions(10, 2, "2026-07-22T12:09:59.000Z"),
		).toHaveLength(0);
		expect(
			database.listPendingTopicResolutions(10, 2, "2026-07-22T12:10:00.000Z"),
		).toHaveLength(1);
	});
});
