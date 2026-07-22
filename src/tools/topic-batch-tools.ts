import { defineTool } from "@flue/runtime";
import * as v from "valibot";
import { TOPIC_RESOLUTION_VERSION } from "../news/config";
import type { NewsDatabase } from "../news/database";
import { topicCandidateSchema } from "../news/schemas";
import {
	buildTopicSearchSubject,
	searchActiveTopics,
	type TopicSearchSubject,
} from "../news/topic-search";
import type { TopicResolutionBatchPost, TopicType } from "../news/types";

const postRefsSchema = v.pipe(
	v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(20))),
	v.minLength(1),
	v.maxLength(20),
);

const searchInputSchema = v.object({ posts: postRefsSchema });
const searchOutputSchema = v.object({
	topics: v.array(
		v.object({
			topic: v.string(),
			titleZh: v.string(),
			titleEn: v.string(),
			summaryZh: v.string(),
			summaryEn: v.string(),
			type: v.string(),
			evidence: v.array(
				v.object({
					publishedAt: v.string(),
					publisher: v.string(),
					excerpt: v.string(),
				}),
			),
		}),
	),
});

const assignmentOutputSchema = v.object({
	assigned: v.array(v.string()),
	remaining: v.array(v.string()),
});

const addPostsInputSchema = v.object({
	posts: postRefsSchema,
	topic: v.pipe(v.string(), v.minLength(1), v.maxLength(20)),
	update: v.optional(topicCandidateSchema),
});

const createTopicInputSchema = v.object({
	posts: postRefsSchema,
	topic: topicCandidateSchema,
});

const finishOutputSchema = v.object({ completed: v.literal(true) });

type TopicBatchSearchTrace = {
	postRefs: string[];
	searchId: string;
	matches: Array<{ topicId: string; revision: number }>;
};

type TopicBinding = {
	topicId: string;
	revision: number;
	authorizedPostRefs: Set<string>;
};

export type TopicBatchToolSession = {
	tools: ReturnType<typeof defineTool>[];
	remainingPostRefs(): string[];
	isFinished(): boolean;
	stats: {
		topicsCreated: number;
		postsAttachedToTopics: number;
	};
	trace: TopicBatchSearchTrace[];
};

function uniquePostRefs(postRefs: string[]): string[] {
	const unique = [...new Set(postRefs)];
	if (unique.length !== postRefs.length) {
		throw new Error("Post references must not be repeated");
	}
	return unique;
}

function combinedSubject(
	posts: TopicResolutionBatchPost[],
): TopicSearchSubject {
	const subjects = posts.map(buildTopicSearchSubject);
	const latest = [...subjects].sort((left, right) =>
		right.publishedAt.localeCompare(left.publishedAt),
	)[0];
	if (!latest) throw new Error("Topic search has no Posts");
	const types = new Set(subjects.map(({ type }) => type));
	return {
		postId: `batch:${posts.map(({ postRef }) => postRef).join(",")}`,
		xPostId: posts.map(({ xPostId }) => xPostId).join(","),
		publishedAt: latest.publishedAt,
		titleZh: subjects.map(({ titleZh }) => titleZh).join("\n"),
		titleEn: subjects.map(({ titleEn }) => titleEn).join("\n"),
		summaryZh: subjects.map(({ summaryZh }) => summaryZh).join("\n"),
		summaryEn: subjects.map(({ summaryEn }) => summaryEn).join("\n"),
		type: (types.size === 1 ? latest.type : "other") as TopicType,
		organizationIds: [
			...new Set(subjects.flatMap(({ organizationIds }) => organizationIds)),
		],
		unknownOrganizationNames: [
			...new Set(
				subjects.flatMap(
					({ unknownOrganizationNames }) => unknownOrganizationNames,
				),
			),
		],
		strongReferences: [
			...new Set(subjects.flatMap(({ strongReferences }) => strongReferences)),
		],
	};
}

export function createTopicBatchTools(options: {
	database: NewsDatabase;
	posts: TopicResolutionBatchPost[];
	activeSince: string;
	modelRunId: string;
	now?: () => Date;
}): TopicBatchToolSession {
	const now = options.now ?? (() => new Date());
	const postsByRef = new Map(options.posts.map((post) => [post.postRef, post]));
	const unassigned = new Set(postsByRef.keys());
	const searchedPostRefs = new Set<string>();
	const bindingsByRef = new Map<string, TopicBinding>();
	const refsByTopicId = new Map<string, string>();
	const trace: TopicBatchSearchTrace[] = [];
	let nextTopicRef = 1;
	let finished = false;
	const stats = { topicsCreated: 0, postsAttachedToTopics: 0 };
	let writeQueue = Promise.resolve();
	const serializeWrite = <T>(operation: () => T): Promise<T> => {
		const result = writeQueue.then(operation);
		writeQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};

	const selectPosts = (postRefs: string[], requireUnassigned = true) => {
		const refs = uniquePostRefs(postRefs);
		return refs.map((postRef) => {
			const post = postsByRef.get(postRef);
			if (!post) throw new Error(`Unknown Post reference: ${postRef}`);
			if (requireUnassigned && !unassigned.has(postRef)) {
				throw new Error(`Post is already assigned: ${postRef}`);
			}
			return post;
		});
	};
	const remaining = () =>
		options.posts
			.map(({ postRef }) => postRef)
			.filter((postRef) => unassigned.has(postRef));
	const markAssigned = (postRefs: string[]) => {
		for (const postRef of postRefs) unassigned.delete(postRef);
	};

	const searchTopics = defineTool({
		name: "search_topics",
		description:
			"Search recent existing Topics for one or more related Posts from this account batch. Group Posts that may describe the same real-world event and search them together. The application controls the 72-hour window and result ranking.",
		input: searchInputSchema,
		output: searchOutputSchema,
		async run({ input }) {
			const selected = selectPosts(input.posts);
			const result = searchActiveTopics({
				database: options.database,
				subject: combinedSubject(selected),
				input: {
					focus: null,
					strategy: "balanced",
					detail: "with_evidence",
					limit: 8,
				},
				activeSince: options.activeSince,
			});
			for (const post of selected) searchedPostRefs.add(post.postRef);
			for (const match of result.matches) {
				let topicRef = refsByTopicId.get(match.topicId);
				if (!topicRef) {
					topicRef = `t${nextTopicRef}`;
					nextTopicRef += 1;
					refsByTopicId.set(match.topicId, topicRef);
				}
				const existing = bindingsByRef.get(topicRef);
				bindingsByRef.set(topicRef, {
					topicId: match.topicId,
					revision: match.revision,
					authorizedPostRefs: new Set([
						...(existing?.authorizedPostRefs ?? []),
						...selected.map(({ postRef }) => postRef),
					]),
				});
			}
			trace.push({
				postRefs: selected.map(({ postRef }) => postRef),
				searchId: result.searchId,
				matches: result.matches.map(({ topicId, revision }) => ({
					topicId,
					revision,
				})),
			});
			return {
				topics: result.matches.map((match) => ({
					topic: refsByTopicId.get(match.topicId) ?? "",
					titleZh: match.titleZh,
					titleEn: match.titleEn,
					summaryZh: match.summaryZhExcerpt,
					summaryEn: match.summaryEnExcerpt,
					type: match.type,
					evidence: match.evidence.map((evidence) => ({
						publishedAt: evidence.publishedAt,
						publisher: evidence.publisherHandle,
						excerpt: evidence.excerpt,
					})),
				})),
			};
		},
	});

	const addPosts = defineTool({
		name: "add_posts",
		description:
			"Immediately and atomically add one or more unassigned Posts to a searched existing Topic. Optionally replace the Topic title, summaries, and type when the new evidence materially improves them.",
		input: addPostsInputSchema,
		output: assignmentOutputSchema,
		async run({ input }) {
			return serializeWrite(() => {
				const selected = selectPosts(input.posts);
				const binding = bindingsByRef.get(input.topic);
				if (!binding) {
					throw new Error(`Unknown searched Topic reference: ${input.topic}`);
				}
				for (const { postRef } of selected) {
					if (!binding.authorizedPostRefs.has(postRef)) {
						throw new Error(
							`Topic ${input.topic} was not returned for ${postRef}`,
						);
					}
				}
				const committed = options.database.commitTopicBatch({
					postIds: selected.map(({ postId }) => postId),
					decision: "attach",
					targetTopicId: binding.topicId,
					expectedTopicRevision: binding.revision,
					topic: input.update ?? null,
					searchTrace: { searches: trace },
					modelRunId: options.modelRunId,
					resolutionVersion: TOPIC_RESOLUTION_VERSION,
					now: now().toISOString(),
				});
				binding.revision = committed.revision;
				stats.postsAttachedToTopics += selected.length;
				markAssigned(selected.map(({ postRef }) => postRef));
				return {
					assigned: selected.map(({ postRef }) => postRef),
					remaining: remaining(),
				};
			});
		},
	});

	const createTopic = defineTool({
		name: "create_topic",
		description:
			"Immediately and atomically create one new Topic from one or more unassigned Posts after search found no matching event. Generate bilingual Topic content from the entire Post group.",
		input: createTopicInputSchema,
		output: assignmentOutputSchema,
		async run({ input }) {
			return serializeWrite(() => {
				const selected = selectPosts(input.posts);
				for (const { postRef } of selected) {
					if (!searchedPostRefs.has(postRef)) {
						throw new Error(
							`Search is required before creating a Topic for ${postRef}`,
						);
					}
				}
				options.database.commitTopicBatch({
					postIds: selected.map(({ postId }) => postId),
					decision: "create",
					targetTopicId: null,
					expectedTopicRevision: null,
					topic: input.topic,
					searchTrace: { searches: trace },
					modelRunId: options.modelRunId,
					resolutionVersion: TOPIC_RESOLUTION_VERSION,
					now: now().toISOString(),
				});
				stats.topicsCreated += 1;
				stats.postsAttachedToTopics += selected.length;
				markAssigned(selected.map(({ postRef }) => postRef));
				return {
					assigned: selected.map(({ postRef }) => postRef),
					remaining: remaining(),
				};
			});
		},
	});

	const finishTopicPlan = defineTool({
		name: "finish_topic_plan",
		description:
			"Finish this account batch after every Post has been assigned exactly once by add_posts or create_topic.",
		input: v.object({}),
		output: finishOutputSchema,
		async run() {
			await writeQueue;
			const pending = remaining();
			if (pending.length > 0) {
				throw new Error(`Unassigned Posts remain: ${pending.join(", ")}`);
			}
			finished = true;
			return { completed: true as const };
		},
	});

	return {
		tools: [searchTopics, addPosts, createTopic, finishTopicPlan],
		remainingPostRefs: remaining,
		isFinished: () => finished,
		stats,
		trace,
	};
}
