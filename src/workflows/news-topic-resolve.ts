import { defineWorkflow } from "@flue/runtime";
import * as v from "valibot";
import agent from "../agents/topic-resolver";
import { NewsDatabase } from "../news/database";
import { resolveTopicCandidate } from "../news/topic-classifier";
import { toolTopicResolutionPrompt } from "../news/topic-resolution-prompt";
import { runTopicResolutionBacklog } from "../news/topic-resolution-pipeline";
import { toolTopicResolutionSchema } from "../news/schemas";
import { buildTopicSearchSubject } from "../news/topic-search";

const inputSchema = v.object({
	mode: v.optional(v.picklist(["shadow", "write"])),
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
	shadowComparisons: v.number(),
	shadowAgreements: v.number(),
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
			const configuredMode = process.env.NEWS_TOPIC_RESOLVER_MODE?.trim();
			const mode = input.mode ?? (configuredMode === "shadow" ? "shadow" : "write");
			return await runTopicResolutionBacklog({
				database,
				mode,
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
				legacyRequester: async ({ pending, activeTopics }) => ({
					topicId: activeTopics.length === 0
						? null
						: await resolveTopicCandidate({
							candidate: pending.topicCandidate,
							organizationIds: pending.organizationIds,
							activeTopics,
						}),
					modelRunId: null,
				}),
			});
		} finally {
			database.close();
		}
	},
});
