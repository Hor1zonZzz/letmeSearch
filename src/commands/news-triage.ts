import { hydratePostArticles, type ArticleHydrationStats } from "../news/article-hydrator";
import { NewsDatabase } from "../news/database";
import { runTopicBacklog } from "../news/topic-pipeline";
import { TwitterApiClient } from "../news/twitter-api";

let database: NewsDatabase | null = null;

try {
	database = new NewsDatabase();
	const client = new TwitterApiClient();
	const articleStats: ArticleHydrationStats = {
		candidates: 0,
		articlesFetched: 0,
		notArticles: 0,
		failed: 0,
	};
	while (true) {
		const batch = await hydratePostArticles({
			database,
			client,
			limit: 100,
			concurrency: 5,
		});
		articleStats.candidates += batch.candidates;
		articleStats.articlesFetched += batch.articlesFetched;
		articleStats.notArticles += batch.notArticles;
		articleStats.failed += batch.failed;
		if (batch.candidates < 100) break;
	}
	const topicStats = await runTopicBacklog({ database, batchSize: 100 });
	process.stdout.write(`${JSON.stringify({ articleStats, topicStats })}\n`);
	if (articleStats.failed > 0 || topicStats.errors.length > 0) {
		process.exitCode = 1;
	}
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`${JSON.stringify({ error: message.slice(0, 500) })}\n`);
	process.exitCode = 1;
} finally {
	database?.close();
}
