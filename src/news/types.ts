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

export type NewsTopic = TopicCandidate & {
	id: string;
	status: "active" | "archived";
	organizationIds: string[];
	firstSeenAt: string;
	lastUpdatedAt: string;
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
