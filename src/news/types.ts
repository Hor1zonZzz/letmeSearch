export type PostType = "original" | "quote" | "reply" | "repost";
export type AccountProfile = {
	xUserId: string;
	handle: string;
	displayName: string;
	followersCount: number | null;
	rawPayload: unknown;
};

export type NormalizedPost = {
	xPostId: string;
	author: AccountProfile;
	postType: PostType;
	content: string;
	publishedAt: string;
	observedAt: string;
	tweetUrl: string;
	quotedXPostId: string | null;
	quotedPost: Record<string, unknown> | null;
	urls: string[];
	mediaUrls: string[];
	rawPayload: unknown;
};

export type MonitoredAccount = {
	id: string;
	xUserId: string | null;
	handle: string;
	displayName: string | null;
	organization: string;
	monitoringStatus: "pending" | "active" | "error" | "disabled";
	lastSeenPostAt: string | null;
	ingestBoundaryPostAt: string | null;
};

export type StoredPost = {
	id: string;
	xPostId: string;
	accountId: string;
	postType: PostType;
	content: string;
	publishedAt: string;
	observedAt: string;
	tweetUrl: string;
	quotedXPostId: string | null;
	quotedPost: Record<string, unknown> | null;
};

type TriageDecision = "important" | "ignore";
type TriageDomain =
	| "ai_technology"
	| "ai_policy"
	| "politics"
	| "finance"
	| "general_technology"
	| "other";
export type TopicType =
	| "model_release"
	| "product_release"
	| "product_update"
	| "open_source"
	| "research"
	| "partnership"
	| "funding"
	| "acquisition"
	| "ai_policy"
	| "correction"
	| "shutdown"
	| "other";

export type TopicCandidate = {
	titleZh: string;
	titleEn: string;
	summaryZh: string;
	summaryEn: string;
	type: TopicType;
};

export type PostForTriage = StoredPost & {
	accountHandle: string;
	accountDisplayName: string | null;
	rawPayload: Record<string, unknown>;
	articleTitle: string | null;
	articlePreview: string | null;
	articleText: string | null;
};

export type PostTopicAnalysis = {
	postId: string;
	decision: TriageDecision;
	isImportant: boolean;
	domain: TriageDomain;
	organizationIds: string[];
	unknownOrganizationCandidates: string[];
	topicCandidate: TopicCandidate | null;
	reason: string;
	confidence: number;
};

export type PendingTopicResolution = {
	postId: string;
	xPostId: string;
	accountId: string;
	accountHandle: string;
	postType: PostType;
	content: string;
	publishedAt: string;
	quotedXPostId: string | null;
	quotedPost: Record<string, unknown> | null;
	rawPayload: Record<string, unknown>;
	articleTitle: string | null;
	articleText: string | null;
	organizationIds: string[];
	unknownOrganizationCandidates: string[];
	topicCandidate: TopicCandidate;
	attemptCount: number;
	resolutionVersion: number;
};

export type TopicResolutionBatchPost = PendingTopicResolution & {
	postRef: string;
};

type TopicSearchSourcePost = {
	xPostId: string;
	publishedAt: string;
	publisherHandle: string;
	content: string;
	rawPayload: Record<string, unknown>;
};

export type TopicSearchDocument = NewsTopic & {
	sourcePosts: TopicSearchSourcePost[];
};

export type NewsTopic = TopicCandidate & {
	id: string;
	status: "active" | "archived";
	revision: number;
	organizationIds: string[];
	firstSeenAt: string;
	lastUpdatedAt: string;
};

export type TopicHeatState =
	| "tracking"
	| "ranked"
	| "cooling"
	| "unranked"
	| "stopped";

export type TweetMetrics = {
	xPostId: string;
	views: number;
	likes: number;
	reposts: number;
	replies: number;
	quotes: number;
};

export type PostMetricSnapshotInput = {
	postId: string;
	views: number;
	likes: number;
	reposts: number;
	replies: number;
	quotes: number;
};

export type PostForMetricRefresh = {
	postId: string;
	xPostId: string;
};

export type TopicMetricPost = {
	topicId: string;
	postId: string;
	publishedAt: string;
	views: number | null;
	metricObservedAt: string | null;
	followersCount: number | null;
};

export type PreviousTopicMetric = {
	topicId: string;
	observedAt: string;
	effectiveViews: number;
};

export type PreviousTopicBreakoutMetric = {
	topicId: string;
	observedAt: string;
	effectiveReachRatio: number;
};

export type StoredTopicHeatState = {
	topicId: string;
	state: TopicHeatState;
	lowHeatStreak: number;
	lowGrowthStreak: number;
};

export type CurrentHotTopic = {
	topicId: string;
	titleZh: string;
	titleEn: string;
	effectiveViews: number;
	velocityPerHour: number;
	heat: number;
	state: "ranked" | "cooling";
	rank: number;
};

export type CurrentBreakoutTopic = {
	topicId: string;
	titleZh: string;
	titleEn: string;
	effectiveViews: number;
	effectiveReachRatio: number;
	reachVelocityPerHour: number;
	breakoutHeat: number;
	rank: number;
};

export type TopicMetricResultInput = {
	topicId: string;
	observedAt: string;
	effectiveViews: number;
	velocityPerHour: number;
	growthRate: number | null;
	viewScore: number;
	velocityScore: number;
	heat: number;
	effectiveReachRatio: number | null;
	reachVelocityPerHour: number | null;
	reachScore: number | null;
	reachVelocityScore: number | null;
	breakoutHeat: number | null;
	state: TopicHeatState;
	rank: number | null;
	lowHeatStreak: number;
	lowGrowthStreak: number;
	stoppedAt: string | null;
};
