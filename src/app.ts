import { flue } from "@flue/runtime/routing";
import { Hono } from "hono";
import { NewsDatabase } from "./news/database";
import { startNewsScheduler } from "./news/scheduler";

const schedulerEnabled = process.env.NEWS_SCHEDULER_ENABLED === "true";
if (schedulerEnabled) startNewsScheduler();

const app = new Hono();

app.get("/health", (context) =>
	context.json({ ok: true, newsSchedulerEnabled: schedulerEnabled }),
);
app.get("/news/hot-topics", (context) => {
	const database = new NewsDatabase();
	try {
		return context.json({
			generatedAt: new Date().toISOString(),
			topics: database.listCurrentHotTopics(),
		});
	} finally {
		database.close();
	}
});
app.route("/", flue());

export default app;
