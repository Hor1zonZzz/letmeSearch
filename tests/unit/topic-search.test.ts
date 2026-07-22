import { afterEach, describe, expect, it } from "vitest";
import { NewsDatabase } from "../../src/news/database";
import { normalizeTwitterApiTweet } from "../../src/news/normalizer";
import { searchActiveTopics, type TopicSearchSubject } from "../../src/news/topic-search";
import { createSearchActiveTopics } from "../../src/tools/search-active-topics";
import type { PostTopicAnalysis } from "../../src/news/types";

function rawTweet(id: string, createdAt: string, text: string): Record<string, unknown> {
	return {
		id,
		text,
		createdAt,
		twitterUrl: `https://x.com/OpenAI/status/${id}`,
		isReply: false,
		quoted_tweet: null,
		retweeted_tweet: null,
		article: null,
		author: { id: "openai", userName: "OpenAI", name: "OpenAI", followers: 1 },
	};
}

function analysis(
	postId: string,
	organizationIds: string[],
	title: string,
): PostTopicAnalysis {
	return {
		postId,
		decision: "important",
		isImportant: true,
		domain: "ai_technology",
		organizationIds,
		unknownOrganizationCandidates: [],
		topicCandidate: {
			titleZh: title,
			titleEn: title,
			summaryZh: `${title} summary`,
			summaryEn: `${title} summary`,
			type: "partnership",
		},
		reason: "Event",
		confidence: 0.9,
	};
}

describe("active Topic search", () => {
	const databases: NewsDatabase[] = [];
	afterEach(() => {
		for (const database of databases.splice(0)) database.close();
	});

	it("uses the candidate publication time and unions multiple organization sets", () => {
		const database = new NewsDatabase(":memory:");
		databases.push(database);
		database.seedAccounts([{ handle: "OpenAI", organization: "OpenAI" }]);
		database.seedOrganizations([
			{ id: "openai", nameZh: "OpenAI", nameEn: "OpenAI", aliases: [] },
			{ id: "microsoft", nameZh: "微软", nameEn: "Microsoft", aliases: [] },
			{ id: "anthropic", nameZh: "Anthropic", nameEn: "Anthropic", aliases: [] },
		]);
		const [account] = database.listEnabledAccounts();
		if (!account) throw new Error("Expected account");
		const matching = database.upsertPost(
			account.id,
			normalizeTwitterApiTweet(rawTweet(
				"matching",
				"Thu Jul 02 10:00:00 +0000 2026",
				"Microsoft and OpenAI launch the Security Program",
			)),
		).post;
		const unrelated = database.upsertPost(
			account.id,
			normalizeTwitterApiTweet(rawTweet(
				"unrelated",
				"Thu Jul 02 11:00:00 +0000 2026",
				"Anthropic publishes unrelated research",
			)),
		).post;
		database.commitPostTopicAnalysis({
			analysis: analysis(matching.id, ["microsoft"], "Microsoft OpenAI Security Program"),
			analysisVersion: 1,
			existingTopicId: null,
			now: "2026-07-22T10:00:00.000Z",
		});
		database.commitPostTopicAnalysis({
			analysis: analysis(unrelated.id, ["anthropic"], "Anthropic Research"),
			analysisVersion: 1,
			existingTopicId: null,
			now: "2026-07-22T10:00:00.000Z",
		});
		const subject: TopicSearchSubject = {
			postId: "candidate",
			xPostId: "candidate-x",
			publishedAt: "2026-07-01T12:00:00.000Z",
			titleZh: "OpenAI 与微软启动安全计划",
			titleEn: "OpenAI and Microsoft Launch Security Program",
			summaryZh: "OpenAI 与微软合作。",
			summaryEn: "OpenAI and Microsoft partner.",
			type: "partnership",
			organizationIds: ["openai", "microsoft"],
			unknownOrganizationNames: [],
			strongReferences: [],
		};

		const result = searchActiveTopics({
			database,
			subject,
			input: { focus: null, strategy: "organization", detail: "compact", limit: 2 },
		});

		expect(result.from).toBe("2026-06-28T12:00:00.000Z");
		expect(result.matches[0]).toMatchObject({
			titleEn: "Microsoft OpenAI Security Program",
			organizationRelation: "topic_subset",
			overlapOrganizationIds: ["microsoft"],
		});
		expect(result.matches[0]?.sourceTime.nearestDeltaHours).toBe(22);
	});

	it("exposes bounded read-only searches with opaque pagination", async () => {
		const database = new NewsDatabase(":memory:");
		databases.push(database);
		database.seedAccounts([{ handle: "OpenAI", organization: "OpenAI" }]);
		database.seedOrganizations([
			{ id: "openai", nameZh: "OpenAI", nameEn: "OpenAI", aliases: [] },
		]);
		const [account] = database.listEnabledAccounts();
		if (!account) throw new Error("Expected account");
		for (const [id, hour] of [["one", "10"], ["two", "11"]] as const) {
			const post = database.upsertPost(
				account.id,
				normalizeTwitterApiTweet(rawTweet(
					id,
					`Thu Jul 02 ${hour}:00:00 +0000 2026`,
					`OpenAI release ${id}`,
				)),
			).post;
			database.commitPostTopicAnalysis({
				analysis: analysis(post.id, ["openai"], `OpenAI Release ${id}`),
				analysisVersion: 1,
				existingTopicId: null,
				now: "2026-07-22T10:00:00.000Z",
			});
		}
		const session = createSearchActiveTopics({
			database,
			subject: {
				postId: "candidate",
				xPostId: "candidate-x",
				publishedAt: "2026-07-02T12:00:00.000Z",
				titleZh: "OpenAI Release",
				titleEn: "OpenAI Release",
				summaryZh: "OpenAI release",
				summaryEn: "OpenAI release",
				type: "partnership",
				organizationIds: ["openai"],
				unknownOrganizationNames: [],
				strongReferences: [],
			},
		});
		const input = {
			focus: null,
			strategy: "balanced" as const,
			detail: "compact" as const,
			limit: 1,
			cursor: null,
		};

		const first = await session.tool.run({ input, signal: undefined });
		expect(first.matches).toHaveLength(1);
		expect(first.nextCursor).not.toBeNull();
		const second = await session.tool.run({
			input: { ...input, cursor: first.nextCursor },
			signal: undefined,
		});
		expect(second.matches).toHaveLength(1);
		expect(new Set([
			first.matches[0]?.topicId,
			second.matches[0]?.topicId,
		]).size).toBe(2);
		expect(session.trace).toHaveLength(2);
		expect(session.wasTopicReturned(first.matches[0]!.topicId, 0)).toBe(true);
		await expect(session.tool.run({
			input: { ...input, cursor: "forged" },
			signal: undefined,
		})).rejects.toThrow("cursor is invalid");
	});
});
