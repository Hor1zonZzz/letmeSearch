import { defineWorkflow } from '@flue/runtime';
import * as v from 'valibot';
import agent from '../agents/hello-world';

// Schema 会在 Workflow 开始前验证调用者传入的数据。
const inputSchema = v.object({
	text: v.pipe(v.string(), v.minLength(1, 'text 不能为空')),
});

// 同一个 Schema 同时约束模型的结构化回答和 Workflow 的最终输出。
const outputSchema = v.object({
	summary: v.string(),
	keyPoints: v.array(v.string()),
});

export default defineWorkflow({
	// Workflow 负责有限任务，Agent 提供模型和行为配置。
	agent,
	input: inputSchema,
	output: outputSchema,

	async run({ harness, input }) {
		// 每次 Workflow 调用都是一个独立 run，并拥有独立会话。
		const session = await harness.session();

		const { data } = await session.prompt(
			`请总结以下文本，并提取 2 到 4 个要点：\n\n${input.text}`,
			{ result: outputSchema },
		);

		// 返回值会再次通过 outputSchema 验证并成为本次 run 的结果。
		return data;
	},
});
