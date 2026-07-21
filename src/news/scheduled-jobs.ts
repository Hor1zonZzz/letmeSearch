import { MONITORED_ACCOUNT_SEEDS } from "./config";
import { NewsDatabase } from "./database";
import { ingestNews, type NewsIngestStats } from "./ingest";
import { runMetricsRefresh, type MetricsRefreshStats } from "./metrics-refresh";
import { TwitterApiClient } from "./twitter-api";

export async function runScheduledNewsIngest(): Promise<NewsIngestStats> {
	const database = new NewsDatabase();
	try {
		database.seedAccounts(MONITORED_ACCOUNT_SEEDS);
		return await ingestNews({
			database,
			client: new TwitterApiClient(),
			concurrency: 10,
		});
	} finally {
		database.close();
	}
}

export async function runScheduledNewsMetrics(): Promise<MetricsRefreshStats> {
	const database = new NewsDatabase();
	try {
		return await runMetricsRefresh({
			database,
			client: new TwitterApiClient(),
			batchSize: 50,
		});
	} finally {
		database.close();
	}
}
