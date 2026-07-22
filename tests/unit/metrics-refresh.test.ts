import { afterEach, describe, expect, it } from "vitest";
import { NewsDatabase } from "../../src/news/database";
import { runMetricsRefresh } from "../../src/news/metrics-refresh";
import { normalizeTwitterApiTweet } from "../../src/news/normalizer";
import { ORGANIZATIONS } from "../../src/news/organizations";
import type { PostTopicAnalysis } from "../../src/news/types";

function rawTweet(id: string, createdAt: string): Record<string, unknown> {
	return {
		id,
		text: `AI release ${id}`,
		createdAt,
		twitterUrl: `https://x.com/OpenAI/status/${id}`,
		isReply: false,
		quoted_tweet: null,
		retweeted_tweet: null,
		article: null,
		author: {
			id: "openai-id",
			userName: "OpenAI",
			name: "OpenAI",
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
		organizationIds: ["openai"],
		unknownOrganizationCandidates: [],
		topicCandidate: {
			titleZh: "OpenAI 发布测试模型",
			titleEn: "OpenAI Releases a Test Model",
			summaryZh: "用于指标测试的模型发布。",
			summaryEn: "A model release used for metric tests.",
			type: "model_release",
		},
		reason: "Important release",
		confidence: 0.8,
	};
}

function commitTopic(
	database: NewsDatabase,
	analyses: PostTopicAnalysis[],
	now: string,
) {
	for (const item of analyses) {
		database.savePostTopicAnalysis(item, 1, now);
		database.queuePostTopicResolution(item.postId, 2, now);
	}
	const topic = analyses[0]?.topicCandidate;
	if (!topic) throw new Error("Expected Topic candidate");
	return database.commitTopicBatch({
		postIds: analyses.map(({ postId }) => postId),
		decision: "create",
		targetTopicId: null,
		expectedTopicRevision: null,
		topic,
		searchTrace: { searches: [] },
		modelRunId: "metric-test",
		resolutionVersion: 2,
		now,
	});
}

describe("metrics refresh", () => {
	const databases: NewsDatabase[] = [];
	afterEach(() => {
		for (const database of databases.splice(0)) database.close();
	});

	it("ranks an important Topic after effective views pass one million", async () => {
		const database = new NewsDatabase(":memory:");
		databases.push(database);
		database.seedAccounts([{ handle: "OpenAI", organization: "OpenAI" }]);
		database.seedOrganizations(ORGANIZATIONS);
		const [account] = database.listEnabledAccounts();
		if (!account) throw new Error("Expected account");
		const first = database.upsertPost(
			account.id,
			normalizeTwitterApiTweet(
				rawTweet("metric-1", "Mon Jul 20 00:00:00 +0000 2026"),
			),
		).post;
		const second = database.upsertPost(
			account.id,
			normalizeTwitterApiTweet(
				rawTweet("metric-2", "Mon Jul 20 00:00:00 +0000 2026"),
			),
		).post;
		const created = commitTopic(
			database,
			[analysis(first.id), analysis(second.id)],
			"2026-07-20T01:00:00.000Z",
		);
		let refresh = 0;
		const client = {
			async fetchTweetMetrics() {
				refresh += 1;
				return refresh === 1
					? [
							{
								xPostId: "metric-1",
								views: 800_000,
								likes: 100,
								reposts: 10,
								replies: 5,
								quotes: 2,
							},
							{
								xPostId: "metric-2",
								views: 100_000,
								likes: 50,
								reposts: 5,
								replies: 2,
								quotes: 1,
							},
						]
					: [
							{
								xPostId: "metric-1",
								views: 1_000_000,
								likes: 150,
								reposts: 15,
								replies: 8,
								quotes: 3,
							},
							{
								xPostId: "metric-2",
								views: 200_000,
								likes: 80,
								reposts: 8,
								replies: 4,
								quotes: 2,
							},
						];
			},
		};

		const initial = await runMetricsRefresh({
			database,
			client,
			now: () => new Date("2026-07-20T06:00:00.000Z"),
		});
		const ranked = await runMetricsRefresh({
			database,
			client,
			now: () => new Date("2026-07-20T10:00:00.000Z"),
		});
		await runMetricsRefresh({
			database,
			client,
			now: () => new Date("2026-07-20T14:00:00.000Z"),
		});
		const stopped = await runMetricsRefresh({
			database,
			client,
			now: () => new Date("2026-07-20T18:00:00.000Z"),
		});

		expect(initial).toMatchObject({
			snapshotsSaved: 2,
			topics: [
				{
					topicId: created.topicId,
					effectiveViews: 830_000,
					state: "tracking",
					rank: null,
				},
			],
		});
		expect(ranked).toMatchObject({
			snapshotsSaved: 2,
			topics: [
				{
					topicId: created.topicId,
					effectiveViews: 1_060_000,
					velocityPerHour: 57_500,
					heat: 1,
					state: "ranked",
					rank: 1,
				},
			],
			hotTopics: [
				{
					topicId: created.topicId,
					titleZh: "OpenAI 发布测试模型",
					rank: 1,
				},
			],
		});
		expect(stopped).toMatchObject({
			stoppedTopics: 1,
			topics: [{ topicId: created.topicId, state: "stopped", rank: null }],
		});
	});

	it("waits until every post is older than 72 hours before stopping for age", async () => {
		const database = new NewsDatabase(":memory:");
		databases.push(database);
		database.seedAccounts([{ handle: "OpenAI", organization: "OpenAI" }]);
		database.seedOrganizations(ORGANIZATIONS);
		const [account] = database.listEnabledAccounts();
		if (!account) throw new Error("Expected account");
		const oldPost = database.upsertPost(
			account.id,
			normalizeTwitterApiTweet(
				rawTweet("old", "Wed Jul 15 00:00:00 +0000 2026"),
			),
		).post;
		const recentPost = database.upsertPost(
			account.id,
			normalizeTwitterApiTweet(
				rawTweet("recent", "Mon Jul 20 00:00:00 +0000 2026"),
			),
		).post;
		commitTopic(
			database,
			[analysis(oldPost.id), analysis(recentPost.id)],
			"2026-07-20T01:00:00.000Z",
		);
		const client = {
			async fetchTweetMetrics() {
				return [
					{
						xPostId: "old",
						views: 100_000,
						likes: 1,
						reposts: 1,
						replies: 1,
						quotes: 1,
					},
					{
						xPostId: "recent",
						views: 100_000,
						likes: 1,
						reposts: 1,
						replies: 1,
						quotes: 1,
					},
				];
			},
		};

		const whileRecent = await runMetricsRefresh({
			database,
			client,
			now: () => new Date("2026-07-21T00:00:00.000Z"),
		});
		const expired = await runMetricsRefresh({
			database,
			client,
			now: () => new Date("2026-07-24T01:00:00.000Z"),
		});

		expect(whileRecent.topics[0]?.state).toBe("tracking");
		expect(expired.topics[0]?.state).toBe("stopped");
	});

	it("removes a ranked topic after two consecutive heat scores below 0.35", async () => {
		const database = new NewsDatabase(":memory:");
		databases.push(database);
		database.seedAccounts([{ handle: "OpenAI", organization: "OpenAI" }]);
		database.seedOrganizations(ORGANIZATIONS);
		const [account] = database.listEnabledAccounts();
		if (!account) throw new Error("Expected account");
		const weakPost = database.upsertPost(
			account.id,
			normalizeTwitterApiTweet(
				rawTweet("weak", "Mon Jul 20 00:00:00 +0000 2026"),
			),
		).post;
		const leaderPost = database.upsertPost(
			account.id,
			normalizeTwitterApiTweet(
				rawTweet("leader", "Mon Jul 20 00:00:00 +0000 2026"),
			),
		).post;
		const weakTopic = commitTopic(
			database,
			[analysis(weakPost.id)],
			"2026-07-20T01:00:00.000Z",
		).topicId;
		const leaderTopic = commitTopic(
			database,
			[{
				...analysis(leaderPost.id),
				topicCandidate: {
					...analysis(leaderPost.id).topicCandidate!,
					titleZh: "另一个领先 Topic",
					titleEn: "Another Leading Topic",
				},
			}],
			"2026-07-20T01:00:00.000Z",
		).topicId;
		let refresh = 0;
		const client = {
			async fetchTweetMetrics() {
				refresh += 1;
				const values = [
					[1_100_000, 2_000_000],
					[1_170_000, 4_000_000],
					[1_250_000, 8_000_000],
				][refresh - 1];
				if (!values) throw new Error("Unexpected refresh");
				return [
					{
						xPostId: "weak",
						views: values[0]!,
						likes: 1,
						reposts: 1,
						replies: 1,
						quotes: 1,
					},
					{
						xPostId: "leader",
						views: values[1]!,
						likes: 1,
						reposts: 1,
						replies: 1,
						quotes: 1,
					},
				];
			},
		};

		await runMetricsRefresh({
			database,
			client,
			now: () => new Date("2026-07-20T06:00:00.000Z"),
		});
		const cooling = await runMetricsRefresh({
			database,
			client,
			now: () => new Date("2026-07-20T10:00:00.000Z"),
		});
		const unranked = await runMetricsRefresh({
			database,
			client,
			now: () => new Date("2026-07-20T14:00:00.000Z"),
		});

		expect(
			cooling.topics.find(({ topicId }) => topicId === weakTopic),
		).toMatchObject({
			state: "cooling",
			rank: 2,
			heat: 0,
		});
		expect(
			unranked.topics.find(({ topicId }) => topicId === weakTopic),
		).toMatchObject({
			state: "unranked",
			rank: null,
			heat: 0,
		});
		expect(
			unranked.topics.find(({ topicId }) => topicId === leaderTopic)?.rank,
		).toBe(1);
	});
});
