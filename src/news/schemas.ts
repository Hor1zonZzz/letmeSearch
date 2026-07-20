import * as v from 'valibot';

const boundedText = (minimum: number, maximum: number) =>
	v.pipe(v.string(), v.minLength(minimum), v.maxLength(maximum));

export const postAnalysisSchema = v.object({
	postId: boundedText(1, 100),
	isImportant: v.boolean(),
	category: v.picklist(['ai_tech', 'ai_funding', 'other']),
	organization: v.pipe(v.string(), v.maxLength(120)),
	subject: v.pipe(v.string(), v.maxLength(200)),
	action: v.pipe(v.string(), v.maxLength(80)),
	canonicalTitle: v.pipe(v.string(), v.maxLength(200)),
	facts: v.pipe(
		v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(500))),
		v.maxLength(8),
	),
	reason: boundedText(1, 500),
});

export const postAnalysisBatchSchema = v.object({
	analyses: v.pipe(v.array(postAnalysisSchema), v.maxLength(100)),
});

export const reportDraftSchema = v.object({
	headline: boundedText(1, 200),
	summary: boundedText(1, 2_000),
	keyFacts: v.pipe(
		v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(500))),
		v.minLength(1),
		v.maxLength(8),
	),
	changeSummary: boundedText(1, 300),
});

export type PostAnalysis = v.InferOutput<typeof postAnalysisSchema>;
export type PostAnalysisBatch = v.InferOutput<typeof postAnalysisBatchSchema>;
export type StructuredReportDraft = v.InferOutput<typeof reportDraftSchema>;
