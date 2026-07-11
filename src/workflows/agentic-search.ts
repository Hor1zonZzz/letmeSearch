import { defineWorkflow, type WorkflowRouteHandler } from '@flue/runtime';
import * as v from 'valibot';
import agent from '../agents/web-researcher';
import { webFetch } from '../tools/web-fetch';
import { createWebSearch } from '../tools/web-search';

const inputSchema = v.object({
	query: v.pipe(v.string(), v.minLength(2), v.maxLength(2_000)),
});

const outputSchema = v.object({
	answer: v.string(),
	sources: v.array(v.object({
		title: v.string(),
		url: v.pipe(v.string(), v.url()),
	})),
});

// Exporting route exposes this workflow through Flue's HTTP workflow endpoint.
export const route: WorkflowRouteHandler = async (_context, next) => next();

export default defineWorkflow({
	agent,
	input: inputSchema,
	output: outputSchema,

	async run({ harness, input }) {
		const session = await harness.session();
		const webSearch = createWebSearch({ seenUrls: new Set<string>() });
		const { data } = await session.prompt(
			`Research and answer this query:\n\n${input.query}\n\nUse web_search and web_fetch as needed. Return an evidence-based answer and only the sources you actually used.`,
			{ result: outputSchema, tools: [webSearch, webFetch] },
		);
		return data;
	},
});
