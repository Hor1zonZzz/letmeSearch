import type { NewsDatabase } from "./database";
import {
	extractStrongReferences,
	searchActiveTopics,
	type TopicSearchSubject,
} from "./topic-search";

export type TopicMergeSuggestion = {
	leftTopicId: string;
	rightTopicId: string;
	leftTitleEn: string;
	rightTitleEn: string;
	type: string;
	overlapOrganizationIds: string[];
	strongReferenceMatches: string[];
	lexicalScore: number;
	nearestDeltaHours: number;
	reasons: string[];
};

export type TopicDedupDryRunReport = {
	generatedAt: string;
	activeTopicsReviewed: number;
	minimumLexicalScore: number;
	suggestions: TopicMergeSuggestion[];
};

export function createTopicDedupDryRun(options: {
	database: NewsDatabase;
	now?: Date;
	minimumLexicalScore?: number;
}): TopicDedupDryRunReport {
	const now = options.now ?? new Date();
	const minimumLexicalScore = options.minimumLexicalScore ?? 0.45;
	const documents = options.database.listTopicsForSearch(
		new Date(0).toISOString(),
		new Date(now.getTime() + 72 * 60 * 60 * 1_000).toISOString(),
	);
	const suggestions: TopicMergeSuggestion[] = [];
	const seenPairs = new Set<string>();
	for (const document of documents) {
		const latestPost = [...document.sourcePosts].sort((left, right) =>
			right.publishedAt.localeCompare(left.publishedAt),
		)[0];
		if (!latestPost) continue;
		const strongReferences = new Set<string>();
		for (const post of document.sourcePosts) {
			for (const reference of extractStrongReferences(post.rawPayload)) {
				strongReferences.add(reference);
			}
		}
		const subject: TopicSearchSubject = {
			postId: `dry-run:${document.id}`,
			xPostId: latestPost.xPostId,
			publishedAt: latestPost.publishedAt,
			titleZh: document.titleZh,
			titleEn: document.titleEn,
			summaryZh: document.summaryZh,
			summaryEn: document.summaryEn,
			type: document.type,
			organizationIds: document.organizationIds,
			unknownOrganizationNames: [],
			strongReferences: [...strongReferences],
		};
		const result = searchActiveTopics({
			database: options.database,
			subject,
			input: {
				focus: null,
				strategy: "balanced",
				detail: "compact",
				limit: 8,
			},
		});
		for (const match of result.matches) {
			if (match.topicId === document.id || !match.sameType) continue;
			const [leftTopicId, rightTopicId] = [document.id, match.topicId].sort();
			const pair = `${leftTopicId}:${rightTopicId}`;
			if (seenPairs.has(pair)) continue;
			const hasActorOverlap = match.overlapOrganizationIds.length > 0;
			const hasStrongReference = match.strongReferenceMatches.length > 0;
			if (!hasStrongReference && (!hasActorOverlap || match.lexicalScore < minimumLexicalScore)) {
				continue;
			}
			seenPairs.add(pair);
			const reasons: string[] = [];
			if (hasStrongReference) reasons.push("shared strong reference");
			if (hasActorOverlap) reasons.push("overlapping organizations");
			if (match.lexicalScore >= minimumLexicalScore) reasons.push("similar bilingual subject");
			suggestions.push({
				leftTopicId,
				rightTopicId,
				leftTitleEn: leftTopicId === document.id ? document.titleEn : match.titleEn,
				rightTitleEn: rightTopicId === match.topicId ? match.titleEn : document.titleEn,
				type: document.type,
				overlapOrganizationIds: match.overlapOrganizationIds,
				strongReferenceMatches: match.strongReferenceMatches,
				lexicalScore: match.lexicalScore,
				nearestDeltaHours: match.sourceTime.nearestDeltaHours,
				reasons,
			});
		}
	}
	return {
		generatedAt: now.toISOString(),
		activeTopicsReviewed: documents.length,
		minimumLexicalScore,
		suggestions: suggestions.sort(
			(left, right) =>
				right.strongReferenceMatches.length - left.strongReferenceMatches.length ||
				right.lexicalScore - left.lexicalScore ||
				left.leftTopicId.localeCompare(right.leftTopicId),
		),
	};
}
