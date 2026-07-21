import { describe, expect, it } from "vitest";
import { calculateTopicHeat } from "../../src/news/heat";

describe("topic heat calculation", () => {
	it("combines logarithmic view and velocity percentiles with equal weight", () => {
		const scores = calculateTopicHeat([
			{
				topicId: "leader",
				effectiveViews: 10_000_000,
				velocityPerHour: 500_000,
			},
			{
				topicId: "middle",
				effectiveViews: 2_000_000,
				velocityPerHour: 100_000,
			},
			{
				topicId: "trailer",
				effectiveViews: 1_000_000,
				velocityPerHour: 10_000,
			},
		]);

		expect(scores).toEqual([
			{ topicId: "leader", viewScore: 1, velocityScore: 1, heat: 1 },
			{ topicId: "middle", viewScore: 0.5, velocityScore: 0.5, heat: 0.5 },
			{ topicId: "trailer", viewScore: 0, velocityScore: 0, heat: 0 },
		]);
	});

	it("gives tied values the same average percentile", () => {
		const scores = calculateTopicHeat([
			{ topicId: "a", effectiveViews: 1_000_000, velocityPerHour: 20_000 },
			{ topicId: "b", effectiveViews: 1_000_000, velocityPerHour: 20_000 },
			{ topicId: "c", effectiveViews: 100_000, velocityPerHour: 0 },
		]);

		expect(scores).toEqual([
			{ topicId: "a", viewScore: 0.75, velocityScore: 0.75, heat: 0.75 },
			{ topicId: "b", viewScore: 0.75, velocityScore: 0.75, heat: 0.75 },
			{ topicId: "c", viewScore: 0, velocityScore: 0, heat: 0 },
		]);
	});
});
