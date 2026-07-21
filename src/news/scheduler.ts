import { invoke } from "@flue/runtime";
import { Cron } from "croner";
import newsTriage from "../workflows/news-triage";
import {
	runScheduledNewsIngest,
	runScheduledNewsMetrics,
} from "./scheduled-jobs";

export const NEWS_INGEST_SCHEDULE = "0 0,4,8,12,15-23 * * *";
export const NEWS_METRICS_SCHEDULE = "45 0,4,8,12,16,20 * * *";

let jobs: Cron[] | null = null;

function log(event: string, payload: unknown): void {
	process.stdout.write(
		`${JSON.stringify({ event, payload, at: new Date().toISOString() })}\n`,
	);
}

function logFailure(scope: string, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(
		`${JSON.stringify({
			event: "news-scheduler-error",
			scope,
			message: message.slice(0, 500),
			at: new Date().toISOString(),
		})}\n`,
	);
}

export function startNewsScheduler(): Cron[] {
	if (jobs) return jobs;
	const common = {
		protect: true,
		timezone: "UTC",
		catch: (error: unknown) => logFailure("cron", error),
	} as const;
	jobs = [
		new Cron(NEWS_INGEST_SCHEDULE, common, async () => {
			const stats = await runScheduledNewsIngest();
			log("news-ingest-completed", stats);
			const receipt = await invoke(newsTriage, { input: {} });
			log("news-triage-admitted", receipt);
		}),
		new Cron(NEWS_METRICS_SCHEDULE, common, async () => {
			const stats = await runScheduledNewsMetrics();
			log("news-metrics-completed", stats);
		}),
	];
	log("news-scheduler-started", {
		timezone: "UTC",
		ingestAndTriage: NEWS_INGEST_SCHEDULE,
		metrics: NEWS_METRICS_SCHEDULE,
	});
	return jobs;
}
