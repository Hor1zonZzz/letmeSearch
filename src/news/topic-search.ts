import { createHash } from "node:crypto";
import type { NewsDatabase } from "./database";
import type {
	PendingTopicResolution,
	TopicSearchDocument,
	TopicType,
} from "./types";

export type TopicSearchStrategy =
	| "balanced"
	| "organization"
	| "subject"
	| "strong_reference";

export type TopicSearchSubject = {
	postId: string;
	xPostId: string;
	publishedAt: string;
	titleZh: string;
	titleEn: string;
	summaryZh: string;
	summaryEn: string;
	type: TopicType;
	organizationIds: string[];
	unknownOrganizationNames: string[];
	strongReferences: string[];
};

export type TopicSearchInput = {
	focus: string | null;
	strategy: TopicSearchStrategy;
	detail: "compact" | "with_evidence";
	limit: number;
};

export type TopicSearchMatch = {
	topicId: string;
	revision: number;
	titleZh: string;
	titleEn: string;
	summaryZhExcerpt: string;
	summaryEnExcerpt: string;
	type: TopicType;
	organizationIds: string[];
	organizationRelation:
		| "exact"
		| "candidate_subset"
		| "topic_subset"
		| "overlap"
		| "disjoint";
	overlapOrganizationIds: string[];
	sourceTime: {
		firstPublishedAt: string;
		lastPublishedAt: string;
		nearestPublishedAt: string;
		nearestDeltaHours: number;
		postCount: number;
	};
	strongReferenceMatches: string[];
	lexicalScore: number;
	sameType: boolean;
	evidence: Array<{
		publishedAt: string;
		publisherHandle: string;
		excerpt: string;
	}>;
};

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null
		? value as Record<string, unknown>
		: {};
}

function normalizedUrl(value: string): string | null {
	try {
		const url = new URL(value);
		url.hash = "";
		url.hostname = url.hostname.toLowerCase();
		for (const key of [...url.searchParams.keys()]) {
			if (key.toLowerCase().startsWith("utm_")) url.searchParams.delete(key);
		}
		url.searchParams.sort();
		if (url.hostname === "t.co" || url.hostname.endsWith("twimg.com")) return null;
		return url.toString();
	} catch {
		return null;
	}
}

const URL_FIELDS = new Set(["expanded_url", "unwound_url", "url"]);
const SKIPPED_REFERENCE_FIELDS = new Set(["author", "user_refs_results"]);

function collectStrongReferences(
	value: unknown,
	references: Set<string>,
	depth = 0,
): void {
	if (depth > 5 || typeof value !== "object" || value === null) return;
	const record = asRecord(value);
	if (
		typeof record.id === "string" && record.article &&
		typeof record.article === "object"
	) references.add(`x_article:${record.id}`);
	for (const [key, nested] of Object.entries(record)) {
		const nestedRecord = asRecord(nested);
		if (
			(key === "quoted_tweet" || key === "retweeted_tweet") &&
			typeof nestedRecord.id === "string"
		) references.add(`x_post:${nestedRecord.id}`);
		if (typeof nested === "string") {
			if (URL_FIELDS.has(key)) {
				const url = normalizedUrl(nested);
				if (url) references.add(`url:${url}`);
			}
			continue;
		}
		if (Array.isArray(nested)) {
			for (const item of nested)
				collectStrongReferences(item, references, depth + 1);
			continue;
		}
		if (!SKIPPED_REFERENCE_FIELDS.has(key))
			collectStrongReferences(nested, references, depth + 1);
	}
}

export function extractStrongReferences(
	rawPayload: Record<string, unknown>,
	quotedXPostId: string | null = null,
): string[] {
	const references = new Set<string>();
	if (quotedXPostId) references.add(`x_post:${quotedXPostId}`);
	collectStrongReferences(rawPayload, references);
	return [...references].sort((left, right) => left.localeCompare(right));
}

export function buildTopicSearchSubject(
	resolution: PendingTopicResolution,
): TopicSearchSubject {
	const strongReferences = extractStrongReferences(
		resolution.rawPayload,
		resolution.quotedXPostId,
	);
	return {
		postId: resolution.postId,
		xPostId: resolution.xPostId,
		publishedAt: resolution.publishedAt,
		titleZh: resolution.topicCandidate.titleZh,
		titleEn: resolution.topicCandidate.titleEn,
		summaryZh: resolution.topicCandidate.summaryZh,
		summaryEn: resolution.topicCandidate.summaryEn,
		type: resolution.topicCandidate.type,
		organizationIds: resolution.organizationIds,
		unknownOrganizationNames: resolution.unknownOrganizationCandidates,
		strongReferences,
	};
}

function tokens(value: string): Set<string> {
	const normalized = value.normalize("NFKC").toLowerCase();
	const result = new Set<string>(normalized.match(/[a-z0-9][a-z0-9._+-]*/g) ?? []);
	const cjk = [...normalized].filter((character) => /[\p{Script=Han}]/u.test(character));
	for (let index = 0; index < cjk.length - 1; index += 1) {
		result.add(`${cjk[index]}${cjk[index + 1]}`);
	}
	return result;
}

function lexicalSimilarity(left: Set<string>, right: Set<string>): number {
	if (left.size === 0 || right.size === 0) return 0;
	let overlap = 0;
	for (const token of left) if (right.has(token)) overlap += 1;
	return overlap / new Set([...left, ...right]).size;
}

function organizationRelation(
	candidateIds: string[],
	topicIds: string[],
): Pick<TopicSearchMatch, "organizationRelation" | "overlapOrganizationIds"> {
	const candidate = new Set(candidateIds);
	const topic = new Set(topicIds);
	const overlap = [...candidate]
		.filter((id) => topic.has(id))
		.sort((left, right) => left.localeCompare(right));
	if (
		candidate.size === topic.size &&
		overlap.length === candidate.size
	) return { organizationRelation: "exact", overlapOrganizationIds: overlap };
	if (candidate.size > 0 && overlap.length === candidate.size) {
		return { organizationRelation: "candidate_subset", overlapOrganizationIds: overlap };
	}
	if (topic.size > 0 && overlap.length === topic.size) {
		return { organizationRelation: "topic_subset", overlapOrganizationIds: overlap };
	}
	if (overlap.length > 0)
		return { organizationRelation: "overlap", overlapOrganizationIds: overlap };
	return { organizationRelation: "disjoint", overlapOrganizationIds: [] };
}

function documentReferences(document: TopicSearchDocument): Set<string> {
	const references = new Set<string>();
	for (const post of document.sourcePosts) {
		references.add(`x_post:${post.xPostId}`);
		collectStrongReferences(post.rawPayload, references);
	}
	return references;
}

function excerpt(value: string, maximum = 300): string {
	return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

type ScoredTopicMatch = {
	score: number;
	match: TopicSearchMatch;
};

function searchScore(options: {
	strategy: TopicSearchStrategy;
	strongReferenceCount: number;
	organizationScore: number;
	lexicalScore: number;
	sameType: boolean;
}): number {
	switch (options.strategy) {
		case "strong_reference":
			return options.strongReferenceCount * 1_000 + options.lexicalScore;
		case "organization":
			return options.organizationScore * 100 + options.lexicalScore;
		case "subject":
			return options.lexicalScore * 100 + options.organizationScore;
		case "balanced":
			return options.strongReferenceCount * 1_000 +
				options.organizationScore * 20 + (options.sameType ? 10 : 0) +
				options.lexicalScore * 10;
		default:
			throw new Error(`Unsupported Topic search strategy: ${options.strategy}`);
	}
}

function relevantSearchPool(
	scored: ScoredTopicMatch[],
	strategy: TopicSearchStrategy,
	hasStrongReferences: boolean,
): ScoredTopicMatch[] {
	if (strategy === "subject") {
		return scored.filter(({ match }) => match.lexicalScore >= 0.12);
	}
	if (strategy === "strong_reference" && hasStrongReferences) {
		return scored.filter(({ match }) => match.strongReferenceMatches.length > 0);
	}
	if (strategy === "organization") {
		const overlapping = scored.filter(
			({ match }) => match.organizationRelation !== "disjoint",
		);
		return overlapping.length > 0 ? overlapping : scored;
	}
	return scored;
}

export function searchActiveTopics(options: {
	database: NewsDatabase;
	subject: TopicSearchSubject;
	input: TopicSearchInput;
	windowHours?: number;
	offset?: number;
}): {
	searchId: string;
	from: string;
	to: string;
	eligibleTopicCount: number;
	truncated: boolean;
	matches: TopicSearchMatch[];
} {
	if (!Number.isInteger(options.input.limit) || options.input.limit < 1 || options.input.limit > 8) {
		throw new Error("Topic search limit must be an integer between 1 and 8");
	}
	const anchor = new Date(options.subject.publishedAt).getTime();
	if (!Number.isFinite(anchor)) throw new Error("Topic search subject has invalid publishedAt");
	const radius = (options.windowHours ?? 72) * 60 * 60 * 1_000;
	const from = new Date(anchor - radius).toISOString();
	const to = new Date(anchor + radius).toISOString();
	const subjectTokens = tokens([
		options.subject.titleZh,
		options.subject.titleEn,
		options.subject.summaryZh,
		options.subject.summaryEn,
		options.subject.unknownOrganizationNames.join(" "),
		options.input.focus ?? "",
	].join(" "));
	const subjectReferences = new Set(options.subject.strongReferences);
	const scored = options.database.listTopicsForSearch(from, to).map((document) => {
		const relation = organizationRelation(
			options.subject.organizationIds,
			document.organizationIds,
		);
		const documentTokens = tokens([
			document.titleZh,
			document.titleEn,
			document.summaryZh,
			document.summaryEn,
		].join(" "));
		const lexicalScore = lexicalSimilarity(subjectTokens, documentTokens);
		const references = documentReferences(document);
		const strongReferenceMatches = [...subjectReferences]
			.filter((reference) => references.has(reference))
			.sort((left, right) => left.localeCompare(right));
		const times = document.sourcePosts.map((post) => ({
			publishedAt: post.publishedAt,
			deltaHours: Math.abs(new Date(post.publishedAt).getTime() - anchor) / 3_600_000,
		}));
		const nearest = [...times].sort(
			(left, right) => left.deltaHours - right.deltaHours,
		)[0];
		const chronological = [...times].sort((left, right) =>
			left.publishedAt.localeCompare(right.publishedAt),
		);
		if (!nearest) throw new Error(`Topic ${document.id} has no search evidence`);
		const score = searchScore({
			strategy: options.input.strategy,
			strongReferenceCount: strongReferenceMatches.length,
			organizationScore: relation.overlapOrganizationIds.length,
			lexicalScore,
			sameType: document.type === options.subject.type,
		});
		return {
			score,
			match: {
				topicId: document.id,
				revision: document.revision,
				titleZh: document.titleZh,
				titleEn: document.titleEn,
				summaryZhExcerpt: excerpt(document.summaryZh),
				summaryEnExcerpt: excerpt(document.summaryEn),
				type: document.type,
				organizationIds: document.organizationIds,
				...relation,
				sourceTime: {
					firstPublishedAt: chronological[0]?.publishedAt ?? nearest.publishedAt,
					lastPublishedAt: chronological.at(-1)?.publishedAt ?? nearest.publishedAt,
					nearestPublishedAt: nearest.publishedAt,
					nearestDeltaHours: nearest.deltaHours,
					postCount: document.sourcePosts.length,
				},
				strongReferenceMatches,
				lexicalScore,
				sameType: document.type === options.subject.type,
				evidence: options.input.detail === "with_evidence"
					? document.sourcePosts.slice(0, 2).map((post) => ({
							publishedAt: post.publishedAt,
							publisherHandle: post.publisherHandle,
							excerpt: excerpt(post.content, 240),
						}))
					: [],
			},
		};
	});
	const ordered = relevantSearchPool(
		scored,
		options.input.strategy,
		subjectReferences.size > 0,
	).sort(
		(left, right) =>
			right.score - left.score || left.match.topicId.localeCompare(right.match.topicId),
	);
	const offset = options.offset ?? 0;
	const matches = ordered
		.slice(offset, offset + options.input.limit)
		.map(({ match }) => match);
	const searchId = createHash("sha256").update(JSON.stringify({
		postId: options.subject.postId,
		from,
		to,
		input: options.input,
		offset,
		matches: matches.map(({ topicId, revision }) => [topicId, revision]),
	})).digest("hex").slice(0, 24);
	return {
		searchId,
		from,
		to,
		eligibleTopicCount: ordered.length,
		truncated: offset + matches.length < ordered.length,
		matches,
	};
}
