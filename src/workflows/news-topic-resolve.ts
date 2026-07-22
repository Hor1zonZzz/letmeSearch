import { defineWorkflow } from "@flue/runtime";
import * as v from "valibot";
import agent from "../agents/topic-resolver";
import { NewsDatabase } from "../news/database";
import { topicBatchResolutionPrompt } from "../news/topic-resolution-prompt";
import { runTopicResolutionBacklog } from "../news/topic-resolution-pipeline";
import { topicBatchCompletionSchema } from "../news/schemas";

const inputSchema = v.object({
	batchSize: v.optional(
		v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(500)),
	),
	accountBatchSize: v.optional(
		v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(20)),
	),
});

const outputSchema = v.object({
	accountBatchesAttempted: v.number(),
	accountBatchesCompleted: v.number(),
	postsAttempted: v.number(),
	postsResolved: v.number(),
	topicsCreated: v.number(),
	postsAttachedToTopics: v.number(),
	postsFailed: v.number(),
	errors: v.array(v.object({ scope: v.string(), message: v.string() })),
});

export default defineWorkflow({
	agent,
	input: inputSchema,
	output: outputSchema,

	async run({ harness, input }) {
		const database = new NewsDatabase();
		try {
			return await runTopicResolutionBacklog({
				database,
				batchSize: input.batchSize ?? 500,
				accountBatchSize: input.accountBatchSize ?? 20,
				requester: async ({
					accountHandle,
					posts,
					sessionName,
					toolSession,
				}) => {
					const session = await harness.session(sessionName);
					const { data } = await session.prompt(
						topicBatchResolutionPrompt({ accountHandle, posts }),
						{
							result: topicBatchCompletionSchema,
							tools: toolSession.tools,
							signal: AbortSignal.timeout(5 * 60 * 1_000),
						},
					);
					return data;
				},
			});
		} finally {
			database.close();
		}
	},
});
