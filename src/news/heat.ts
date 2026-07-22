export type TopicHeatInput = {
	topicId: string;
	effectiveViews: number;
	velocityPerHour: number;
};

export type TopicHeatScore = {
	topicId: string;
	viewScore: number;
	velocityScore: number;
	heat: number;
};

export type TopicBreakoutHeatInput = {
	topicId: string;
	effectiveReachRatio: number;
	reachVelocityPerHour: number;
};

export type TopicBreakoutHeatScore = {
	topicId: string;
	reachScore: number;
	reachVelocityScore: number;
	breakoutHeat: number;
};

function percentiles(values: number[]): number[] {
	if (values.length === 1) return [1];
	const sorted = values
		.map((value, index) => ({ value, index }))
		.sort((left, right) => left.value - right.value);
	const result = new Array<number>(values.length);
	let start = 0;
	while (start < sorted.length) {
		let end = start;
		while (
			end + 1 < sorted.length &&
			sorted[end + 1]?.value === sorted[start]?.value
		) {
			end += 1;
		}
		const percentile = (start + end) / 2 / (sorted.length - 1);
		for (let index = start; index <= end; index += 1) {
			const item = sorted[index];
			if (item) result[item.index] = percentile;
		}
		start = end + 1;
	}
	return result;
}

function assertMetric(value: number, name: string, topicId: string): void {
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`Invalid ${name} for topic ${topicId}`);
	}
}

function assertUniqueTopicIds(inputs: Array<{ topicId: string }>): void {
	const ids = new Set<string>();
	for (const input of inputs) {
		if (ids.has(input.topicId))
			throw new Error(`Duplicate topicId: ${input.topicId}`);
		ids.add(input.topicId);
	}
}

export function calculateTopicHeat(inputs: TopicHeatInput[]): TopicHeatScore[] {
	assertUniqueTopicIds(inputs);
	for (const input of inputs) {
		assertMetric(input.effectiveViews, "effective views", input.topicId);
		assertMetric(input.velocityPerHour, "velocity", input.topicId);
	}
	const viewScores = percentiles(
		inputs.map(({ effectiveViews }) => Math.log1p(effectiveViews)),
	);
	const velocityScores = percentiles(
		inputs.map(({ velocityPerHour }) => Math.log1p(velocityPerHour)),
	);
	return inputs.map((input, index) => {
		const viewScore = viewScores[index] ?? 0;
		const velocityScore = velocityScores[index] ?? 0;
		return {
			topicId: input.topicId,
			viewScore,
			velocityScore,
			heat: viewScore * 0.5 + velocityScore * 0.5,
		};
	});
}

export function calculateTopicBreakoutHeat(
	inputs: TopicBreakoutHeatInput[],
): TopicBreakoutHeatScore[] {
	assertUniqueTopicIds(inputs);
	for (const input of inputs) {
		assertMetric(
			input.effectiveReachRatio,
			"effective reach ratio",
			input.topicId,
		);
		assertMetric(input.reachVelocityPerHour, "reach velocity", input.topicId);
	}
	const reachScores = percentiles(
		inputs.map(({ effectiveReachRatio }) => Math.log1p(effectiveReachRatio)),
	);
	const reachVelocityScores = percentiles(
		inputs.map(({ reachVelocityPerHour }) => Math.log1p(reachVelocityPerHour)),
	);
	return inputs.map((input, index) => {
		const reachScore = reachScores[index] ?? 0;
		const reachVelocityScore = reachVelocityScores[index] ?? 0;
		return {
			topicId: input.topicId,
			reachScore,
			reachVelocityScore,
			breakoutHeat: reachScore * 0.5 + reachVelocityScore * 0.5,
		};
	});
}
