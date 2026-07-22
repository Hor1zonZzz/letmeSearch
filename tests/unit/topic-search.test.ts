import { afterEach, describe, expect, it } from "vitest";
import { NewsDatabase } from "../../src/news/database";
import { normalizeTwitterApiTweet } from "../../src/news/normalizer";
import { searchActiveTopics, type TopicSearchSubject } from "../../src/news/topic-search";
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

		const recentOnly = searchActiveTopics({
			database,
			subject,
			activeSince: "2026-07-03T00:00:00.000Z",
			input: { focus: null, strategy: "organization", detail: "compact", limit: 2 },
		});
		expect(recentOnly.from).toBe("2026-07-03T00:00:00.000Z");
		expect(recentOnly.matches).toEqual([]);

		const focusedResult = searchActiveTopics({
			database,
			subject,
			input: { focus: null, strategy: "subject", detail: "compact", limit: 1 },
		});
		expect(focusedResult).toMatchObject({
			eligibleTopicCount: 1,
			truncated: false,
		});
		expect(focusedResult.matches[0]?.titleEn).toBe(
			"Microsoft OpenAI Security Program",
		);

		const quotedResult = searchActiveTopics({
			database,
			subject: {
				...subject,
				titleZh: "完全不同的转述",
				titleEn: "A completely different paraphrase",
				summaryZh: "引用来源帖。",
				summaryEn: "Quotes the source post.",
				organizationIds: [],
				strongReferences: ["x_post:matching"],
			},
			input: {
				focus: null,
				strategy: "strong_reference",
				detail: "compact",
				limit: 2,
			},
		});
		expect(quotedResult.matches[0]).toMatchObject({
			titleEn: "Microsoft OpenAI Security Program",
			strongReferenceMatches: ["x_post:matching"],
		});
	});

});
