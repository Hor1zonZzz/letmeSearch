import { NewsDatabase } from "../news/database";
import { runMetricsRefresh } from "../news/metrics-refresh";
import { TwitterApiClient } from "../news/twitter-api";

let database: NewsDatabase | null = null;

try {
	database = new NewsDatabase();
	const stats = await runMetricsRefresh({
		database,
		client: new TwitterApiClient(),
		batchSize: 50,
	});
	process.stdout.write(`${JSON.stringify(stats)}\n`);
	if (stats.errors.length > 0) process.exitCode = 1;
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`${JSON.stringify({ error: message.slice(0, 500) })}\n`);
	process.exitCode = 1;
} finally {
	database?.close();
}
