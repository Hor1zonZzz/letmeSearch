import { describe, expect, it } from "vitest";
import { validateToolTopicResolution } from "../../src/news/topic-resolution";
import type { TopicSearchToolSession } from "../../src/tools/search-active-topics";

function searchSession(options: {
	topicId?: string;
	revision?: number;
	truncated?: boolean;
} = {}): TopicSearchToolSession {
	const topicId = options.topicId ?? "topic-1";
	const revision = options.revision ?? 2;
	return {
		tool: null as unknown as TopicSearchToolSession["tool"],
		trace: [{
			searchId: "search-1",
			input: {
				focus: null,
				strategy: "balanced",
				detail: "compact",
				limit: 5,
				cursor: null,
			},
			matches: [{ topicId, revision }],
			truncated: options.truncated ?? false,
			contextBudgetExhausted: false,
		}],
		wasTopicReturned: (candidateId, candidateRevision) =>
			candidateId === topicId && candidateRevision === revision,
		hadSuccessfulSearch: () => true,
		wasSearchSuccessful: (searchId) => searchId === "search-1",
	};
}

describe("tool Topic resolution validation", () => {
	it("accepts only Topic revisions returned by the bound search", () => {
		const search = searchSession();

		expect(validateToolTopicResolution({
			decision: "attach",
			topicId: "topic-1",
			expectedRevision: 2,
			searchId: "search-1",
			confidence: 0.9,
			reason: "Same event",
		}, search)).toMatchObject({ decision: "attach", topicId: "topic-1" });
		expect(() => validateToolTopicResolution({
			decision: "attach",
			topicId: "invented",
			expectedRevision: 2,
			searchId: "search-1",
			confidence: 0.9,
			reason: "Same event",
		}, search)).toThrow("not returned by search");
	});

	it("defers low-confidence or incompletely searched creation", () => {
		expect(validateToolTopicResolution({
			decision: "create",
			successfulSearchIds: ["search-1"],
			confidence: 0.5,
			reason: "No match",
		}, searchSession())).toMatchObject({
			decision: "defer",
			reasonCode: "low_confidence",
		});
		expect(validateToolTopicResolution({
			decision: "create",
			successfulSearchIds: ["search-1"],
			confidence: 0.9,
			reason: "No match",
		}, searchSession({ truncated: true }))).toMatchObject({
			decision: "defer",
			reasonCode: "budget_exhausted",
		});
	});
});
