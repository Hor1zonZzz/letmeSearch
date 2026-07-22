import { randomUUID } from "node:crypto";
import { TOPIC_RESOLUTION_VERSION } from "./config";
import type { NewsDatabase } from "./database";
import { buildTopicSearchSubject } from "./topic-search";
import {
	validateToolTopicResolution,
	type ValidatedTopicResolution,
} from "./topic-resolution";
import type { StructuredToolTopicResolution } from "./schemas";
import { createSearchActiveTopics, type TopicSearchToolSession } from "../tools/search-active-topics";
import type { PendingTopicResolution } from "./types";

export type TopicResolutionRequester = (options: {
	pending: PendingTopicResolution;
	search: TopicSearchToolSession;
}) => Promise<{
	result: StructuredToolTopicResolution;
	modelRunId: string | null;
}>;

export type TopicResolutionStats = {
	postsAttempted: number;
	postsResolved: number;
	topicsCreated: number;
	postsAttachedToTopics: number;
	postsDeferred: number;
	postsFailed: number;
	errors: Array<{ scope: string; message: string }>;
};

function errorMessage(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function nextRetryAt(
	now: Date,
	attemptCount: number,
): string | null {
	const delayHours = [1, 6, 24][Math.min(attemptCount, 2)];
	if (delayHours === undefined || attemptCount >= 2) return null;
	return new Date(now.getTime() + delayHours * 60 * 60 * 1_000).toISOString();
}

function traceJson(search: TopicSearchToolSession): Record<string, unknown> {
	return { searches: search.trace };
}

async function resolveOne(options: {
	database: NewsDatabase;
	pending: PendingTopicResolution;
	requester: TopicResolutionRequester;
}): Promise<{
	resolution: ValidatedTopicResolution;
	modelRunId: string | null;
	search: TopicSearchToolSession;
}> {
	const subject = buildTopicSearchSubject(options.pending);
	const search = createSearchActiveTopics({
		database: options.database,
		subject,
	});
	const response = await options.requester({ pending: options.pending, search });
	return {
		resolution: validateToolTopicResolution(response.result, search),
		modelRunId: response.modelRunId,
		search,
	};
}

export async function runTopicResolutionBatch(options: {
	database: NewsDatabase;
	requester: TopicResolutionRequester;
	limit?: number;
	now?: () => Date;
}): Promise<TopicResolutionStats> {
	const now = options.now ?? (() => new Date());
	const attemptedAt = now();
	const pending = options.database.listPendingTopicResolutions(
		options.limit ?? 100,
		TOPIC_RESOLUTION_VERSION,
		attemptedAt.toISOString(),
	);
	const stats: TopicResolutionStats = {
		postsAttempted: pending.length,
		postsResolved: 0,
		topicsCreated: 0,
		postsAttachedToTopics: 0,
		postsDeferred: 0,
		postsFailed: 0,
		errors: [],
	};
	for (const item of pending) {
		try {
			const { resolution, modelRunId, search } = await resolveOne({
				database: options.database,
				pending: item,
				requester: options.requester,
			});
			const resolvedAt = now().toISOString();
			if (resolution.decision === "defer") {
				options.database.markTopicResolutionDeferred({
					postId: item.postId,
					reason: `${resolution.reasonCode}: ${resolution.reason}`,
					confidence: resolution.confidence,
					searchTrace: traceJson(search),
					modelRunId,
					resolutionVersion: TOPIC_RESOLUTION_VERSION,
					nextRetryAt: nextRetryAt(now(), item.attemptCount),
					now: resolvedAt,
				});
				stats.postsDeferred += 1;
				continue;
			}
			const committed = options.database.commitTopicResolution({
				postId: item.postId,
				decision: resolution.decision,
				targetTopicId: resolution.decision === "attach"
					? resolution.topicId
					: null,
				expectedTopicRevision: resolution.decision === "attach"
					? resolution.expectedRevision
					: null,
				confidence: resolution.confidence,
				reason: resolution.reason,
				searchTrace: traceJson(search),
				modelRunId,
				resolutionVersion: TOPIC_RESOLUTION_VERSION,
				now: resolvedAt,
			});
			stats.postsResolved += 1;
			stats.postsAttachedToTopics += 1;
			if (committed.topicCreated) stats.topicsCreated += 1;
		} catch (error) {
			const message = errorMessage(error);
			const failedAt = now();
			if (item.attemptCount >= 2) {
				options.database.markTopicResolutionDeferred({
					postId: item.postId,
					reason: `search_failed: ${message}`,
					confidence: 0,
					searchTrace: { searches: [] },
					modelRunId: null,
					resolutionVersion: TOPIC_RESOLUTION_VERSION,
					nextRetryAt: null,
					now: failedAt.toISOString(),
				});
				stats.postsDeferred += 1;
			} else {
				options.database.markTopicResolutionFailed({
					postId: item.postId,
					error: message,
					resolutionVersion: TOPIC_RESOLUTION_VERSION,
					nextRetryAt: nextRetryAt(failedAt, item.attemptCount) ??
						new Date(failedAt.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
					now: failedAt.toISOString(),
				});
				stats.postsFailed += 1;
			}
			stats.errors.push({ scope: `topic-resolution:${item.xPostId}`, message });
		}
	}
	return stats;
}

export async function runTopicResolutionBacklog(options: {
	database: NewsDatabase;
	requester: TopicResolutionRequester;
	batchSize?: number;
	now?: () => Date;
}): Promise<TopicResolutionStats> {
	const now = options.now ?? (() => new Date());
	const owner = randomUUID();
	const startedAt = now();
	const acquired = options.database.acquireJobLock({
		name: "topic-resolution",
		owner,
		now: startedAt.toISOString(),
		expiresAt: new Date(startedAt.getTime() + 60 * 60 * 1_000).toISOString(),
	});
	if (!acquired) throw new Error("Another topic-resolution job is already running");
	const total: TopicResolutionStats = {
		postsAttempted: 0,
		postsResolved: 0,
		topicsCreated: 0,
		postsAttachedToTopics: 0,
		postsDeferred: 0,
		postsFailed: 0,
		errors: [],
	};
	try {
		while (true) {
			const batch = await runTopicResolutionBatch({
				database: options.database,
				requester: options.requester,
				limit: options.batchSize ?? 100,
				now,
			});
			for (const key of [
				"postsAttempted",
				"postsResolved",
				"topicsCreated",
				"postsAttachedToTopics",
				"postsDeferred",
				"postsFailed",
			] as const) total[key] += batch[key];
			total.errors.push(...batch.errors);
			if (batch.postsAttempted < (options.batchSize ?? 100)) break;
		}
		return total;
	} finally {
		options.database.releaseJobLock("topic-resolution", owner);
	}
}
