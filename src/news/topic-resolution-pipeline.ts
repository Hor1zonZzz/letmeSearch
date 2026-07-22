import { randomUUID } from "node:crypto";
import { TOPIC_MATCH_WINDOW_HOURS, TOPIC_RESOLUTION_VERSION } from "./config";
import type { NewsDatabase } from "./database";
import type { PendingTopicResolution, TopicResolutionBatchPost } from "./types";
import {
	createTopicBatchTools,
	type TopicBatchToolSession,
} from "../tools/topic-batch-tools";

export type TopicBatchRequester = (options: {
	accountHandle: string;
	posts: TopicResolutionBatchPost[];
	sessionName: string;
	toolSession: TopicBatchToolSession;
}) => Promise<{ completed: true }>;

export type TopicResolutionStats = {
	accountBatchesAttempted: number;
	accountBatchesCompleted: number;
	postsAttempted: number;
	postsResolved: number;
	topicsCreated: number;
	postsAttachedToTopics: number;
	postsFailed: number;
	errors: Array<{ scope: string; message: string }>;
};

function emptyStats(): TopicResolutionStats {
	return {
		accountBatchesAttempted: 0,
		accountBatchesCompleted: 0,
		postsAttempted: 0,
		postsResolved: 0,
		topicsCreated: 0,
		postsAttachedToTopics: 0,
		postsFailed: 0,
		errors: [],
	};
}

function errorMessage(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function retryAt(now: Date, attemptCount: number): string {
	const delayMinutes = Math.min(10 * 2 ** Math.min(attemptCount, 6), 6 * 60);
	return new Date(now.getTime() + delayMinutes * 60 * 1_000).toISOString();
}

function accountBatches(
	pending: PendingTopicResolution[],
	maximumPosts: number,
): PendingTopicResolution[][] {
	const byAccount = new Map<string, PendingTopicResolution[]>();
	for (const item of pending) {
		const account = byAccount.get(item.accountId) ?? [];
		account.push(item);
		byAccount.set(item.accountId, account);
	}
	const batches: PendingTopicResolution[][] = [];
	for (const posts of byAccount.values()) {
		for (let index = 0; index < posts.length; index += maximumPosts) {
			batches.push(posts.slice(index, index + maximumPosts));
		}
	}
	return batches;
}

function resolutionPosts(
	posts: PendingTopicResolution[],
): TopicResolutionBatchPost[] {
	return posts.map((post, index) => ({ ...post, postRef: `p${index + 1}` }));
}

export async function runTopicResolutionBatch(options: {
	database: NewsDatabase;
	requester: TopicBatchRequester;
	limit?: number;
	accountBatchSize?: number;
	now?: () => Date;
}): Promise<TopicResolutionStats> {
	const now = options.now ?? (() => new Date());
	const attemptedAt = now();
	const accountBatchSize = options.accountBatchSize ?? 20;
	if (
		!Number.isInteger(accountBatchSize) ||
		accountBatchSize < 1 ||
		accountBatchSize > 20
	) {
		throw new Error("accountBatchSize must be an integer between 1 and 20");
	}
	const activeSince = new Date(
		attemptedAt.getTime() - TOPIC_MATCH_WINDOW_HOURS * 60 * 60 * 1_000,
	).toISOString();
	const pending = options.database.listPendingTopicResolutions(
		options.limit ?? 500,
		TOPIC_RESOLUTION_VERSION,
		attemptedAt.toISOString(),
		activeSince,
	);
	const stats = emptyStats();
	stats.postsAttempted = pending.length;
	let sessionIndex = 0;
	for (const accountPosts of accountBatches(pending, accountBatchSize)) {
		const first = accountPosts[0];
		if (!first) continue;
		sessionIndex += 1;
		stats.accountBatchesAttempted += 1;
		const posts = resolutionPosts(accountPosts);
		const sessionName = [
			"topic-batch",
			first.accountHandle.toLowerCase(),
			sessionIndex,
			randomUUID().slice(0, 8),
		].join("-");
		const toolSession = createTopicBatchTools({
			database: options.database,
			posts,
			activeSince,
			modelRunId: sessionName,
			now,
		});
		try {
			const result = await options.requester({
				accountHandle: first.accountHandle,
				posts,
				sessionName,
				toolSession,
			});
			if (!result.completed || !toolSession.isFinished()) {
				throw new Error("Topic Agent did not finish every Post assignment");
			}
			stats.accountBatchesCompleted += 1;
		} catch (error) {
			const message = errorMessage(error);
			const failedAt = now();
			const remaining = new Set(toolSession.remainingPostRefs());
			for (const post of posts) {
				if (!remaining.has(post.postRef)) continue;
				options.database.markTopicResolutionFailed({
					postId: post.postId,
					error: message,
					nextRetryAt: retryAt(failedAt, post.attemptCount),
					resolutionVersion: TOPIC_RESOLUTION_VERSION,
					now: failedAt.toISOString(),
				});
				stats.postsFailed += 1;
			}
			stats.errors.push({
				scope: `topic-resolution:@${first.accountHandle}`,
				message,
			});
		}
		const remainingCount = toolSession.remainingPostRefs().length;
		stats.postsResolved += posts.length - remainingCount;
		stats.topicsCreated += toolSession.stats.topicsCreated;
		stats.postsAttachedToTopics += toolSession.stats.postsAttachedToTopics;
	}
	return stats;
}

export async function runTopicResolutionBacklog(options: {
	database: NewsDatabase;
	requester: TopicBatchRequester;
	batchSize?: number;
	accountBatchSize?: number;
	now?: () => Date;
}): Promise<TopicResolutionStats> {
	const now = options.now ?? (() => new Date());
	const owner = randomUUID();
	const startedAt = now();
	const acquired = options.database.acquireJobLock({
		name: "topic-resolution",
		owner,
		now: startedAt.toISOString(),
		expiresAt: new Date(
			startedAt.getTime() + 2 * 60 * 60 * 1_000,
		).toISOString(),
	});
	if (!acquired)
		throw new Error("Another topic-resolution job is already running");
	const total = emptyStats();
	try {
		while (true) {
			const batch = await runTopicResolutionBatch({
				database: options.database,
				requester: options.requester,
				limit: options.batchSize ?? 500,
				accountBatchSize: options.accountBatchSize,
				now,
			});
			for (const key of [
				"accountBatchesAttempted",
				"accountBatchesCompleted",
				"postsAttempted",
				"postsResolved",
				"topicsCreated",
				"postsAttachedToTopics",
				"postsFailed",
			] as const)
				total[key] += batch[key];
			total.errors.push(...batch.errors);
			if (batch.postsAttempted < (options.batchSize ?? 500)) break;
		}
		return total;
	} finally {
		options.database.releaseJobLock("topic-resolution", owner);
	}
}
