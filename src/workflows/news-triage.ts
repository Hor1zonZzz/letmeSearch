import { randomUUID } from "node:crypto";
import { defineWorkflow } from "@flue/runtime";
import * as v from "valibot";
import agent from "../agents/news-triage";
import {
	hydratePostArticles,
	type ArticleHydrationStats,
} from "../news/article-hydrator";
import { NewsDatabase } from "../news/database";
import { normalizeTopicPostAnalyses } from "../news/topic-classifier";
import { runTopicBacklog } from "../news/topic-pipeline";
import { topicClassificationPrompt } from "../news/topic-prompts";
import { topicPostAnalysisBatchSchema } from "../news/schemas";
import { TwitterApiClient } from "../news/twitter-api";

const positiveInteger = (maximum: number) =>
	v.optional(
		v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(maximum)),
	);

const inputSchema = v.object({
	articleBatchSize: positiveInteger(500),
	articleConcurrency: positiveInteger(10),
	topicBatchSize: positiveInteger(500),
});

const articleStatsSchema = v.object({
	candidates: v.number(),
	articlesFetched: v.number(),
	notArticles: v.number(),
	failed: v.number(),
});

const topicStatsSchema = v.object({
	postsAttempted: v.number(),
	postsAnalyzed: v.number(),
	importantPosts: v.number(),
	ignoredPosts: v.number(),
	postsQueuedForResolution: v.number(),
	topicsCreated: v.number(),
	postsAttachedToTopics: v.number(),
	errors: v.array(v.object({ scope: v.string(), message: v.string() })),
});

const outputSchema = v.object({
	articleStats: articleStatsSchema,
	topicStats: topicStatsSchema,
});

export default defineWorkflow({
	agent,
	input: inputSchema,
	output: outputSchema,

	async run({ harness, input }) {
		const database = new NewsDatabase();
		const owner = randomUUID();
		const startedAt = new Date();
		const acquired = database.acquireJobLock({
			name: "news-triage-workflow",
			owner,
			now: startedAt.toISOString(),
			expiresAt: new Date(
				startedAt.getTime() + 2 * 60 * 60 * 1_000,
			).toISOString(),
		});
		if (!acquired) {
			database.close();
			throw new Error("Another news-triage workflow is already running");
		}

		try {
			const client = new TwitterApiClient();
			const articleStats: ArticleHydrationStats = {
				candidates: 0,
				articlesFetched: 0,
				notArticles: 0,
				failed: 0,
			};
			const articleBatchSize = input.articleBatchSize ?? 100;
			while (true) {
				const batch = await hydratePostArticles({
					database,
					client,
					limit: articleBatchSize,
					concurrency: input.articleConcurrency ?? 5,
				});
				articleStats.candidates += batch.candidates;
				articleStats.articlesFetched += batch.articlesFetched;
				articleStats.notArticles += batch.notArticles;
				articleStats.failed += batch.failed;
				if (batch.candidates < articleBatchSize) break;
			}

			let classificationSessionIndex = 0;
			const topicStats = await runTopicBacklog({
				database,
				batchSize: input.topicBatchSize ?? 100,
				classifier: async (posts) => {
					classificationSessionIndex += 1;
					const session = await harness.session(
						`classification-${classificationSessionIndex}`,
					);
					const { data } = await session.prompt(
						topicClassificationPrompt(posts),
						{ result: topicPostAnalysisBatchSchema },
					);
					return normalizeTopicPostAnalyses(posts, data.analyses);
				},
			});

			return { articleStats, topicStats };
		} finally {
			database.releaseJobLock("news-triage-workflow", owner);
			database.close();
		}
	},
});
