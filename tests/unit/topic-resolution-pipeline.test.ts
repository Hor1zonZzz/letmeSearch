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
		author: { id: "claude", userName: "claudeai", name: "Claude", followers: 1 },
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
			{ id: "anthropic", nameZh: "Anthropic", nameEn: "Anthropic", aliases: [] },
		]);
		const [account] = database.listEnabledAccounts();
		if (!account) throw new Error("Expected account");
		for (const [id, hour] of [["x-1", "09"], ["x-2", "10"]] as const) {
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
			requester: async ({ pending, search }) => {
				attemptedIds.push(pending.xPostId);
				const result = await search.tool.run({
					input: {
						focus: null,
						strategy: "balanced",
						detail: "compact",
						limit: 8,
						cursor: null,
					},
					signal: undefined,
				});
				const [match] = result.matches;
				return match
					? {
							result: {
								decision: "attach" as const,
								topicId: match.topicId,
								expectedRevision: match.revision,
								searchId: result.searchId,
								confidence: 0.95,
								reason: "Same event",
							},
							modelRunId: "test-run",
						}
					: {
							result: {
								decision: "create" as const,
								successfulSearchIds: [result.searchId],
								confidence: 0.95,
								reason: "No existing event",
							},
							modelRunId: "test-run",
						};
			},
		});

		expect(stats).toMatchObject({
			postsAttempted: 2,
			postsResolved: 2,
			topicsCreated: 1,
			postsAttachedToTopics: 2,
			postsDeferred: 0,
			postsFailed: 0,
		});
		expect(attemptedIds).toEqual(["x-2", "x-1"]);
		expect(database.listActiveTopics("2026-07-19T00:00:00.000Z")).toEqual([
			expect.objectContaining({ revision: 1 }),
		]);
	});

});
