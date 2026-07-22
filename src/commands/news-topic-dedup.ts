import { NewsDatabase } from "../news/database";
import { createTopicDedupDryRun } from "../news/topic-dedup-dry-run";

const database = new NewsDatabase();
try {
	const report = createTopicDedupDryRun({ database });
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
	database.close();
}
