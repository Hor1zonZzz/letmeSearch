import { MONITORED_ACCOUNT_SEEDS } from "../news/config";
import { NewsDatabase } from "../news/database";
import { ingestNews } from "../news/ingest";
import { TwitterApiClient } from "../news/twitter-api";

let database: NewsDatabase | null = null;

try {
	database = new NewsDatabase();
	database.seedAccounts(MONITORED_ACCOUNT_SEEDS);
	const stats = await ingestNews({
		database,
		client: new TwitterApiClient(),
		concurrency: 10,
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
