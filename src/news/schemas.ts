import * as v from "valibot";
import { ORGANIZATION_IDS } from "./organizations";

const boundedText = (minimum: number, maximum: number) =>
	v.pipe(v.string(), v.minLength(minimum), v.maxLength(maximum));

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

export const topicBatchCompletionSchema = v.object({
	completed: v.literal(true),
});

export type StructuredTopicPostAnalysis = v.InferOutput<
	typeof topicPostAnalysisSchema
>;
