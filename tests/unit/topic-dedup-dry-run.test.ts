import { afterEach, describe, expect, it } from "vitest";
import { NewsDatabase } from "../../src/news/database";
import { normalizeTwitterApiTweet } from "../../src/news/normalizer";
import { createTopicDedupDryRun } from "../../src/news/topic-dedup-dry-run";
import type { PostTopicAnalysis } from "../../src/news/types";

function rawTweet(id: string, hour: string): Record<string, unknown> {
	return {
		id,
		text: "OpenAI launches GPT Example preview",
		createdAt: `Wed Jul 22 ${hour}:00:00 +0000 2026`,
		twitterUrl: `https://x.com/OpenAI/status/${id}`,
		isReply: false,
		quoted_tweet: null,
		retweeted_tweet: null,
		article: null,
		author: { id: "openai", userName: "OpenAI", name: "OpenAI", followers: 1 },
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
			titleZh: "OpenAI 发布 GPT Example 预览版",
			titleEn: "OpenAI Launches GPT Example Preview",
			summaryZh: "OpenAI 发布 GPT Example 预览版。",
			summaryEn: "OpenAI launched a GPT Example preview.",
			type: "model_release",
		},
		reason: "Release",
		confidence: 0.9,
	};
}

function commitTopic(database: NewsDatabase, item: PostTopicAnalysis): void {
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
		modelRunId: "topic-dedup-test",
		resolutionVersion: 2,
		now,
	});
}

describe("Topic duplicate dry run", () => {
	const databases: NewsDatabase[] = [];
	afterEach(() => {
		for (const database of databases.splice(0)) database.close();
	});

	it("reports likely duplicate pairs without changing membership", () => {
		const database = new NewsDatabase(":memory:");
		databases.push(database);
		database.seedAccounts([{ handle: "OpenAI", organization: "OpenAI" }]);
		database.seedOrganizations([
			{ id: "openai", nameZh: "OpenAI", nameEn: "OpenAI", aliases: [] },
		]);
		const [account] = database.listEnabledAccounts();
		if (!account) throw new Error("Expected account");
		for (const [id, hour] of [["one", "09"], ["two", "10"]] as const) {
			const post = database.upsertPost(
				account.id,
				normalizeTwitterApiTweet(rawTweet(id, hour)),
			).post;
			commitTopic(database, analysis(post.id));
		}
		const before = database.listTopicsForSearch("2026-07-19T00:00:00.000Z", "2026-07-23T00:00:00.000Z");

		const report = createTopicDedupDryRun({
			database,
			now: new Date("2026-07-22T12:00:00.000Z"),
		});

		expect(report.activeTopicsReviewed).toBe(2);
		expect(report.suggestions).toEqual([
			expect.objectContaining({
				type: "model_release",
				overlapOrganizationIds: ["openai"],
			}),
		]);
		expect(database.listTopicsForSearch("2026-07-19T00:00:00.000Z", "2026-07-23T00:00:00.000Z")).toEqual(before);
	});
});
