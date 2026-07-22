import { randomUUID } from "node:crypto";
import { TOPIC_ANALYSIS_VERSION, TOPIC_RESOLUTION_VERSION } from "./config";
import type { NewsDatabase } from "./database";
import { ORGANIZATIONS } from "./organizations";
import { classifyTopicPosts } from "./topic-classifier";
import type { PostForTriage, PostTopicAnalysis } from "./types";

export type TopicPostClassifier = (
	posts: PostForTriage[],
) => Promise<PostTopicAnalysis[]>;

export type TopicPipelineStats = {
	postsAttempted: number;
	postsAnalyzed: number;
	importantPosts: number;
	ignoredPosts: number;
	postsQueuedForResolution: number;
	topicsCreated: number;
	postsAttachedToTopics: number;
	errors: Array<{ scope: string; message: string }>;
};

function errorMessage(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function groupByAccount(posts: PostForTriage[]): PostForTriage[][] {
	const groups = new Map<string, PostForTriage[]>();
	for (const post of posts) {
		const existing = groups.get(post.accountId);
		if (existing) existing.push(post);
		else groups.set(post.accountId, [post]);
	}
	const batches: PostForTriage[][] = [];
	for (const group of groups.values()) {
		for (let index = 0; index < group.length; index += 10) {
			batches.push(group.slice(index, index + 10));
		}
	}
	return batches;
}

async function analyzeBatches(options: {
	posts: PostForTriage[];
	classifier: TopicPostClassifier;
	database: NewsDatabase;
	now: () => Date;
	stats: TopicPipelineStats;
}): Promise<Map<string, PostTopicAnalysis>> {
	const groups = groupByAccount(options.posts);
	const settled = await Promise.allSettled(
		groups.map((posts) => options.classifier(posts)),
	);
	const analyses = new Map<string, PostTopicAnalysis>();
	for (const [index, outcome] of settled.entries()) {
		const posts = groups[index] ?? [];
		if (outcome.status === "fulfilled") {
			for (const analysis of outcome.value)
				analyses.set(analysis.postId, analysis);
			continue;
		}
		const message = errorMessage(outcome.reason);
		for (const post of posts) {
			options.database.markPostTopicAnalysisFailed(
				post.id,
				message,
				TOPIC_ANALYSIS_VERSION,
				options.now().toISOString(),
			);
		}
		options.stats.errors.push({
			scope: `topic-classification:@${posts[0]?.accountHandle ?? "unknown"}`,
			message,
		});
	}
	return analyses;
}

export async function runTopicPipeline(options: {
	database: NewsDatabase;
	classifier?: TopicPostClassifier;
	limit?: number;
	now?: () => Date;
}): Promise<TopicPipelineStats> {
	const { database } = options;
	const now = options.now ?? (() => new Date());
	database.seedOrganizations(ORGANIZATIONS);
	const retryFailedBefore = new Date(
		now().getTime() - 60 * 60 * 1_000,
	).toISOString();
	const posts = database.listPostsForTopicAnalysis(
		options.limit ?? 100,
		TOPIC_ANALYSIS_VERSION,
		retryFailedBefore,
	);
	const stats: TopicPipelineStats = {
		postsAttempted: posts.length,
		postsAnalyzed: 0,
		importantPosts: 0,
		ignoredPosts: 0,
		postsQueuedForResolution: 0,
		topicsCreated: 0,
		postsAttachedToTopics: 0,
		errors: [],
	};
	const classifier = options.classifier ?? classifyTopicPosts;
	const analyses = await analyzeBatches({
		posts,
		classifier,
		database,
		now,
		stats,
	});

	for (const post of posts) {
		const analysis = analyses.get(post.id);
		if (!analysis) continue;
		const analyzedAt = now().toISOString();
		try {
			database.commitPostTopicClassification({
				analysis,
				analysisVersion: TOPIC_ANALYSIS_VERSION,
				resolutionVersion: TOPIC_RESOLUTION_VERSION,
				now: analyzedAt,
			});
			stats.postsAnalyzed += 1;
			if (analysis.decision === "ignore") {
				stats.ignoredPosts += 1;
				continue;
			}
			stats.postsQueuedForResolution += 1;
			stats.importantPosts += 1;
		} catch (error) {
			const message = errorMessage(error);
			database.markPostTopicAnalysisFailed(
				post.id,
				message,
				TOPIC_ANALYSIS_VERSION,
				analyzedAt,
			);
			stats.errors.push({ scope: `topic:${post.xPostId}`, message });
		}
	}
	return stats;
}

export async function runTopicBacklog(options: {
	database: NewsDatabase;
	classifier?: TopicPostClassifier;
	batchSize?: number;
	now?: () => Date;
}): Promise<TopicPipelineStats> {
	const now = options.now ?? (() => new Date());
	const owner = randomUUID();
	const acquiredAt = now();
	const acquired = options.database.acquireJobLock({
		name: "topic-triage",
		owner,
		now: acquiredAt.toISOString(),
		expiresAt: new Date(acquiredAt.getTime() + 60 * 60 * 1_000).toISOString(),
	});
	if (!acquired) throw new Error("Another topic-triage job is already running");
	const total: TopicPipelineStats = {
		postsAttempted: 0,
		postsAnalyzed: 0,
		importantPosts: 0,
		ignoredPosts: 0,
		postsQueuedForResolution: 0,
		topicsCreated: 0,
		postsAttachedToTopics: 0,
		errors: [],
	};
	try {
		while (true) {
			const batch = await runTopicPipeline({
				database: options.database,
				classifier: options.classifier,
				limit: options.batchSize ?? 100,
				now,
			});
			total.postsAttempted += batch.postsAttempted;
			total.postsAnalyzed += batch.postsAnalyzed;
			total.importantPosts += batch.importantPosts;
			total.ignoredPosts += batch.ignoredPosts;
			total.postsQueuedForResolution += batch.postsQueuedForResolution;
			total.topicsCreated += batch.topicsCreated;
			total.postsAttachedToTopics += batch.postsAttachedToTopics;
			total.errors.push(...batch.errors);
			if (batch.postsAttempted < (options.batchSize ?? 100)) break;
		}
		return total;
	} finally {
		options.database.releaseJobLock("topic-triage", owner);
	}
}
