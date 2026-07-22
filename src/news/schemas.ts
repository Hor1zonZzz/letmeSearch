import * as v from 'valibot';
import { ORGANIZATION_IDS } from './organizations';

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

export const topicCandidateSchema = v.object({
	titleZh: boundedText(1, 200),
	titleEn: boundedText(1, 200),
	summaryZh: boundedText(1, 1_000),
	summaryEn: boundedText(1, 1_000),
	type: v.picklist([
		"model_release",
		"product_release",
		"product_update",
		"open_source",
		"research",
		"partnership",
		"funding",
		"acquisition",
		"ai_policy",
		"correction",
		"shutdown",
		"other",
	]),
});

export const topicPostAnalysisSchema = v.object({
	postRef: boundedText(1, 20),
	decision: v.picklist(["important", "ignore"]),
	domain: v.picklist([
		"ai_technology",
		"ai_policy",
		"politics",
		"finance",
		"general_technology",
		"other",
	]),
	organizationIds: v.pipe(
		v.array(v.picklist(ORGANIZATION_IDS)),
		v.maxLength(10),
	),
	unknownOrganizationCandidates: v.pipe(
		v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(120))),
		v.maxLength(10),
	),
	topicCandidate: v.nullable(topicCandidateSchema),
	reason: boundedText(1, 500),
	confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
});

export const topicPostAnalysisBatchSchema = v.object({
	analyses: v.pipe(v.array(topicPostAnalysisSchema), v.maxLength(100)),
});

export const toolTopicResolutionSchema = v.variant("decision", [
	v.object({
		decision: v.literal("attach"),
		topicId: boundedText(1, 100),
		expectedRevision: v.pipe(v.number(), v.integer(), v.minValue(0)),
		searchId: boundedText(1, 100),
		confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
		reason: boundedText(1, 300),
	}),
	v.object({
		decision: v.literal("create"),
		successfulSearchIds: v.pipe(
			v.array(boundedText(1, 100)),
			v.minLength(1),
			v.maxLength(3),
		),
		confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
		reason: boundedText(1, 300),
	}),
	v.object({
		decision: v.literal("defer"),
		reasonCode: v.picklist([
			"search_failed",
			"ambiguous",
			"budget_exhausted",
			"low_confidence",
		]),
		confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
		reason: boundedText(1, 300),
	}),
]);

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
export type StructuredTopicPostAnalysis = v.InferOutput<typeof topicPostAnalysisSchema>;
export type StructuredToolTopicResolution = v.InferOutput<
	typeof toolTopicResolutionSchema
>;
