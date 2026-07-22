import { randomUUID } from "node:crypto";
import type { NewsDatabase } from "./database";
import { calculateTopicBreakoutHeat, calculateTopicHeat } from "./heat";
import type {
	CurrentBreakoutTopic,
	CurrentHotTopic,
	PostMetricSnapshotInput,
	StoredTopicHeatState,
	TopicHeatState,
	TopicMetricResultInput,
	TweetMetrics,
} from "./types";

export type TweetMetricsClient = {
	fetchTweetMetrics(xPostIds: string[]): Promise<TweetMetrics[]>;
};

export type TopicMetricsResult = {
	topicId: string;
	effectiveViews: number;
	velocityPerHour: number;
	growthRate: number | null;
	heat: number;
	effectiveReachRatio: number | null;
	reachVelocityPerHour: number | null;
	breakoutHeat: number | null;
	state: TopicHeatState;
	rank: number | null;
};

export type MetricsRefreshStats = {
	postsAttempted: number;
	snapshotsSaved: number;
	topicsCalculated: number;
	stoppedTopics: number;
	hotTopics: CurrentHotTopic[];
	breakoutTopics: CurrentBreakoutTopic[];
	topics: TopicMetricsResult[];
	errors: Array<{ scope: string; message: string }>;
};

function errorMessage(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function effectiveViews(views: number[]): number {
	if (views.length === 0) return 0;
	const highest = Math.max(...views);
	return (
		highest + (views.reduce((sum, value) => sum + value, 0) - highest) * 0.3
	);
}

function currentState(
	previous: StoredTopicHeatState | undefined,
	input: {
		effectiveViews: number;
		heat: number;
		growthRate: number | null;
		allPostsExpired: boolean;
		now: string;
	},
): Pick<
	TopicMetricResultInput,
	"state" | "lowHeatStreak" | "lowGrowthStreak" | "stoppedAt"
> {
	let state = previous?.state ?? "tracking";
	let lowHeatStreak = previous?.lowHeatStreak ?? 0;
	let lowGrowthStreak = previous?.lowGrowthStreak ?? 0;
	if (input.growthRate !== null) {
		lowGrowthStreak = input.growthRate < 0.05 ? lowGrowthStreak + 1 : 0;
	}
	if (input.allPostsExpired || lowGrowthStreak >= 2) {
		return {
			state: "stopped",
			lowHeatStreak,
			lowGrowthStreak,
			stoppedAt: input.now,
		};
	}
	const eligible = input.effectiveViews >= 1_000_000;
	if (state === "ranked" || state === "cooling") {
		lowHeatStreak = input.heat < 0.35 ? lowHeatStreak + 1 : 0;
		state =
			lowHeatStreak >= 2
				? "unranked"
				: lowHeatStreak === 1
					? "cooling"
					: "ranked";
	} else if (state === "unranked") {
		if (eligible && input.heat >= 0.35) {
			state = "ranked";
			lowHeatStreak = 0;
		}
	} else if (eligible) {
		state = "ranked";
		lowHeatStreak = 0;
	}
	return { state, lowHeatStreak, lowGrowthStreak, stoppedAt: null };
}

function validMetric(value: number, name: string, xPostId: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`Invalid ${name} for X post ${xPostId}`);
	}
	return value;
}

export async function runMetricsRefresh(options: {
	database: NewsDatabase;
	client: TweetMetricsClient;
	now?: () => Date;
	batchSize?: number;
}): Promise<MetricsRefreshStats> {
	const now = options.now ?? (() => new Date());
	const observedAt = now().toISOString();
	const batchSize = options.batchSize ?? 50;
	if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50) {
		throw new Error("metrics batchSize must be an integer between 1 and 50");
	}
	const owner = randomUUID();
	const acquired = options.database.acquireJobLock({
		name: "metrics-refresh",
		owner,
		now: observedAt,
		expiresAt: new Date(
			new Date(observedAt).getTime() + 60 * 60 * 1_000,
		).toISOString(),
	});
	if (!acquired)
		throw new Error("Another metrics-refresh job is already running");
	try {
		const posts = options.database.listPostsForMetricRefresh();
		const byXPostId = new Map(posts.map((post) => [post.xPostId, post]));
		const snapshots: PostMetricSnapshotInput[] = [];
		const errors: MetricsRefreshStats["errors"] = [];
		for (let index = 0; index < posts.length; index += batchSize) {
			const batch = posts.slice(index, index + batchSize);
			try {
				const metrics = await options.client.fetchTweetMetrics(
					batch.map(({ xPostId }) => xPostId),
				);
				const returned = new Set<string>();
				for (const metric of metrics) {
					const post = byXPostId.get(metric.xPostId);
					if (!post || returned.has(metric.xPostId)) continue;
					returned.add(metric.xPostId);
					try {
						snapshots.push({
							postId: post.postId,
							views: validMetric(metric.views, "views", metric.xPostId),
							likes: validMetric(metric.likes, "likes", metric.xPostId),
							reposts: validMetric(metric.reposts, "reposts", metric.xPostId),
							replies: validMetric(metric.replies, "replies", metric.xPostId),
							quotes: validMetric(metric.quotes, "quotes", metric.xPostId),
						});
					} catch (error) {
						errors.push({
							scope: `metrics:${metric.xPostId}`,
							message: errorMessage(error),
						});
					}
				}
				for (const post of batch) {
					if (!returned.has(post.xPostId)) {
						errors.push({
							scope: `metrics:${post.xPostId}`,
							message: "TwitterAPI.io omitted the requested post",
						});
					}
				}
			} catch (error) {
				const message = errorMessage(error);
				for (const post of batch)
					errors.push({ scope: `metrics:${post.xPostId}`, message });
			}
		}
		options.database.savePostMetricSnapshots(snapshots, observedAt);
		const postsByTopic = Map.groupBy(
			options.database.listTopicMetricPosts(),
			(post) => post.topicId,
		);
		const previousMetrics = new Map(
			options.database
				.listPreviousTopicMetrics()
				.map((metric) => [metric.topicId, metric]),
		);
		const previousBreakoutMetrics = new Map(
			options.database
				.listPreviousTopicBreakoutMetrics()
				.map((metric) => [metric.topicId, metric]),
		);
		const previousStates = new Map(
			options.database
				.listTopicHeatStates()
				.map((state) => [state.topicId, state]),
		);
		const nowMs = new Date(observedAt).getTime();
		const aggregates = [...postsByTopic.entries()]
			.filter(
				([, topicPosts]) =>
					topicPosts.some(({ views }) => views !== null) &&
					topicPosts.some((post) => post.metricObservedAt === observedAt),
			)
			.map(([topicId, topicPosts]) => {
				const effective = effectiveViews(
					topicPosts.flatMap(({ views }) => (views === null ? [] : [views])),
				);
				const reachRatios = topicPosts.flatMap(({ followersCount, views }) =>
					views !== null && followersCount !== null && followersCount > 0
						? [views / followersCount]
						: [],
				);
				const effectiveReachRatio =
					reachRatios.length > 0 ? effectiveViews(reachRatios) : null;
				const allPostsRefreshed = topicPosts.every(
					(post) => post.metricObservedAt === observedAt,
				);
				const previous = previousMetrics.get(topicId);
				const elapsedHours = previous
					? Math.max(
							(nowMs - new Date(previous.observedAt).getTime()) / 3_600_000,
							0,
						)
					: 0;
				const gained = previous
					? Math.max(effective - previous.effectiveViews, 0)
					: 0;
				const previousBreakout = previousBreakoutMetrics.get(topicId);
				const reachElapsedHours = previousBreakout
					? Math.max(
							(nowMs - new Date(previousBreakout.observedAt).getTime()) /
								3_600_000,
							0,
						)
					: 0;
				const reachGained =
					effectiveReachRatio !== null && previousBreakout
						? Math.max(
								effectiveReachRatio - previousBreakout.effectiveReachRatio,
								0,
							)
						: 0;
				return {
					topicId,
					effectiveViews: effective,
					velocityPerHour: elapsedHours > 0 ? gained / elapsedHours : 0,
					growthRate:
						previous && previous.effectiveViews > 0 && allPostsRefreshed
							? gained / previous.effectiveViews
							: null,
					effectiveReachRatio,
					reachVelocityPerHour:
						effectiveReachRatio === null
							? null
							: reachElapsedHours > 0
								? reachGained / reachElapsedHours
								: 0,
					allPostsExpired: topicPosts.every(
						(post) =>
							nowMs - new Date(post.publishedAt).getTime() >=
							72 * 60 * 60 * 1_000,
					),
				};
			});
		const scores = new Map(
			calculateTopicHeat(aggregates).map((score) => [score.topicId, score]),
		);
		const breakoutScores = new Map(
			calculateTopicBreakoutHeat(
				aggregates.flatMap((aggregate) =>
					aggregate.effectiveReachRatio !== null &&
					aggregate.reachVelocityPerHour !== null
						? [
								{
									topicId: aggregate.topicId,
									effectiveReachRatio: aggregate.effectiveReachRatio,
									reachVelocityPerHour: aggregate.reachVelocityPerHour,
								},
							]
						: [],
				),
			).map((score) => [score.topicId, score]),
		);
		const results: TopicMetricResultInput[] = aggregates.map((aggregate) => {
			const score = scores.get(aggregate.topicId);
			if (!score)
				throw new Error(`Missing heat score for topic ${aggregate.topicId}`);
			const breakoutScore = breakoutScores.get(aggregate.topicId);
			const transition = currentState(previousStates.get(aggregate.topicId), {
				effectiveViews: aggregate.effectiveViews,
				heat: score.heat,
				growthRate: aggregate.growthRate,
				allPostsExpired: aggregate.allPostsExpired,
				now: observedAt,
			});
			return {
				topicId: aggregate.topicId,
				observedAt,
				effectiveViews: aggregate.effectiveViews,
				velocityPerHour: aggregate.velocityPerHour,
				growthRate: aggregate.growthRate,
				viewScore: score.viewScore,
				velocityScore: score.velocityScore,
				heat: score.heat,
				effectiveReachRatio: aggregate.effectiveReachRatio,
				reachVelocityPerHour: aggregate.reachVelocityPerHour,
				reachScore: breakoutScore?.reachScore ?? null,
				reachVelocityScore: breakoutScore?.reachVelocityScore ?? null,
				breakoutHeat: breakoutScore?.breakoutHeat ?? null,
				state: transition.state,
				rank: null,
				lowHeatStreak: transition.lowHeatStreak,
				lowGrowthStreak: transition.lowGrowthStreak,
				stoppedAt: transition.stoppedAt,
			};
		});
		const ranked = results
			.filter(({ state }) => state === "ranked" || state === "cooling")
			.sort(
				(left, right) =>
					right.heat - left.heat || right.effectiveViews - left.effectiveViews,
			);
		for (const [index, result] of ranked.entries()) result.rank = index + 1;
		options.database.saveTopicMetricResults(results);
		return {
			postsAttempted: posts.length,
			snapshotsSaved: snapshots.length,
			topicsCalculated: results.length,
			stoppedTopics: results.filter(({ state }) => state === "stopped").length,
			hotTopics: options.database.listCurrentHotTopics(),
			breakoutTopics: options.database.listCurrentBreakoutTopics(),
			topics: results.map((result) => ({
				topicId: result.topicId,
				effectiveViews: result.effectiveViews,
				velocityPerHour: result.velocityPerHour,
				growthRate: result.growthRate,
				heat: result.heat,
				effectiveReachRatio: result.effectiveReachRatio,
				reachVelocityPerHour: result.reachVelocityPerHour,
				breakoutHeat: result.breakoutHeat,
				state: result.state,
				rank: result.rank,
			})),
			errors,
		};
	} finally {
		options.database.releaseJobLock("metrics-refresh", owner);
	}
}
