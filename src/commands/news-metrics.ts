import { runScheduledNewsMetrics } from "../news/scheduled-jobs";

try {
	const stats = await runScheduledNewsMetrics();
	process.stdout.write(`${JSON.stringify(stats)}\n`);
	if (stats.errors.length > 0) process.exitCode = 1;
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`${JSON.stringify({ error: message.slice(0, 500) })}\n`);
	process.exitCode = 1;
}
