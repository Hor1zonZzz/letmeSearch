export type PostType = "original" | "quote" | "reply" | "repost";
export type ProcessingStatus = "pending" | "ignored" | "processed" | "failed";
export type EventCategory = "ai_tech" | "ai_funding";

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
	eventId: string | null;
	postType: PostType;
	content: string;
	publishedAt: string;
	observedAt: string;
	tweetUrl: string;
	quotedXPostId: string | null;
	quotedPost: Record<string, unknown> | null;
	processingStatus: ProcessingStatus;
};

export type PostForAnalysis = StoredPost & {
	accountHandle: string;
	accountOrganization: string;
};

export type TriageDecision = "important" | "observe" | "ignore";
export type TriageDomain =
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

export type TopicResolutionStatus =
	| "pending"
	| "resolved"
	| "deferred"
	| "failed";

export type PendingTopicResolution = {
	postId: string;
	xPostId: string;
	publishedAt: string;
	quotedXPostId: string | null;
	rawPayload: Record<string, unknown>;
	organizationIds: string[];
	unknownOrganizationCandidates: string[];
	topicCandidate: TopicCandidate;
	attemptCount: number;
	resolutionVersion: number;
};

export type TopicSearchSourcePost = {
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
};

export type PreviousTopicMetric = {
	topicId: string;
	observedAt: string;
	effectiveViews: number;
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

export type TopicMetricResultInput = {
	topicId: string;
	observedAt: string;
	effectiveViews: number;
	velocityPerHour: number;
	growthRate: number | null;
	viewScore: number;
	velocityScore: number;
	heat: number;
	state: TopicHeatState;
	rank: number | null;
	lowHeatStreak: number;
	lowGrowthStreak: number;
	stoppedAt: string | null;
};

export type EventFact = {
	text: string;
	sourcePostIds: string[];
};

export type NewsEvent = {
	id: string;
	category: EventCategory;
	canonicalTitle: string;
	organization: string;
	subject: string;
	action: string;
	eventFingerprint: string;
	facts: EventFact[];
	status: "active" | "updated" | "archived";
	firstSeenAt: string;
	lastUpdatedAt: string;
	currentReportVersion: number;
	lockVersion: number;
};

export type EventSourcePost = {
	id: string;
	xPostId: string;
	handle: string;
	content: string;
	publishedAt: string;
	tweetUrl: string;
};

export type ReportDraft = {
	headline: string;
	summary: string;
	keyFacts: string[];
	changeSummary: string;
};
