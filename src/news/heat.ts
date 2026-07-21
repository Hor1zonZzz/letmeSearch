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

export function calculateTopicHeat(inputs: TopicHeatInput[]): TopicHeatScore[] {
	const ids = new Set<string>();
	for (const input of inputs) {
		if (ids.has(input.topicId))
			throw new Error(`Duplicate topicId: ${input.topicId}`);
		ids.add(input.topicId);
		if (!Number.isFinite(input.effectiveViews) || input.effectiveViews < 0) {
			throw new Error(`Invalid effective views for topic ${input.topicId}`);
		}
		if (!Number.isFinite(input.velocityPerHour) || input.velocityPerHour < 0) {
			throw new Error(`Invalid velocity for topic ${input.topicId}`);
		}
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
