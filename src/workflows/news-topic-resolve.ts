import { defineWorkflow } from "@flue/runtime";
import * as v from "valibot";
import agent from "../agents/topic-resolver";
import { NewsDatabase } from "../news/database";
import { toolTopicResolutionPrompt } from "../news/topic-resolution-prompt";
import { runTopicResolutionBacklog } from "../news/topic-resolution-pipeline";
import { toolTopicResolutionSchema } from "../news/schemas";
import { buildTopicSearchSubject } from "../news/topic-search";

const inputSchema = v.object({
	batchSize: v.optional(
		v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(500)),
	),
});

const outputSchema = v.object({
	postsAttempted: v.number(),
	postsResolved: v.number(),
	topicsCreated: v.number(),
	postsAttachedToTopics: v.number(),
	postsDeferred: v.number(),
	postsFailed: v.number(),
	errors: v.array(v.object({ scope: v.string(), message: v.string() })),
});

export default defineWorkflow({
	agent,
	input: inputSchema,
	output: outputSchema,

	async run({ harness, input }) {
		const database = new NewsDatabase();
		let sessionIndex = 0;
		try {
			return await runTopicResolutionBacklog({
				database,
				batchSize: input.batchSize ?? 100,
				requester: async ({ pending, search }) => {
					sessionIndex += 1;
					const sessionName = `topic-resolution-${sessionIndex}-${pending.xPostId}`;
					const session = await harness.session(sessionName);
					const { data } = await session.prompt(
						toolTopicResolutionPrompt(buildTopicSearchSubject(pending)),
						{
							result: toolTopicResolutionSchema,
							tools: [search.tool],
						},
					);
					return { result: data, modelRunId: sessionName };
				},
			});
		} finally {
			database.close();
		}
	},
});
