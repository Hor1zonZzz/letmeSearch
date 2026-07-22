import { createHash } from "node:crypto";
import { defineTool } from "@flue/runtime";
import * as v from "valibot";
import type { NewsDatabase } from "../news/database";
import {
	searchActiveTopics,
	type TopicSearchInput,
	type TopicSearchMatch,
	type TopicSearchSubject,
} from "../news/topic-search";

const searchInputSchema = v.object({
	focus: v.nullable(v.pipe(v.string(), v.maxLength(240))),
	strategy: v.picklist([
		"balanced",
		"organization",
		"subject",
		"strong_reference",
	]),
	detail: v.picklist(["compact", "with_evidence"]),
	limit: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(8)),
	cursor: v.nullable(v.string()),
});

const evidenceSchema = v.object({
	publishedAt: v.string(),
	publisherHandle: v.string(),
	excerpt: v.string(),
});

const matchSchema = v.object({
	topicId: v.string(),
	revision: v.number(),
	titleZh: v.string(),
	titleEn: v.string(),
	summaryZhExcerpt: v.string(),
	summaryEnExcerpt: v.string(),
	type: v.string(),
	organizationIds: v.array(v.string()),
	organizationRelation: v.picklist([
		"exact",
		"candidate_subset",
		"topic_subset",
		"overlap",
		"disjoint",
	]),
	overlapOrganizationIds: v.array(v.string()),
	sourceTime: v.object({
		firstPublishedAt: v.string(),
		lastPublishedAt: v.string(),
		nearestPublishedAt: v.string(),
		nearestDeltaHours: v.number(),
		postCount: v.number(),
	}),
	strongReferenceMatches: v.array(v.string()),
	lexicalScore: v.number(),
	sameType: v.boolean(),
	evidence: v.array(evidenceSchema),
});

const searchOutputSchema = v.object({
	searchId: v.string(),
	policyVersion: v.number(),
	effectiveWindow: v.object({ from: v.string(), to: v.string() }),
	eligibleTopicCount: v.number(),
	truncated: v.boolean(),
	nextCursor: v.nullable(v.string()),
	contextBudgetExhausted: v.boolean(),
	matches: v.array(matchSchema),
});

export type TopicSearchTraceEntry = {
	searchId: string;
	input: TopicSearchInput & { cursor: string | null };
	matches: Array<{ topicId: string; revision: number }>;
	truncated: boolean;
	contextBudgetExhausted: boolean;
};

export type TopicSearchToolSession = {
	tool: ReturnType<typeof defineTool>;
	trace: TopicSearchTraceEntry[];
	wasTopicReturned(topicId: string, revision: number): boolean;
	hadSuccessfulSearch(): boolean;
	wasSearchSuccessful(searchId: string): boolean;
};

function cursorSignature(
	subject: TopicSearchSubject,
	input: TopicSearchInput,
	offset: number,
): string {
	return createHash("sha256").update(JSON.stringify({
		postId: subject.postId,
		publishedAt: subject.publishedAt,
		focus: input.focus,
		strategy: input.strategy,
		detail: input.detail,
		limit: input.limit,
		offset,
	})).digest("hex").slice(0, 16);
}

function encodeCursor(
	subject: TopicSearchSubject,
	input: TopicSearchInput,
	offset: number,
): string {
	return Buffer.from(JSON.stringify({
		offset,
		signature: cursorSignature(subject, input, offset),
	})).toString("base64url");
}

function decodeCursor(
	cursor: string | null,
	subject: TopicSearchSubject,
	input: TopicSearchInput,
): number {
	if (!cursor) return 0;
	try {
		const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
			offset?: unknown;
			signature?: unknown;
		};
		if (!Number.isInteger(parsed.offset) || (parsed.offset as number) < 0) {
			throw new Error("invalid offset");
		}
		const offset = parsed.offset as number;
		if (parsed.signature !== cursorSignature(subject, input, offset)) {
			throw new Error("invalid signature");
		}
		return offset;
	} catch {
		throw new Error("Topic search cursor is invalid for this query");
	}
}

export function createSearchActiveTopics(options: {
	database: NewsDatabase;
	subject: TopicSearchSubject;
	maximumCalls?: number;
	maximumUniqueResults?: number;
}): TopicSearchToolSession {
	const maximumCalls = options.maximumCalls ?? 3;
	const maximumUniqueResults = options.maximumUniqueResults ?? 12;
	const trace: TopicSearchTraceEntry[] = [];
	const seenTopics = new Set<string>();
	const returnedRevisions = new Set<string>();
	const tool = defineTool({
		name: "search_active_topics",
		description: `Search read-only Topic candidates for one bound incoming AI-news event. The application fixes the candidate, organization sets, and publication-time ±72-hour scope. Use balanced search first, refine with subject/organization/strong_reference only when needed, request evidence for ambiguous matches, and never treat shared organizations alone as proof of identity.`,
		input: searchInputSchema,
		output: searchOutputSchema,
		async run({ input }) {
			if (trace.length >= maximumCalls) {
				throw new Error(`Topic search call budget exceeded (${maximumCalls})`);
			}
			const searchInput: TopicSearchInput = {
				focus: input.focus,
				strategy: input.strategy,
				detail: input.detail,
				limit: input.limit,
			};
			const offset = decodeCursor(input.cursor, options.subject, searchInput);
			const result = searchActiveTopics({
				database: options.database,
				subject: options.subject,
				input: searchInput,
				offset,
			});
			const matches: TopicSearchMatch[] = [];
			let contextBudgetExhausted = false;
			for (const match of result.matches) {
				const isNew = !seenTopics.has(match.topicId);
				if (isNew && seenTopics.size >= maximumUniqueResults) {
					contextBudgetExhausted = true;
					continue;
				}
				seenTopics.add(match.topicId);
				returnedRevisions.add(`${match.topicId}:${match.revision}`);
				matches.push(match);
			}
			const nextOffset = offset + result.matches.length;
			const truncated = result.truncated || contextBudgetExhausted;
			const nextCursor = result.truncated && !contextBudgetExhausted
				? encodeCursor(options.subject, searchInput, nextOffset)
				: null;
			trace.push({
				searchId: result.searchId,
				input: { ...searchInput, cursor: input.cursor },
				matches: matches.map(({ topicId, revision }) => ({ topicId, revision })),
				truncated,
				contextBudgetExhausted,
			});
			return {
				searchId: result.searchId,
				policyVersion: 1,
				effectiveWindow: { from: result.from, to: result.to },
				eligibleTopicCount: result.eligibleTopicCount,
				truncated,
				nextCursor,
				contextBudgetExhausted,
				matches,
			};
		},
	});
	return {
		tool,
		trace,
		wasTopicReturned: (topicId, revision) =>
			returnedRevisions.has(`${topicId}:${revision}`),
		hadSuccessfulSearch: () => trace.length > 0,
		wasSearchSuccessful: (searchId) =>
			trace.some((entry) => entry.searchId === searchId),
	};
}
