import type { StructuredToolTopicResolution } from "./schemas";
import type { TopicSearchToolSession } from "../tools/search-active-topics";

export type ValidatedTopicResolution =
	| {
			decision: "attach";
			topicId: string;
			expectedRevision: number;
			confidence: number;
			reason: string;
	  }
	| {
			decision: "create";
			confidence: number;
			reason: string;
	  }
	| {
			decision: "defer";
			reasonCode:
				| "search_failed"
				| "ambiguous"
				| "budget_exhausted"
				| "low_confidence";
			confidence: number;
			reason: string;
	  };

export function validateToolTopicResolution(
	result: StructuredToolTopicResolution,
	search: TopicSearchToolSession,
): ValidatedTopicResolution {
	if (result.decision === "defer") return result;
	if (result.confidence < 0.7) {
		return {
			decision: "defer",
			reasonCode: "low_confidence",
			confidence: result.confidence,
			reason: result.reason,
		};
	}
	if (!search.hadSuccessfulSearch()) {
		throw new Error("Topic resolution requires at least one successful search");
	}
	if (result.decision === "attach") {
		if (!search.wasSearchSuccessful(result.searchId)) {
			throw new Error(`Attach references unknown searchId: ${result.searchId}`);
		}
		if (!search.wasTopicReturned(result.topicId, result.expectedRevision)) {
			throw new Error(`Attach references a Topic revision not returned by search: ${result.topicId}`);
		}
		return {
			decision: "attach",
			topicId: result.topicId,
			expectedRevision: result.expectedRevision,
			confidence: result.confidence,
			reason: result.reason,
		};
	}
	for (const searchId of result.successfulSearchIds) {
		if (!search.wasSearchSuccessful(searchId)) {
			throw new Error(`Create references unknown searchId: ${searchId}`);
		}
	}
	const completeSearch = search.trace.some(
		(entry) =>
			result.successfulSearchIds.includes(entry.searchId) &&
			!entry.truncated &&
			!entry.contextBudgetExhausted,
	);
	if (!completeSearch) {
		return {
			decision: "defer",
			reasonCode: "budget_exhausted",
			confidence: result.confidence,
			reason: "Topic search remained truncated or exhausted its context budget",
		};
	}
	return {
		decision: "create",
		confidence: result.confidence,
		reason: result.reason,
	};
}
