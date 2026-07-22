import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { OrganizationId } from "./organizations";
import type {
	AccountProfile,
	CurrentHotTopic,
	EventCategory,
	EventFact,
	EventSourcePost,
	MonitoredAccount,
	NewsEvent,
	NewsTopic,
	NormalizedPost,
	PendingTopicResolution,
	PostForAnalysis,
	PostForMetricRefresh,
	PostForTriage,
	PostMetricSnapshotInput,
	PostTopicAnalysis,
	PreviousTopicMetric,
	StoredPost,
	StoredTopicHeatState,
	TopicCandidate,
	TopicMetricPost,
	TopicMetricResultInput,
	TopicSearchDocument,
	TriageDecision,
} from "./types";

type AccountSeed = {
	handle: string;
	organization: string;
};

type UpsertPostResult = {
	post: StoredPost;
	isNew: boolean;
};

export type OrganizationSeed = {
	id: OrganizationId;
	nameZh: string;
	nameEn: string;
	aliases: readonly string[];
};

export type ArticleHydrationCandidate = {
	postId: string;
	xPostId: string;
	rawPayload: Record<string, unknown>;
};

export type PostArticleInput = {
	postId: string;
	status: "available" | "not_article";
	title: string | null;
	previewText: string | null;
	fullText: string | null;
	contents: unknown[] | null;
	rawPayload: Record<string, unknown> | null;
	fetchedAt: string;
};

type ReportCommit = {
	markdown: string;
	changeSummary: string;
	eventSnapshot: unknown;
	sourcePostIds: string[];
	createdByRunId: string;
	filePath: string;
};

export type CommitEventChangeInput = {
	eventId: string;
	expectedEventId: string | null;
	expectedLockVersion: number | null;
	postId: string;
	analysis: unknown;
	category: EventCategory;
	canonicalTitle: string;
	organization: string;
	subject: string;
	action: string;
	eventFingerprint: string;
	facts: EventFact[];
	now: string;
	report: ReportCommit | null;
};

export type CommitEventChangeResult = {
	eventId: string;
	reportVersion: number | null;
	filePath: string | null;
};

export type PendingReportExport = {
	eventId: string;
	version: number;
	markdown: string;
	filePath: string;
};

type Row = Record<string, unknown>;

const migrations = [
	{
		version: 1,
		name: "initial-official-news-schema",
		sql: `
CREATE TABLE monitored_accounts (
	id TEXT PRIMARY KEY,
	x_user_id TEXT UNIQUE,
	handle TEXT NOT NULL COLLATE NOCASE UNIQUE,
	display_name TEXT,
	organization TEXT NOT NULL,
	monitoring_enabled INTEGER NOT NULL DEFAULT 1 CHECK (monitoring_enabled IN (0, 1)),
	monitoring_status TEXT NOT NULL DEFAULT 'pending' CHECK (monitoring_status IN ('pending', 'active', 'error', 'disabled')),
	followers_count INTEGER CHECK (followers_count IS NULL OR followers_count >= 0),
	last_seen_post_at TEXT,
	last_pulled_at TEXT,
	last_error TEXT,
	raw_profile_json TEXT CHECK (raw_profile_json IS NULL OR json_valid(raw_profile_json)),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE events (
	id TEXT PRIMARY KEY,
	category TEXT NOT NULL CHECK (category IN ('ai_tech', 'ai_funding')),
	canonical_title TEXT NOT NULL,
	organization TEXT NOT NULL,
	subject TEXT NOT NULL,
	action TEXT NOT NULL,
	event_fingerprint TEXT NOT NULL UNIQUE,
	facts_json TEXT NOT NULL CHECK (json_valid(facts_json) AND json_type(facts_json) = 'array'),
	status TEXT NOT NULL CHECK (status IN ('active', 'updated', 'archived')),
	first_seen_at TEXT NOT NULL,
	last_updated_at TEXT NOT NULL,
	current_report_version INTEGER NOT NULL DEFAULT 0 CHECK (current_report_version >= 0),
	lock_version INTEGER NOT NULL DEFAULT 0 CHECK (lock_version >= 0),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE posts (
	id TEXT PRIMARY KEY,
	x_post_id TEXT NOT NULL UNIQUE,
	account_id TEXT NOT NULL REFERENCES monitored_accounts(id) ON DELETE RESTRICT,
	event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
	post_type TEXT NOT NULL CHECK (post_type IN ('original', 'quote', 'reply', 'repost')),
	content TEXT NOT NULL,
	published_at TEXT NOT NULL,
	observed_at TEXT NOT NULL,
	tweet_url TEXT NOT NULL,
	quoted_x_post_id TEXT,
	quoted_post_json TEXT CHECK (quoted_post_json IS NULL OR json_valid(quoted_post_json)),
	urls_json TEXT NOT NULL CHECK (json_valid(urls_json) AND json_type(urls_json) = 'array'),
	media_json TEXT NOT NULL CHECK (json_valid(media_json) AND json_type(media_json) = 'array'),
	processing_status TEXT NOT NULL CHECK (processing_status IN ('pending', 'ignored', 'processed', 'failed')),
	analysis_json TEXT CHECK (analysis_json IS NULL OR json_valid(analysis_json)),
	analysis_version INTEGER,
	processing_error TEXT,
	analyzed_at TEXT,
	raw_payload_json TEXT NOT NULL CHECK (json_valid(raw_payload_json)),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE event_reports (
	event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
	version INTEGER NOT NULL CHECK (version > 0),
	base_report_version INTEGER NOT NULL CHECK (base_report_version >= 0),
	markdown TEXT NOT NULL,
	change_summary TEXT NOT NULL,
	event_snapshot_json TEXT NOT NULL CHECK (json_valid(event_snapshot_json)),
	source_post_ids_json TEXT NOT NULL CHECK (json_valid(source_post_ids_json) AND json_type(source_post_ids_json) = 'array'),
	created_by_run_id TEXT,
	file_path TEXT NOT NULL,
	file_synced_at TEXT,
	file_sync_error TEXT,
	created_at TEXT NOT NULL,
	PRIMARY KEY (event_id, version)
);

CREATE INDEX posts_processing_status_idx ON posts(processing_status, published_at);
CREATE INDEX posts_event_id_idx ON posts(event_id, published_at);
CREATE INDEX events_updated_idx ON events(last_updated_at DESC);
CREATE INDEX reports_unsynced_idx ON event_reports(file_synced_at) WHERE file_synced_at IS NULL;

CREATE TRIGGER event_reports_immutable_content
BEFORE UPDATE OF base_report_version, markdown, change_summary, event_snapshot_json, source_post_ids_json, created_by_run_id, created_at
ON event_reports
BEGIN
	SELECT RAISE(ABORT, 'event report content is immutable');
END;
`,
	},
	{
		version: 2,
		name: "add-ingest-boundary",
		sql: `
ALTER TABLE monitored_accounts ADD COLUMN ingest_boundary_post_at TEXT;
`,
	},
	{
		version: 3,
		name: "add-topic-triage-model",
		sql: `
CREATE TABLE organizations (
	id TEXT PRIMARY KEY,
	name_zh TEXT NOT NULL,
	name_en TEXT NOT NULL,
	aliases_json TEXT NOT NULL CHECK (json_valid(aliases_json) AND json_type(aliases_json) = 'array'),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE post_articles (
	post_id TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
	status TEXT NOT NULL CHECK (status IN ('available', 'not_article', 'failed')),
	title TEXT,
	preview_text TEXT,
	full_text TEXT,
	contents_json TEXT CHECK (contents_json IS NULL OR json_valid(contents_json)),
	raw_payload_json TEXT CHECK (raw_payload_json IS NULL OR json_valid(raw_payload_json)),
	error TEXT,
	fetched_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	CHECK (
		status != 'available' OR (
			full_text IS NOT NULL AND length(full_text) > 0
			AND contents_json IS NOT NULL AND json_valid(contents_json)
			AND json_type(contents_json) = 'array'
			AND raw_payload_json IS NOT NULL
		)
	)
);

CREATE TABLE post_topic_analyses (
	post_id TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
	status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
	decision TEXT CHECK (decision IS NULL OR decision IN ('important', 'observe', 'ignore')),
	is_important INTEGER CHECK (is_important IS NULL OR is_important IN (0, 1)),
	domain TEXT CHECK (domain IS NULL OR domain IN ('ai_technology', 'ai_policy', 'politics', 'finance', 'general_technology', 'other')),
	organization_ids_json TEXT CHECK (organization_ids_json IS NULL OR (json_valid(organization_ids_json) AND json_type(organization_ids_json) = 'array')),
	unknown_organizations_json TEXT CHECK (unknown_organizations_json IS NULL OR (json_valid(unknown_organizations_json) AND json_type(unknown_organizations_json) = 'array')),
	topic_candidate_json TEXT CHECK (topic_candidate_json IS NULL OR json_valid(topic_candidate_json)),
	reason TEXT,
	confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
	error TEXT,
	analysis_version INTEGER NOT NULL,
	analyzed_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	CHECK (
		status = 'failed' OR (
			decision IS NOT NULL AND is_important IS NOT NULL AND domain IS NOT NULL
			AND organization_ids_json IS NOT NULL AND unknown_organizations_json IS NOT NULL
			AND reason IS NOT NULL AND confidence IS NOT NULL
			AND is_important = CASE WHEN decision = 'important' THEN 1 ELSE 0 END
			AND ((decision = 'ignore' AND topic_candidate_json IS NULL)
				OR (decision IN ('important', 'observe') AND topic_candidate_json IS NOT NULL))
		)
	)
);

CREATE TABLE topics (
	id TEXT PRIMARY KEY,
	title_zh TEXT NOT NULL,
	title_en TEXT NOT NULL,
	summary_zh TEXT NOT NULL,
	summary_en TEXT NOT NULL,
	topic_type TEXT NOT NULL CHECK (topic_type IN ('model_release', 'product_release', 'product_update', 'open_source', 'research', 'partnership', 'funding', 'acquisition', 'ai_policy', 'correction', 'shutdown', 'other')),
	status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
	first_seen_at TEXT NOT NULL,
	last_updated_at TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE topic_organizations (
	topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
	organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
	PRIMARY KEY (topic_id, organization_id)
);

CREATE TABLE topic_posts (
	post_id TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
	topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
	decision TEXT NOT NULL CHECK (decision IN ('important', 'observe')),
	added_at TEXT NOT NULL
);

CREATE TABLE news_job_locks (
	name TEXT PRIMARY KEY,
	owner TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	acquired_at TEXT NOT NULL
);

CREATE INDEX topic_analyses_status_idx ON post_topic_analyses(status, analyzed_at);
CREATE INDEX topics_active_updated_idx ON topics(status, last_updated_at DESC);
CREATE INDEX topic_posts_topic_idx ON topic_posts(topic_id, added_at);
`,
	},
	{
		version: 4,
		name: "add-topic-metrics-and-heat",
		sql: `
CREATE TABLE post_metric_snapshots (
	post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
	observed_at TEXT NOT NULL,
	view_count INTEGER NOT NULL CHECK (view_count >= 0),
	like_count INTEGER NOT NULL CHECK (like_count >= 0),
	repost_count INTEGER NOT NULL CHECK (repost_count >= 0),
	reply_count INTEGER NOT NULL CHECK (reply_count >= 0),
	quote_count INTEGER NOT NULL CHECK (quote_count >= 0),
	PRIMARY KEY (post_id, observed_at)
);

CREATE TABLE post_metric_promotions (
	post_id TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
	promoted_at TEXT NOT NULL,
	baseline_views INTEGER NOT NULL CHECK (baseline_views >= 0),
	promotion_views INTEGER NOT NULL CHECK (promotion_views >= baseline_views),
	reason TEXT NOT NULL CHECK (reason IN ('views_250k', 'views_gained_100k'))
);

CREATE TABLE topic_metric_snapshots (
	topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
	observed_at TEXT NOT NULL,
	effective_views REAL NOT NULL CHECK (effective_views >= 0),
	velocity_per_hour REAL NOT NULL CHECK (velocity_per_hour >= 0),
	growth_rate REAL,
	view_score REAL NOT NULL CHECK (view_score >= 0 AND view_score <= 1),
	velocity_score REAL NOT NULL CHECK (velocity_score >= 0 AND velocity_score <= 1),
	heat REAL NOT NULL CHECK (heat >= 0 AND heat <= 1),
	state TEXT NOT NULL CHECK (state IN ('tracking', 'ranked', 'cooling', 'unranked', 'stopped')),
	rank INTEGER CHECK (rank IS NULL OR rank >= 1),
	PRIMARY KEY (topic_id, observed_at)
);

CREATE TABLE topic_heat_states (
	topic_id TEXT PRIMARY KEY REFERENCES topics(id) ON DELETE CASCADE,
	state TEXT NOT NULL CHECK (state IN ('tracking', 'ranked', 'cooling', 'unranked', 'stopped')),
	low_heat_streak INTEGER NOT NULL DEFAULT 0 CHECK (low_heat_streak >= 0),
	low_growth_streak INTEGER NOT NULL DEFAULT 0 CHECK (low_growth_streak >= 0),
	current_effective_views REAL NOT NULL DEFAULT 0 CHECK (current_effective_views >= 0),
	current_velocity_per_hour REAL NOT NULL DEFAULT 0 CHECK (current_velocity_per_hour >= 0),
	current_heat REAL NOT NULL DEFAULT 0 CHECK (current_heat >= 0 AND current_heat <= 1),
	current_rank INTEGER CHECK (current_rank IS NULL OR current_rank >= 1),
	stopped_at TEXT,
	updated_at TEXT NOT NULL
);

CREATE INDEX post_metric_snapshots_observed_idx
	ON post_metric_snapshots(post_id, observed_at DESC);
CREATE INDEX topic_metric_snapshots_observed_idx
	ON topic_metric_snapshots(topic_id, observed_at DESC);
CREATE INDEX topic_heat_states_rank_idx
	ON topic_heat_states(state, current_rank);
`,
	},
	{
		version: 5,
		name: "add-topic-resolution-state",
		sql: `
ALTER TABLE topics ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0);

CREATE TABLE post_topic_resolutions (
	post_id TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
	status TEXT NOT NULL CHECK (status IN ('pending', 'resolved', 'deferred', 'failed')),
	decision TEXT CHECK (decision IS NULL OR decision IN ('attach', 'create', 'defer')),
	target_topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL,
	confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
	reason TEXT,
	attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
	next_retry_at TEXT,
	error TEXT,
	resolution_version INTEGER NOT NULL,
	resolved_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	CHECK (
		(status = 'resolved' AND decision IN ('attach', 'create') AND resolved_at IS NOT NULL)
		OR (status = 'deferred' AND decision = 'defer')
		OR (status IN ('pending', 'failed') AND decision IS NULL)
	)
);

CREATE TABLE topic_resolution_events (
	id TEXT PRIMARY KEY,
	post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
	decision TEXT NOT NULL CHECK (decision IN ('attach', 'create', 'defer', 'reassign', 'merge', 'split', 'undo')),
	from_topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL,
	to_topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL,
	resolver_version INTEGER NOT NULL,
	confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
	reason TEXT NOT NULL,
	search_trace_json TEXT CHECK (search_trace_json IS NULL OR json_valid(search_trace_json)),
	model_run_id TEXT,
	created_at TEXT NOT NULL
);

CREATE INDEX post_topic_resolutions_queue_idx
	ON post_topic_resolutions(status, next_retry_at, updated_at);
CREATE INDEX topic_resolution_events_post_idx
	ON topic_resolution_events(post_id, created_at);
CREATE INDEX topic_organizations_organization_idx
	ON topic_organizations(organization_id, topic_id);
CREATE INDEX posts_published_x_post_idx ON posts(published_at, x_post_id);

INSERT INTO post_topic_resolutions(
	post_id, status, decision, target_topic_id, confidence, reason,
	attempt_count, resolution_version, resolved_at, created_at, updated_at
)
SELECT analyses.post_id, 'resolved', 'attach', topic_posts.topic_id,
	analyses.confidence, 'Backfilled from existing Topic membership',
	0, 1, analyses.analyzed_at, analyses.analyzed_at, analyses.updated_at
FROM post_topic_analyses analyses
JOIN topic_posts ON topic_posts.post_id = analyses.post_id
WHERE analyses.status = 'success';
`,
	},
	{
		version: 6,
		name: "add-topic-resolution-shadow-comparisons",
		sql: `
CREATE TABLE topic_resolution_shadow_comparisons (
	id TEXT PRIMARY KEY,
	post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
	resolver_version INTEGER NOT NULL,
	tool_decision TEXT NOT NULL CHECK (tool_decision IN ('attach', 'create', 'defer')),
	tool_topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL,
	tool_confidence REAL NOT NULL CHECK (tool_confidence >= 0 AND tool_confidence <= 1),
	tool_reason TEXT NOT NULL,
	legacy_decision TEXT NOT NULL CHECK (legacy_decision IN ('attach', 'create', 'error')),
	legacy_topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL,
	legacy_error TEXT,
	agreed INTEGER NOT NULL CHECK (agreed IN (0, 1)),
	search_trace_json TEXT NOT NULL CHECK (json_valid(search_trace_json)),
	tool_model_run_id TEXT,
	legacy_model_run_id TEXT,
	created_at TEXT NOT NULL
);

CREATE INDEX topic_resolution_shadow_post_idx
	ON topic_resolution_shadow_comparisons(post_id, resolver_version, created_at);
`,
	},
	{
		version: 7,
		name: "remove-legacy-topic-resolver-shadow-state",
		sql: `
DROP TABLE IF EXISTS topic_resolution_shadow_comparisons;
`,
	},
];

function rowString(row: Row, key: string): string {
	const value = row[key];
	if (typeof value !== "string")
		throw new Error(`Database row is missing ${key}`);
	return value;
}

function nullableString(row: Row, key: string): string | null {
	return typeof row[key] === "string" ? (row[key] as string) : null;
}

function rowNumber(row: Row, key: string): number {
	const value = row[key];
	if (typeof value !== "number")
		throw new Error(`Database row is missing numeric ${key}`);
	return value;
}

function parseJson<T>(value: unknown, fallback: T): T {
	if (typeof value !== "string") return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function mapAccount(row: Row): MonitoredAccount {
	return {
		id: rowString(row, "id"),
		xUserId: nullableString(row, "x_user_id"),
		handle: rowString(row, "handle"),
		displayName: nullableString(row, "display_name"),
		organization: rowString(row, "organization"),
		monitoringStatus: rowString(
			row,
			"monitoring_status",
		) as MonitoredAccount["monitoringStatus"],
		lastSeenPostAt: nullableString(row, "last_seen_post_at"),
		ingestBoundaryPostAt: nullableString(row, "ingest_boundary_post_at"),
	};
}

function mapPost(row: Row): StoredPost {
	return {
		id: rowString(row, "id"),
		xPostId: rowString(row, "x_post_id"),
		accountId: rowString(row, "account_id"),
		eventId: nullableString(row, "event_id"),
		postType: rowString(row, "post_type") as StoredPost["postType"],
		content: rowString(row, "content"),
		publishedAt: rowString(row, "published_at"),
		observedAt: rowString(row, "observed_at"),
		tweetUrl: rowString(row, "tweet_url"),
		quotedXPostId: nullableString(row, "quoted_x_post_id"),
		quotedPost: parseJson<Record<string, unknown> | null>(
			row.quoted_post_json,
			null,
		),
		processingStatus: rowString(
			row,
			"processing_status",
		) as StoredPost["processingStatus"],
	};
}

function mapPostForAnalysis(row: Row): PostForAnalysis {
	return {
		...mapPost(row),
		accountHandle: rowString(row, "account_handle"),
		accountOrganization: rowString(row, "account_organization"),
	};
}

function mapEvent(row: Row): NewsEvent {
	return {
		id: rowString(row, "id"),
		category: rowString(row, "category") as NewsEvent["category"],
		canonicalTitle: rowString(row, "canonical_title"),
		organization: rowString(row, "organization"),
		subject: rowString(row, "subject"),
		action: rowString(row, "action"),
		eventFingerprint: rowString(row, "event_fingerprint"),
		facts: parseJson<EventFact[]>(row.facts_json, []),
		status: rowString(row, "status") as NewsEvent["status"],
		firstSeenAt: rowString(row, "first_seen_at"),
		lastUpdatedAt: rowString(row, "last_updated_at"),
		currentReportVersion: rowNumber(row, "current_report_version"),
		lockVersion: rowNumber(row, "lock_version"),
	};
}

export class NewsDatabase {
	readonly #database: DatabaseSync;

	constructor(databasePath?: ":memory:") {
		if (databasePath === ":memory:") {
			this.#database = new DatabaseSync(":memory:", { timeout: 5_000 });
		} else {
			mkdirSync("./data", { recursive: true });
			this.#database = new DatabaseSync("./data/news.db", { timeout: 5_000 });
		}
		this.#database.exec("PRAGMA foreign_keys = ON");
		if (databasePath !== ":memory:")
			this.#database.exec("PRAGMA journal_mode = WAL");
		this.#migrate();
	}

	#migrate(): void {
		this.#database.exec(`
CREATE TABLE IF NOT EXISTS news_schema_migrations (
	version INTEGER PRIMARY KEY,
	name TEXT NOT NULL,
	applied_at TEXT NOT NULL
)`);
		const applied = new Set(
			(
				this.#database
					.prepare("SELECT version FROM news_schema_migrations")
					.all() as Row[]
			).map((row) => rowNumber(row, "version")),
		);
		for (const migration of migrations) {
			if (applied.has(migration.version)) continue;
			this.#database.exec("BEGIN IMMEDIATE");
			try {
				this.#database.exec(migration.sql);
				this.#database
					.prepare(
						"INSERT INTO news_schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
					)
					.run(migration.version, migration.name, new Date().toISOString());
				this.#database.exec("COMMIT");
			} catch (error) {
				if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
				throw error;
			}
		}
	}

	close(): void {
		this.#database.close();
	}

	acquireJobLock(input: {
		name: string;
		owner: string;
		now: string;
		expiresAt: string;
	}): boolean {
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			this.#database
				.prepare(`
DELETE FROM news_job_locks WHERE name = ? AND expires_at <= ?`)
				.run(input.name, input.now);
			const inserted = this.#database
				.prepare(`
INSERT OR IGNORE INTO news_job_locks(name, owner, expires_at, acquired_at)
VALUES (?, ?, ?, ?)`)
				.run(input.name, input.owner, input.expiresAt, input.now);
			this.#database.exec("COMMIT");
			return inserted.changes === 1;
		} catch (error) {
			if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	releaseJobLock(name: string, owner: string): void {
		this.#database
			.prepare(`
DELETE FROM news_job_locks WHERE name = ? AND owner = ?`)
			.run(name, owner);
	}

	seedAccounts(seeds: readonly AccountSeed[]): void {
		const statement = this.#database.prepare(`
INSERT INTO monitored_accounts(
	id, handle, organization, monitoring_enabled, monitoring_status, created_at, updated_at
) VALUES (?, ?, ?, 1, 'pending', ?, ?)
ON CONFLICT(handle) DO UPDATE SET
	organization = excluded.organization,
	monitoring_enabled = 1,
	monitoring_status = CASE WHEN monitored_accounts.monitoring_status = 'disabled' THEN 'pending' ELSE monitored_accounts.monitoring_status END,
	updated_at = excluded.updated_at`);
		for (const seed of seeds) {
			const now = new Date().toISOString();
			statement.run(randomUUID(), seed.handle, seed.organization, now, now);
		}
	}

	seedOrganizations(seeds: readonly OrganizationSeed[]): void {
		const statement = this.#database.prepare(`
INSERT INTO organizations(id, name_zh, name_en, aliases_json, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
	name_zh = excluded.name_zh,
	name_en = excluded.name_en,
	aliases_json = excluded.aliases_json,
	updated_at = excluded.updated_at`);
		for (const seed of seeds) {
			const now = new Date().toISOString();
			statement.run(
				seed.id,
				seed.nameZh,
				seed.nameEn,
				JSON.stringify(seed.aliases),
				now,
				now,
			);
		}
	}

	listEnabledAccounts(): MonitoredAccount[] {
		return (
			this.#database
				.prepare(`
SELECT id, x_user_id, handle, display_name, organization, monitoring_status, last_seen_post_at,
	ingest_boundary_post_at
FROM monitored_accounts
WHERE monitoring_enabled = 1
ORDER BY handle COLLATE NOCASE`)
				.all() as Row[]
		).map(mapAccount);
	}

	recordAccountPullSuccess(
		accountId: string,
		profile: AccountProfile | null,
		lastSeenPostAt: string | null,
		now: string,
	): void {
		this.#database
			.prepare(`
UPDATE monitored_accounts SET
	x_user_id = COALESCE(?, x_user_id),
	display_name = COALESCE(?, display_name),
	followers_count = COALESCE(?, followers_count),
	raw_profile_json = COALESCE(?, raw_profile_json),
	monitoring_status = 'active',
	last_seen_post_at = CASE
		WHEN ? IS NULL THEN last_seen_post_at
		WHEN last_seen_post_at IS NULL OR ? > last_seen_post_at THEN ?
		ELSE last_seen_post_at
	END,
	last_pulled_at = ?,
	last_error = NULL,
	updated_at = ?
WHERE id = ?`)
			.run(
				profile?.xUserId ?? null,
				profile?.displayName ?? null,
				profile?.followersCount ?? null,
				profile ? JSON.stringify(profile.rawPayload) : null,
				lastSeenPostAt,
				lastSeenPostAt,
				lastSeenPostAt,
				now,
				now,
				accountId,
			);
	}

	recordAccountIngestSuccess(
		accountId: string,
		profile: AccountProfile | null,
		ingestBoundaryPostAt: string | null,
		now: string,
	): void {
		this.#database
			.prepare(`
UPDATE monitored_accounts SET
	x_user_id = COALESCE(?, x_user_id),
	display_name = COALESCE(?, display_name),
	followers_count = COALESCE(?, followers_count),
	raw_profile_json = COALESCE(?, raw_profile_json),
	monitoring_status = 'active',
	ingest_boundary_post_at = CASE
		WHEN ? IS NULL THEN ingest_boundary_post_at
		WHEN ingest_boundary_post_at IS NULL OR ? > ingest_boundary_post_at THEN ?
		ELSE ingest_boundary_post_at
	END,
	last_pulled_at = ?,
	last_error = NULL,
	updated_at = ?
WHERE id = ?`)
			.run(
				profile?.xUserId ?? null,
				profile?.displayName ?? null,
				profile?.followersCount ?? null,
				profile ? JSON.stringify(profile.rawPayload) : null,
				ingestBoundaryPostAt,
				ingestBoundaryPostAt,
				ingestBoundaryPostAt,
				now,
				now,
				accountId,
			);
	}

	recordAccountPullFailure(
		accountId: string,
		error: string,
		now: string,
	): void {
		this.#database
			.prepare(`
UPDATE monitored_accounts SET monitoring_status = 'error', last_error = ?, updated_at = ? WHERE id = ?
`)
			.run(error.slice(0, 500), now, accountId);
	}

	hasPost(xPostId: string): boolean {
		return (
			this.#database
				.prepare("SELECT 1 FROM posts WHERE x_post_id = ?")
				.get(xPostId) !== undefined
		);
	}

	upsertPost(accountId: string, post: NormalizedPost): UpsertPostResult {
		const existing = this.#database
			.prepare(`
SELECT id, x_post_id, account_id, event_id, post_type, content, published_at, observed_at,
	tweet_url, quoted_x_post_id, quoted_post_json, processing_status
FROM posts WHERE x_post_id = ?`)
			.get(post.xPostId) as Row | undefined;
		if (existing) return { post: mapPost(existing), isNew: false };

		const id = randomUUID();
		const now = new Date().toISOString();
		const processingStatus = ["reply", "repost"].includes(post.postType)
			? "ignored"
			: "pending";
		this.#database
			.prepare(`
INSERT INTO posts(
	id, x_post_id, account_id, post_type, content, published_at, observed_at, tweet_url,
	quoted_x_post_id, quoted_post_json, urls_json, media_json, processing_status,
	raw_payload_json, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(
				id,
				post.xPostId,
				accountId,
				post.postType,
				post.content,
				post.publishedAt,
				post.observedAt,
				post.tweetUrl,
				post.quotedXPostId,
				post.quotedPost ? JSON.stringify(post.quotedPost) : null,
				JSON.stringify(post.urls),
				JSON.stringify(post.mediaUrls),
				processingStatus,
				JSON.stringify(post.rawPayload),
				now,
				now,
			);
		return {
			post: {
				id,
				xPostId: post.xPostId,
				accountId,
				eventId: null,
				postType: post.postType,
				content: post.content,
				publishedAt: post.publishedAt,
				observedAt: post.observedAt,
				tweetUrl: post.tweetUrl,
				quotedXPostId: post.quotedXPostId,
				quotedPost: post.quotedPost,
				processingStatus,
			},
			isNew: true,
		};
	}

	listPostsForAnalysis(limit = 100): PostForAnalysis[] {
		return (
			this.#database
				.prepare(`
SELECT posts.id, posts.x_post_id, posts.account_id, posts.event_id, posts.post_type,
	posts.content, posts.published_at, posts.observed_at, posts.tweet_url,
	posts.quoted_x_post_id, posts.quoted_post_json, posts.processing_status,
	monitored_accounts.handle AS account_handle,
	monitored_accounts.organization AS account_organization
FROM posts
JOIN monitored_accounts ON monitored_accounts.id = posts.account_id
WHERE posts.processing_status IN ('pending', 'failed')
	AND posts.post_type IN ('original', 'quote')
ORDER BY posts.published_at ASC
LIMIT ?`)
				.all(limit) as Row[]
		).map(mapPostForAnalysis);
	}

	markPostIgnored(
		postId: string,
		analysis: unknown,
		analysisVersion: number,
		now: string,
	): void {
		this.#database
			.prepare(`
UPDATE posts SET processing_status = 'ignored', analysis_json = ?, analysis_version = ?,
	processing_error = NULL, analyzed_at = ?, updated_at = ? WHERE id = ?
`)
			.run(JSON.stringify(analysis), analysisVersion, now, now, postId);
	}

	markPostFailed(postId: string, error: string, now: string): void {
		this.#database
			.prepare(`
UPDATE posts SET processing_status = 'failed', processing_error = ?, updated_at = ? WHERE id = ?
`)
			.run(error.slice(0, 500), now, postId);
	}

	listPostsForArticleHydration(
		limit = 100,
		retryFailedBefore = new Date(0).toISOString(),
	): ArticleHydrationCandidate[] {
		return (
			this.#database
				.prepare(`
SELECT posts.id, posts.x_post_id, posts.raw_payload_json
FROM posts
LEFT JOIN post_articles ON post_articles.post_id = posts.id
WHERE post_articles.post_id IS NULL
	OR (post_articles.status = 'failed' AND post_articles.updated_at <= ?)
ORDER BY posts.published_at DESC
LIMIT ?`)
				.all(retryFailedBefore, limit) as Row[]
		).map((row) => ({
			postId: rowString(row, "id"),
			xPostId: rowString(row, "x_post_id"),
			rawPayload: parseJson<Record<string, unknown>>(row.raw_payload_json, {}),
		}));
	}

	savePostArticle(input: PostArticleInput): void {
		this.#database
			.prepare(`
INSERT INTO post_articles(
	post_id, status, title, preview_text, full_text, contents_json,
	raw_payload_json, error, fetched_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
ON CONFLICT(post_id) DO UPDATE SET
	status = excluded.status,
	title = excluded.title,
	preview_text = excluded.preview_text,
	full_text = excluded.full_text,
	contents_json = excluded.contents_json,
	raw_payload_json = excluded.raw_payload_json,
	error = NULL,
	fetched_at = excluded.fetched_at,
	updated_at = excluded.updated_at`)
			.run(
				input.postId,
				input.status,
				input.title,
				input.previewText,
				input.fullText,
				input.contents ? JSON.stringify(input.contents) : null,
				input.rawPayload ? JSON.stringify(input.rawPayload) : null,
				input.fetchedAt,
				input.fetchedAt,
			);
	}

	markPostArticleFailed(postId: string, error: string, now: string): void {
		this.#database
			.prepare(`
INSERT INTO post_articles(post_id, status, error, fetched_at, updated_at)
VALUES (?, 'failed', ?, ?, ?)
ON CONFLICT(post_id) DO UPDATE SET
	status = 'failed', error = excluded.error,
	fetched_at = excluded.fetched_at, updated_at = excluded.updated_at`)
			.run(postId, error.slice(0, 500), now, now);
	}

	listPostsForTopicAnalysis(
		limit = 100,
		analysisVersion = 1,
		retryFailedBefore = new Date(0).toISOString(),
	): PostForTriage[] {
		const rows = this.#database
			.prepare(`
SELECT posts.id, posts.x_post_id, posts.account_id, posts.event_id, posts.post_type,
	posts.content, posts.published_at, posts.observed_at, posts.tweet_url,
	posts.quoted_x_post_id, posts.quoted_post_json, posts.processing_status,
	posts.raw_payload_json, monitored_accounts.handle AS account_handle,
	monitored_accounts.display_name AS account_display_name,
	post_articles.title AS article_title,
	post_articles.preview_text AS article_preview,
	post_articles.full_text AS article_text
FROM posts
JOIN monitored_accounts ON monitored_accounts.id = posts.account_id
JOIN post_articles ON post_articles.post_id = posts.id
LEFT JOIN post_topic_analyses ON post_topic_analyses.post_id = posts.id
WHERE post_articles.status IN ('available', 'not_article')
	AND (
		post_topic_analyses.post_id IS NULL
		OR post_topic_analyses.analysis_version < ?
		OR (
			post_topic_analyses.status = 'failed'
			AND post_topic_analyses.analysis_version = ?
			AND post_topic_analyses.updated_at <= ?
		)
	)
ORDER BY posts.published_at DESC
LIMIT ?`)
			.all(analysisVersion, analysisVersion, retryFailedBefore, limit) as Row[];
		return rows.map((row) => ({
			...mapPost(row),
			accountHandle: rowString(row, "account_handle"),
			accountDisplayName: nullableString(row, "account_display_name"),
			rawPayload: parseJson<Record<string, unknown>>(row.raw_payload_json, {}),
			articleTitle: nullableString(row, "article_title"),
			articlePreview: nullableString(row, "article_preview"),
			articleText: nullableString(row, "article_text"),
		}));
	}

	commitPostTopicClassification(input: {
		analysis: PostTopicAnalysis;
		analysisVersion: number;
		resolutionVersion: number;
		now: string;
	}): void {
		this.#database.exec('BEGIN IMMEDIATE');
		try {
			this.savePostTopicAnalysis(
				input.analysis,
				input.analysisVersion,
				input.now,
			);
			if (input.analysis.decision === 'ignore') {
				const previous = this.#database
					.prepare(`
SELECT topic_id FROM topic_posts WHERE post_id = ?`)
					.get(input.analysis.postId) as Row | undefined;
				this.#database
					.prepare('DELETE FROM topic_posts WHERE post_id = ?')
					.run(input.analysis.postId);
				this.#database
					.prepare('DELETE FROM post_topic_resolutions WHERE post_id = ?')
					.run(input.analysis.postId);
				if (previous) {
					this.#database
						.prepare(`
UPDATE topics SET status = 'archived', updated_at = ?
WHERE id = ? AND NOT EXISTS (
	SELECT 1 FROM topic_posts WHERE topic_posts.topic_id = topics.id
)`)
						.run(input.now, rowString(previous, 'topic_id'));
				}
			} else {
				this.queuePostTopicResolution(
					input.analysis.postId,
					input.resolutionVersion,
					input.now,
				);
			}
			this.#database.exec('COMMIT');
		} catch (error) {
			if (this.#database.isTransaction) this.#database.exec('ROLLBACK');
			throw error;
		}
	}

	queuePostTopicResolution(
		postId: string,
		resolutionVersion: number,
		now: string,
	): void {
		this.#database.prepare(`
INSERT INTO post_topic_resolutions(
	post_id, status, decision, attempt_count, resolution_version, created_at, updated_at
) VALUES (?, 'pending', NULL, 0, ?, ?, ?)
ON CONFLICT(post_id) DO UPDATE SET
	status = 'pending', decision = NULL, target_topic_id = NULL,
	confidence = NULL, reason = NULL, next_retry_at = NULL, error = NULL,
	resolution_version = excluded.resolution_version, resolved_at = NULL,
	updated_at = excluded.updated_at`)
			.run(postId, resolutionVersion, now, now);
	}

	listPendingTopicResolutions(
		limit: number,
		resolutionVersion: number,
		now: string,
	): PendingTopicResolution[] {
		const rows = this.#database.prepare(`
SELECT resolutions.post_id, posts.x_post_id, posts.published_at,
	posts.quoted_x_post_id, posts.raw_payload_json,
	analyses.organization_ids_json, analyses.unknown_organizations_json,
	analyses.topic_candidate_json, resolutions.attempt_count,
	resolutions.resolution_version
FROM post_topic_resolutions resolutions
JOIN post_topic_analyses analyses ON analyses.post_id = resolutions.post_id
JOIN posts ON posts.id = resolutions.post_id
WHERE analyses.status = 'success'
	AND analyses.decision IN ('important', 'observe')
	AND analyses.topic_candidate_json IS NOT NULL
	AND (
		resolutions.resolution_version < ?
		OR resolutions.status = 'pending'
		OR (
			resolutions.status IN ('failed', 'deferred')
			AND resolutions.next_retry_at IS NOT NULL
			AND resolutions.next_retry_at <= ?
		)
	)
ORDER BY posts.published_at DESC, posts.x_post_id DESC
LIMIT ?`).all(resolutionVersion, now, limit) as Row[];
		return rows.map((row) => ({
			postId: rowString(row, "post_id"),
			xPostId: rowString(row, "x_post_id"),
			publishedAt: rowString(row, "published_at"),
			quotedXPostId: nullableString(row, "quoted_x_post_id"),
			rawPayload: parseJson<Record<string, unknown>>(row.raw_payload_json, {}),
			organizationIds: parseJson<string[]>(row.organization_ids_json, []),
			unknownOrganizationCandidates: parseJson<string[]>(
				row.unknown_organizations_json,
				[],
			),
			topicCandidate: parseJson<TopicCandidate>(row.topic_candidate_json, {
				titleZh: "",
				titleEn: "",
				summaryZh: "",
				summaryEn: "",
				type: "other",
			}),
			attemptCount: rowNumber(row, "attempt_count"),
			resolutionVersion: rowNumber(row, "resolution_version"),
		}));
	}

	savePostTopicAnalysis(
		analysis: PostTopicAnalysis,
		analysisVersion: number,
		now: string,
	): void {
		this.#database
			.prepare(`
INSERT INTO post_topic_analyses(
	post_id, status, decision, is_important, domain, organization_ids_json,
	unknown_organizations_json, topic_candidate_json, reason, confidence,
	error, analysis_version, analyzed_at, updated_at
) VALUES (?, 'success', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
ON CONFLICT(post_id) DO UPDATE SET
	status = 'success', decision = excluded.decision,
	is_important = excluded.is_important, domain = excluded.domain,
	organization_ids_json = excluded.organization_ids_json,
	unknown_organizations_json = excluded.unknown_organizations_json,
	topic_candidate_json = excluded.topic_candidate_json,
	reason = excluded.reason, confidence = excluded.confidence,
	error = NULL, analysis_version = excluded.analysis_version,
	analyzed_at = excluded.analyzed_at, updated_at = excluded.updated_at
WHERE post_topic_analyses.analysis_version <= excluded.analysis_version`)
			.run(
				analysis.postId,
				analysis.decision,
				analysis.isImportant ? 1 : 0,
				analysis.domain,
				JSON.stringify(analysis.organizationIds),
				JSON.stringify(analysis.unknownOrganizationCandidates),
				analysis.topicCandidate
					? JSON.stringify(analysis.topicCandidate)
					: null,
				analysis.reason,
				analysis.confidence,
				analysisVersion,
				now,
				now,
			);
	}

	markPostTopicAnalysisFailed(
		postId: string,
		error: string,
		analysisVersion: number,
		now: string,
	): void {
		this.#database
			.prepare(`
INSERT INTO post_topic_analyses(post_id, status, error, analysis_version, analyzed_at, updated_at)
VALUES (?, 'failed', ?, ?, ?, ?)
ON CONFLICT(post_id) DO UPDATE SET
	status = CASE
		WHEN post_topic_analyses.status = 'success' THEN post_topic_analyses.status
		ELSE 'failed'
	END,
	error = excluded.error,
	analysis_version = CASE
		WHEN post_topic_analyses.status = 'success' THEN post_topic_analyses.analysis_version
		ELSE excluded.analysis_version
	END,
	analyzed_at = excluded.analyzed_at,
	updated_at = excluded.updated_at
WHERE post_topic_analyses.analysis_version <= excluded.analysis_version`)
			.run(postId, error.slice(0, 500), analysisVersion, now, now);
	}

	listTopicsForSearch(from: string, to: string): TopicSearchDocument[] {
		const rows = this.#database.prepare(`
SELECT topics.id, topics.title_zh, topics.title_en, topics.summary_zh,
	topics.summary_en, topics.topic_type, topics.status, topics.revision,
	topics.first_seen_at, topics.last_updated_at,
	topic_organizations.organization_id,
	posts.id AS post_id, posts.x_post_id, posts.published_at,
	posts.content, posts.raw_payload_json,
	monitored_accounts.handle AS publisher_handle
FROM topics
JOIN topic_posts ON topic_posts.topic_id = topics.id
JOIN posts ON posts.id = topic_posts.post_id
JOIN monitored_accounts ON monitored_accounts.id = posts.account_id
LEFT JOIN topic_organizations ON topic_organizations.topic_id = topics.id
WHERE topics.status = 'active' AND posts.published_at BETWEEN ? AND ?
ORDER BY posts.published_at DESC, posts.x_post_id DESC`)
			.all(from, to) as Row[];
		const documents = new Map<
			string,
			TopicSearchDocument & { organizationSet: Set<string>; postIds: Set<string> }
		>();
		for (const row of rows) {
			const topicId = rowString(row, "id");
			let document = documents.get(topicId);
			if (!document) {
				document = {
					id: topicId,
					titleZh: rowString(row, "title_zh"),
					titleEn: rowString(row, "title_en"),
					summaryZh: rowString(row, "summary_zh"),
					summaryEn: rowString(row, "summary_en"),
					type: rowString(row, "topic_type") as NewsTopic["type"],
					status: rowString(row, "status") as NewsTopic["status"],
					revision: rowNumber(row, "revision"),
					organizationIds: [],
					organizationSet: new Set<string>(),
					firstSeenAt: rowString(row, "first_seen_at"),
					lastUpdatedAt: rowString(row, "last_updated_at"),
					sourcePosts: [],
					postIds: new Set<string>(),
				};
				documents.set(topicId, document);
			}
			const organizationId = nullableString(row, "organization_id");
			if (organizationId && !document.organizationSet.has(organizationId)) {
				document.organizationSet.add(organizationId);
				document.organizationIds.push(organizationId);
			}
			const postId = rowString(row, "post_id");
			if (!document.postIds.has(postId)) {
				document.postIds.add(postId);
				document.sourcePosts.push({
					xPostId: rowString(row, "x_post_id"),
					publishedAt: rowString(row, "published_at"),
					publisherHandle: rowString(row, "publisher_handle"),
					content: rowString(row, "content"),
					rawPayload: parseJson<Record<string, unknown>>(row.raw_payload_json, {}),
				});
			}
		}
		return [...documents.values()].map(({ organizationSet: _, postIds: __, ...document }) => document);
	}

	listActiveTopics(since: string): NewsTopic[] {
		const rows = this.#database
			.prepare(`
SELECT topics.id, topics.title_zh, topics.title_en, topics.summary_zh,
	topics.summary_en, topics.topic_type, topics.status, topics.revision,
	topics.first_seen_at, topics.last_updated_at,
	topic_organizations.organization_id
FROM topics
LEFT JOIN topic_organizations ON topic_organizations.topic_id = topics.id
WHERE topics.status = 'active' AND EXISTS (
	SELECT 1
	FROM topic_posts recent_topic_posts
	JOIN posts recent_posts ON recent_posts.id = recent_topic_posts.post_id
	WHERE recent_topic_posts.topic_id = topics.id
		AND recent_posts.published_at >= ?
)
ORDER BY (
	SELECT max(latest_posts.published_at)
	FROM topic_posts latest_topic_posts
	JOIN posts latest_posts ON latest_posts.id = latest_topic_posts.post_id
	WHERE latest_topic_posts.topic_id = topics.id
) DESC`)
			.all(since) as Row[];
		const topics = new Map<string, NewsTopic>();
		for (const row of rows) {
			const id = rowString(row, "id");
			const existing = topics.get(id);
			const organizationId = nullableString(row, "organization_id");
			if (existing) {
				if (organizationId) existing.organizationIds.push(organizationId);
				continue;
			}
			topics.set(id, {
				id,
				titleZh: rowString(row, "title_zh"),
				titleEn: rowString(row, "title_en"),
				summaryZh: rowString(row, "summary_zh"),
				summaryEn: rowString(row, "summary_en"),
				type: rowString(row, "topic_type") as NewsTopic["type"],
				status: rowString(row, "status") as NewsTopic["status"],
				revision: rowNumber(row, "revision"),
				organizationIds: organizationId ? [organizationId] : [],
				firstSeenAt: rowString(row, "first_seen_at"),
				lastUpdatedAt: rowString(row, "last_updated_at"),
			});
		}
		return [...topics.values()];
	}

	createTopicForPost(input: {
		candidate: TopicCandidate;
		organizationIds: string[];
		postId: string;
		decision: TriageDecision;
		now: string;
	}): string {
		const topicId = randomUUID();
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			this.#database
				.prepare(`
INSERT INTO topics(
	id, title_zh, title_en, summary_zh, summary_en, topic_type,
	status, first_seen_at, last_updated_at, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
				.run(
					topicId,
					input.candidate.titleZh,
					input.candidate.titleEn,
					input.candidate.summaryZh,
					input.candidate.summaryEn,
					input.candidate.type,
					input.now,
					input.now,
					input.now,
					input.now,
				);
			for (const organizationId of new Set(input.organizationIds)) {
				this.#database
					.prepare(`
INSERT INTO topic_organizations(topic_id, organization_id) VALUES (?, ?)`)
					.run(topicId, organizationId);
			}
			this.#database
				.prepare(`
INSERT INTO topic_posts(post_id, topic_id, decision, added_at) VALUES (?, ?, ?, ?)`)
				.run(input.postId, topicId, input.decision, input.now);
			this.#database.exec("COMMIT");
			return topicId;
		} catch (error) {
			if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	attachPostToTopic(input: {
		topicId: string;
		postId: string;
		decision: TriageDecision;
		organizationIds: string[];
		now: string;
	}): void {
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			this.#database
				.prepare(`
INSERT INTO topic_posts(post_id, topic_id, decision, added_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(post_id) DO UPDATE SET
	topic_id = excluded.topic_id, decision = excluded.decision, added_at = excluded.added_at`)
				.run(input.postId, input.topicId, input.decision, input.now);
			for (const organizationId of new Set(input.organizationIds)) {
				this.#database
					.prepare(`
INSERT OR IGNORE INTO topic_organizations(topic_id, organization_id) VALUES (?, ?)`)
					.run(input.topicId, organizationId);
			}
			this.#database
				.prepare(`
UPDATE topics
SET last_updated_at = ?, updated_at = ?, revision = revision + 1
WHERE id = ?`)
				.run(input.now, input.now, input.topicId);
			this.#database.exec("COMMIT");
		} catch (error) {
			if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	commitPostTopicAnalysis(input: {
		analysis: PostTopicAnalysis;
		analysisVersion: number;
		existingTopicId: string | null;
		now: string;
	}): { topicId: string | null; topicCreated: boolean } {
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			const previousAnalysis = this.#database
				.prepare(`
SELECT analysis_version FROM post_topic_analyses WHERE post_id = ?`)
				.get(input.analysis.postId) as Row | undefined;
			if (
				previousAnalysis &&
				rowNumber(previousAnalysis, "analysis_version") > input.analysisVersion
			) {
				throw new Error("Refusing to overwrite a newer topic analysis");
			}
			const previousTopic = this.#database
				.prepare(`
SELECT topic_id FROM topic_posts WHERE post_id = ?`)
				.get(input.analysis.postId) as Row | undefined;
			const previousTopicId = previousTopic
				? rowString(previousTopic, "topic_id")
				: null;
			let topicId: string | null = null;
			let topicCreated = false;
			if (input.analysis.decision === "ignore") {
				this.#database
					.prepare("DELETE FROM topic_posts WHERE post_id = ?")
					.run(input.analysis.postId);
			} else {
				const candidate = input.analysis.topicCandidate;
				if (!candidate)
					throw new Error("Tracked analysis has no topic candidate");
				topicId = input.existingTopicId ?? randomUUID();
				if (input.existingTopicId) {
					const updated = this.#database
						.prepare(`
UPDATE topics
SET last_updated_at = ?, updated_at = ?, revision = revision + 1
WHERE id = ?`)
						.run(input.now, input.now, topicId);
					if (updated.changes !== 1)
						throw new Error(`Topic not found: ${topicId}`);
				} else {
					this.#database
						.prepare(`
INSERT INTO topics(
	id, title_zh, title_en, summary_zh, summary_en, topic_type,
	status, first_seen_at, last_updated_at, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
						.run(
							topicId,
							candidate.titleZh,
							candidate.titleEn,
							candidate.summaryZh,
							candidate.summaryEn,
							candidate.type,
							input.now,
							input.now,
							input.now,
							input.now,
						);
					topicCreated = true;
				}
				for (const organizationId of new Set(input.analysis.organizationIds)) {
					this.#database
						.prepare(`
INSERT OR IGNORE INTO topic_organizations(topic_id, organization_id) VALUES (?, ?)`)
						.run(topicId, organizationId);
				}
				this.#database
					.prepare(`
INSERT INTO topic_posts(post_id, topic_id, decision, added_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(post_id) DO UPDATE SET
	topic_id = excluded.topic_id, decision = excluded.decision, added_at = excluded.added_at`)
					.run(
						input.analysis.postId,
						topicId,
						input.analysis.decision,
						input.now,
					);
			}
			if (previousTopicId && previousTopicId !== topicId) {
				this.#database
					.prepare(`
UPDATE topics SET status = 'archived', updated_at = ?
WHERE id = ? AND NOT EXISTS (
	SELECT 1 FROM topic_posts WHERE topic_posts.topic_id = topics.id
)`)
					.run(input.now, previousTopicId);
			}
			this.savePostTopicAnalysis(
				input.analysis,
				input.analysisVersion,
				input.now,
			);
			this.#database.exec("COMMIT");
			return { topicId, topicCreated };
		} catch (error) {
			if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	commitTopicResolution(input: {
		postId: string;
		decision: "attach" | "create";
		targetTopicId: string | null;
		expectedTopicRevision: number | null;
		confidence: number;
		reason: string;
		searchTrace: unknown;
		modelRunId: string | null;
		resolutionVersion: number;
		now: string;
	}): { topicId: string; topicCreated: boolean } {
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			const row = this.#database.prepare(`
SELECT analyses.decision, analyses.organization_ids_json,
	analyses.topic_candidate_json, posts.published_at
FROM post_topic_analyses analyses
JOIN posts ON posts.id = analyses.post_id
WHERE analyses.post_id = ? AND analyses.status = 'success'
	AND analyses.decision IN ('important', 'observe')`)
				.get(input.postId) as Row | undefined;
			if (!row) throw new Error(`Tracked analysis not found: ${input.postId}`);
			const candidate = parseJson<TopicCandidate | null>(
				row.topic_candidate_json,
				null,
			);
			if (!candidate) throw new Error("Tracked analysis has no Topic candidate");
			const organizationIds = parseJson<string[]>(row.organization_ids_json, []);
			const publishedAt = rowString(row, "published_at");
			const previous = this.#database.prepare(`
SELECT topic_id FROM topic_posts WHERE post_id = ?`).get(input.postId) as Row | undefined;
			const previousTopicId = previous ? rowString(previous, "topic_id") : null;
			let topicId: string;
			let topicCreated = false;
			if (input.decision === "attach") {
				if (!input.targetTopicId || input.expectedTopicRevision === null) {
					throw new Error("Attach resolution is missing Topic revision data");
				}
				topicId = input.targetTopicId;
				const updated = this.#database.prepare(`
UPDATE topics
SET last_updated_at = ?, updated_at = ?, revision = revision + 1
WHERE id = ? AND status = 'active' AND revision = ?`)
					.run(input.now, input.now, topicId, input.expectedTopicRevision);
				if (updated.changes !== 1) {
					throw new Error(`Topic changed before resolution commit: ${topicId}`);
				}
			} else {
				if (input.targetTopicId !== null || input.expectedTopicRevision !== null) {
					throw new Error("Create resolution unexpectedly references an existing Topic");
				}
				topicId = randomUUID();
				this.#database.prepare(`
INSERT INTO topics(
	id, title_zh, title_en, summary_zh, summary_en, topic_type,
	status, first_seen_at, last_updated_at, created_at, updated_at, revision
) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, 0)`)
					.run(
						topicId,
						candidate.titleZh,
						candidate.titleEn,
						candidate.summaryZh,
						candidate.summaryEn,
						candidate.type,
						publishedAt,
						publishedAt,
						input.now,
						input.now,
					);
				topicCreated = true;
			}
			for (const organizationId of new Set(organizationIds)) {
				this.#database.prepare(`
INSERT OR IGNORE INTO topic_organizations(topic_id, organization_id) VALUES (?, ?)`)
					.run(topicId, organizationId);
			}
			this.#database.prepare(`
INSERT INTO topic_posts(post_id, topic_id, decision, added_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(post_id) DO UPDATE SET
	topic_id = excluded.topic_id, decision = excluded.decision, added_at = excluded.added_at`)
				.run(input.postId, topicId, rowString(row, "decision"), input.now);
			if (previousTopicId && previousTopicId !== topicId) {
				this.#database.prepare(`
UPDATE topics SET status = 'archived', updated_at = ?
WHERE id = ? AND NOT EXISTS (
	SELECT 1 FROM topic_posts WHERE topic_posts.topic_id = topics.id
)`).run(input.now, previousTopicId);
			}
			this.#database.prepare(`
UPDATE post_topic_resolutions SET
	status = 'resolved', decision = ?, target_topic_id = ?, confidence = ?,
	reason = ?, error = NULL, next_retry_at = NULL,
	resolution_version = ?, resolved_at = ?, updated_at = ?
WHERE post_id = ?`).run(
				input.decision,
				topicId,
				input.confidence,
				input.reason,
				input.resolutionVersion,
				input.now,
				input.now,
				input.postId,
			);
			this.#database.prepare(`
INSERT INTO topic_resolution_events(
	id, post_id, decision, from_topic_id, to_topic_id, resolver_version,
	confidence, reason, search_trace_json, model_run_id, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
				randomUUID(),
				input.postId,
				input.decision,
				previousTopicId,
				topicId,
				input.resolutionVersion,
				input.confidence,
				input.reason.slice(0, 500),
				JSON.stringify(input.searchTrace),
				input.modelRunId,
				input.now,
			);
			this.#database.exec("COMMIT");
			return { topicId, topicCreated };
		} catch (error) {
			if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	markTopicResolutionFailed(input: {
		postId: string;
		error: string;
		nextRetryAt: string;
		resolutionVersion: number;
		now: string;
	}): void {
		this.#database.prepare(`
UPDATE post_topic_resolutions SET
	status = 'failed', decision = NULL, target_topic_id = NULL,
	attempt_count = attempt_count + 1, next_retry_at = ?, error = ?,
	resolution_version = ?, updated_at = ?
WHERE post_id = ?`).run(
			input.nextRetryAt,
			input.error.slice(0, 500),
			input.resolutionVersion,
			input.now,
			input.postId,
		);
	}

	markTopicResolutionDeferred(input: {
		postId: string;
		confidence: number;
		reason: string;
		nextRetryAt: string | null;
		searchTrace: unknown;
		modelRunId: string | null;
		resolutionVersion: number;
		now: string;
	}): void {
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			this.#database.prepare(`
UPDATE post_topic_resolutions SET
	status = 'deferred', decision = 'defer', target_topic_id = NULL,
	confidence = ?, reason = ?, attempt_count = attempt_count + 1,
	next_retry_at = ?, error = NULL, resolution_version = ?, updated_at = ?
WHERE post_id = ?`).run(
				input.confidence,
				input.reason.slice(0, 500),
				input.nextRetryAt,
				input.resolutionVersion,
				input.now,
				input.postId,
			);
			this.#database.prepare(`
INSERT INTO topic_resolution_events(
	id, post_id, decision, resolver_version, confidence, reason,
	search_trace_json, model_run_id, created_at
) VALUES (?, ?, 'defer', ?, ?, ?, ?, ?, ?)`).run(
				randomUUID(),
				input.postId,
				input.resolutionVersion,
				input.confidence,
				input.reason.slice(0, 500),
				JSON.stringify(input.searchTrace),
				input.modelRunId,
				input.now,
			);
			this.#database.exec("COMMIT");
		} catch (error) {
			if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	listPostsForMetricRefresh(): PostForMetricRefresh[] {
		const rows = this.#database
			.prepare(`
SELECT posts.id AS post_id, posts.x_post_id
FROM topic_posts
JOIN posts ON posts.id = topic_posts.post_id
JOIN topics ON topics.id = topic_posts.topic_id
LEFT JOIN topic_heat_states ON topic_heat_states.topic_id = topics.id
WHERE topics.status = 'active'
	AND (topic_heat_states.state IS NULL OR topic_heat_states.state != 'stopped')
ORDER BY posts.published_at ASC`)
			.all() as Row[];
		return rows.map((row) => ({
			postId: rowString(row, "post_id"),
			xPostId: rowString(row, "x_post_id"),
		}));
	}

	savePostMetricSnapshots(
		snapshots: PostMetricSnapshotInput[],
		observedAt: string,
	): void {
		if (snapshots.length === 0) return;
		const statement = this.#database.prepare(`
INSERT INTO post_metric_snapshots(
	post_id, observed_at, view_count, like_count, repost_count, reply_count, quote_count
) VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(post_id, observed_at) DO UPDATE SET
	view_count = excluded.view_count, like_count = excluded.like_count,
	repost_count = excluded.repost_count, reply_count = excluded.reply_count,
	quote_count = excluded.quote_count`);
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			for (const snapshot of snapshots) {
				statement.run(
					snapshot.postId,
					observedAt,
					snapshot.views,
					snapshot.likes,
					snapshot.reposts,
					snapshot.replies,
					snapshot.quotes,
				);
			}
			this.#database.exec("COMMIT");
		} catch (error) {
			if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	promoteEligibleObservedPosts(now: string): string[] {
		const rows = this.#database
			.prepare(`
SELECT topic_posts.post_id, posts.published_at,
	(SELECT view_count FROM post_metric_snapshots first_snapshot
		WHERE first_snapshot.post_id = topic_posts.post_id
		ORDER BY observed_at ASC LIMIT 1) AS baseline_views,
	(SELECT view_count FROM post_metric_snapshots latest_snapshot
		WHERE latest_snapshot.post_id = topic_posts.post_id
		ORDER BY observed_at DESC LIMIT 1) AS current_views
FROM topic_posts
JOIN posts ON posts.id = topic_posts.post_id
WHERE topic_posts.decision = 'observe'`)
			.all() as Row[];
		const nowMs = new Date(now).getTime();
		const eligible = rows.flatMap((row) => {
			const baselineViews = row.baseline_views;
			const currentViews = row.current_views;
			if (typeof baselineViews !== "number" || typeof currentViews !== "number")
				return [];
			const ageHours =
				(nowMs - new Date(rowString(row, "published_at")).getTime()) /
				3_600_000;
			if (ageHours < 5) return [];
			const reason =
				currentViews >= 250_000
					? "views_250k"
					: currentViews - baselineViews >= 100_000
						? "views_gained_100k"
						: null;
			return reason
				? [
						{
							postId: rowString(row, "post_id"),
							baselineViews,
							currentViews,
							reason,
						},
					]
				: [];
		});
		if (eligible.length === 0) return [];
		const updateTopicPost = this.#database.prepare(`
UPDATE topic_posts SET decision = 'important' WHERE post_id = ? AND decision = 'observe'`);
		const updateAnalysis = this.#database.prepare(`
UPDATE post_topic_analyses
SET decision = 'important', is_important = 1, updated_at = ?
WHERE post_id = ? AND status = 'success'`);
		const insertPromotion = this.#database.prepare(`
INSERT OR IGNORE INTO post_metric_promotions(
	post_id, promoted_at, baseline_views, promotion_views, reason
) VALUES (?, ?, ?, ?, ?)`);
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			const promoted: string[] = [];
			for (const item of eligible) {
				if (updateTopicPost.run(item.postId).changes !== 1) continue;
				updateAnalysis.run(now, item.postId);
				insertPromotion.run(
					item.postId,
					now,
					item.baselineViews,
					item.currentViews,
					item.reason,
				);
				promoted.push(item.postId);
			}
			this.#database.exec("COMMIT");
			return promoted;
		} catch (error) {
			if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	listTopicMetricPosts(): TopicMetricPost[] {
		const rows = this.#database
			.prepare(`
SELECT topic_posts.topic_id, posts.id AS post_id, posts.published_at,
	(SELECT view_count FROM post_metric_snapshots
		WHERE post_metric_snapshots.post_id = posts.id
		ORDER BY observed_at DESC LIMIT 1) AS views,
	(SELECT observed_at FROM post_metric_snapshots
		WHERE post_metric_snapshots.post_id = posts.id
		ORDER BY observed_at DESC LIMIT 1) AS metric_observed_at
FROM topic_posts
JOIN posts ON posts.id = topic_posts.post_id
JOIN topics ON topics.id = topic_posts.topic_id
LEFT JOIN topic_heat_states ON topic_heat_states.topic_id = topics.id
WHERE topics.status = 'active'
	AND (topic_heat_states.state IS NULL OR topic_heat_states.state != 'stopped')
ORDER BY topic_posts.topic_id, posts.published_at`)
			.all() as Row[];
		return rows.map((row) => ({
			topicId: rowString(row, "topic_id"),
			postId: rowString(row, "post_id"),
			publishedAt: rowString(row, "published_at"),
			views: typeof row.views === "number" ? row.views : null,
			metricObservedAt: nullableString(row, "metric_observed_at"),
		}));
	}

	listPreviousTopicMetrics(): PreviousTopicMetric[] {
		const rows = this.#database
			.prepare(`
SELECT snapshots.topic_id, snapshots.observed_at, snapshots.effective_views
FROM topic_metric_snapshots snapshots
WHERE snapshots.observed_at = (
	SELECT max(latest.observed_at) FROM topic_metric_snapshots latest
	WHERE latest.topic_id = snapshots.topic_id
)`)
			.all() as Row[];
		return rows.map((row) => ({
			topicId: rowString(row, "topic_id"),
			observedAt: rowString(row, "observed_at"),
			effectiveViews: rowNumber(row, "effective_views"),
		}));
	}

	listCurrentHotTopics(): CurrentHotTopic[] {
		return (
			this.#database
				.prepare(`
SELECT topics.id AS topic_id, topics.title_zh, topics.title_en,
	topic_heat_states.current_effective_views,
	topic_heat_states.current_velocity_per_hour,
	topic_heat_states.current_heat, topic_heat_states.state,
	topic_heat_states.current_rank
FROM topic_heat_states
JOIN topics ON topics.id = topic_heat_states.topic_id
WHERE topic_heat_states.state IN ('ranked', 'cooling')
	AND topic_heat_states.current_rank IS NOT NULL
ORDER BY topic_heat_states.current_rank ASC`)
				.all() as Row[]
		).map((row) => ({
			topicId: rowString(row, "topic_id"),
			titleZh: rowString(row, "title_zh"),
			titleEn: rowString(row, "title_en"),
			effectiveViews: rowNumber(row, "current_effective_views"),
			velocityPerHour: rowNumber(row, "current_velocity_per_hour"),
			heat: rowNumber(row, "current_heat"),
			state: rowString(row, "state") as CurrentHotTopic["state"],
			rank: rowNumber(row, "current_rank"),
		}));
	}

	listTopicHeatStates(): StoredTopicHeatState[] {
		return (
			this.#database
				.prepare(`
SELECT topic_id, state, low_heat_streak, low_growth_streak
FROM topic_heat_states`)
				.all() as Row[]
		).map((row) => ({
			topicId: rowString(row, "topic_id"),
			state: rowString(row, "state") as StoredTopicHeatState["state"],
			lowHeatStreak: rowNumber(row, "low_heat_streak"),
			lowGrowthStreak: rowNumber(row, "low_growth_streak"),
		}));
	}

	saveTopicMetricResults(results: TopicMetricResultInput[]): void {
		if (results.length === 0) return;
		const insertSnapshot = this.#database.prepare(`
INSERT INTO topic_metric_snapshots(
	topic_id, observed_at, effective_views, velocity_per_hour, growth_rate,
	view_score, velocity_score, heat, state, rank
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(topic_id, observed_at) DO UPDATE SET
	effective_views = excluded.effective_views,
	velocity_per_hour = excluded.velocity_per_hour,
	growth_rate = excluded.growth_rate,
	view_score = excluded.view_score,
	velocity_score = excluded.velocity_score,
	heat = excluded.heat, state = excluded.state, rank = excluded.rank`);
		const upsertState = this.#database.prepare(`
INSERT INTO topic_heat_states(
	topic_id, state, low_heat_streak, low_growth_streak,
	current_effective_views, current_velocity_per_hour, current_heat,
	current_rank, stopped_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(topic_id) DO UPDATE SET
	state = excluded.state,
	low_heat_streak = excluded.low_heat_streak,
	low_growth_streak = excluded.low_growth_streak,
	current_effective_views = excluded.current_effective_views,
	current_velocity_per_hour = excluded.current_velocity_per_hour,
	current_heat = excluded.current_heat,
	current_rank = excluded.current_rank,
	stopped_at = excluded.stopped_at,
	updated_at = excluded.updated_at`);
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			for (const result of results) {
				insertSnapshot.run(
					result.topicId,
					result.observedAt,
					result.effectiveViews,
					result.velocityPerHour,
					result.growthRate,
					result.viewScore,
					result.velocityScore,
					result.heat,
					result.state,
					result.rank,
				);
				upsertState.run(
					result.topicId,
					result.state,
					result.lowHeatStreak,
					result.lowGrowthStreak,
					result.effectiveViews,
					result.velocityPerHour,
					result.heat,
					result.rank,
					result.stoppedAt,
					result.observedAt,
				);
			}
			this.#database.exec("COMMIT");
		} catch (error) {
			if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	findEventByFingerprint(fingerprint: string): NewsEvent | null {
		const row = this.#database
			.prepare(`
SELECT id, category, canonical_title, organization, subject, action, event_fingerprint,
	facts_json, status, first_seen_at, last_updated_at, current_report_version, lock_version
FROM events WHERE event_fingerprint = ?`)
			.get(fingerprint) as Row | undefined;
		return row ? mapEvent(row) : null;
	}

	getCurrentReportMarkdown(eventId: string, version: number): string | null {
		if (version < 1) return null;
		const row = this.#database
			.prepare(
				"SELECT markdown FROM event_reports WHERE event_id = ? AND version = ?",
			)
			.get(eventId, version) as Row | undefined;
		return row ? rowString(row, "markdown") : null;
	}

	getPostSource(postId: string): EventSourcePost {
		const row = this.#database
			.prepare(`
SELECT posts.id, posts.x_post_id, monitored_accounts.handle, posts.content,
	posts.published_at, posts.tweet_url
FROM posts
JOIN monitored_accounts ON monitored_accounts.id = posts.account_id
WHERE posts.id = ?`)
			.get(postId) as Row | undefined;
		if (!row) throw new Error(`Post not found: ${postId}`);
		return {
			id: rowString(row, "id"),
			xPostId: rowString(row, "x_post_id"),
			handle: rowString(row, "handle"),
			content: rowString(row, "content"),
			publishedAt: rowString(row, "published_at"),
			tweetUrl: rowString(row, "tweet_url"),
		};
	}

	listEventSourcePosts(eventId: string): EventSourcePost[] {
		return (
			this.#database
				.prepare(`
SELECT posts.id, posts.x_post_id, monitored_accounts.handle, posts.content,
	posts.published_at, posts.tweet_url
FROM posts
JOIN monitored_accounts ON monitored_accounts.id = posts.account_id
WHERE posts.event_id = ?
ORDER BY posts.published_at ASC`)
				.all(eventId) as Row[]
		).map((row) => ({
			id: rowString(row, "id"),
			xPostId: rowString(row, "x_post_id"),
			handle: rowString(row, "handle"),
			content: rowString(row, "content"),
			publishedAt: rowString(row, "published_at"),
			tweetUrl: rowString(row, "tweet_url"),
		}));
	}

	commitEventChange(input: CommitEventChangeInput): CommitEventChangeResult {
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			const current = this.findEventByFingerprint(input.eventFingerprint);
			if (input.expectedEventId === null) {
				if (current)
					throw new Error("Event was created concurrently; retry the post");
				if (!input.report)
					throw new Error("A new event must create its first report");
				this.#database
					.prepare(`
INSERT INTO events(
	id, category, canonical_title, organization, subject, action, event_fingerprint,
	facts_json, status, first_seen_at, last_updated_at, current_report_version,
	lock_version, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 1, 0, ?, ?)`)
					.run(
						input.eventId,
						input.category,
						input.canonicalTitle,
						input.organization,
						input.subject,
						input.action,
						input.eventFingerprint,
						JSON.stringify(input.facts),
						input.now,
						input.now,
						input.now,
						input.now,
					);
			} else {
				if (
					!current ||
					current.id !== input.expectedEventId ||
					current.lockVersion !== input.expectedLockVersion
				) {
					throw new Error("Event version changed concurrently; retry the post");
				}
				const nextReportVersion = input.report
					? current.currentReportVersion + 1
					: current.currentReportVersion;
				const update = this.#database
					.prepare(`
UPDATE events SET
	category = ?, canonical_title = ?, organization = ?, subject = ?, action = ?,
	facts_json = ?, status = ?, last_updated_at = ?, current_report_version = ?,
	lock_version = lock_version + 1, updated_at = ?
WHERE id = ? AND lock_version = ?`)
					.run(
						input.category,
						input.canonicalTitle,
						input.organization,
						input.subject,
						input.action,
						JSON.stringify(input.facts),
						input.report ? "updated" : current.status,
						input.now,
						nextReportVersion,
						input.now,
						current.id,
						current.lockVersion,
					);
				if (Number(update.changes) !== 1)
					throw new Error("Failed to acquire event version lock");
			}

			this.#database
				.prepare(`
UPDATE posts SET event_id = ?, processing_status = 'processed', analysis_json = ?,
	analysis_version = 1, processing_error = NULL, analyzed_at = ?, updated_at = ?
WHERE id = ?`)
				.run(
					input.eventId,
					JSON.stringify(input.analysis),
					input.now,
					input.now,
					input.postId,
				);

			let reportVersion: number | null = null;
			if (input.report) {
				const baseVersion = current?.currentReportVersion ?? 0;
				reportVersion = baseVersion + 1;
				this.#database
					.prepare(`
INSERT INTO event_reports(
	event_id, version, base_report_version, markdown, change_summary,
	event_snapshot_json, source_post_ids_json, created_by_run_id,
	file_path, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
					.run(
						input.eventId,
						reportVersion,
						baseVersion,
						input.report.markdown,
						input.report.changeSummary,
						JSON.stringify(input.report.eventSnapshot),
						JSON.stringify(input.report.sourcePostIds),
						input.report.createdByRunId,
						input.report.filePath,
						input.now,
					);
			}
			this.#database.exec("COMMIT");
			return {
				eventId: input.eventId,
				reportVersion,
				filePath: input.report?.filePath ?? null,
			};
		} catch (error) {
			if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	listPendingReportExports(): PendingReportExport[] {
		return (
			this.#database
				.prepare(`
SELECT event_id, version, markdown, file_path
FROM event_reports
WHERE file_synced_at IS NULL
ORDER BY created_at ASC`)
				.all() as Row[]
		).map((row) => ({
			eventId: rowString(row, "event_id"),
			version: rowNumber(row, "version"),
			markdown: rowString(row, "markdown"),
			filePath: rowString(row, "file_path"),
		}));
	}

	markReportFileSynced(eventId: string, version: number, now: string): void {
		this.#database
			.prepare(`
UPDATE event_reports SET file_synced_at = ?, file_sync_error = NULL WHERE event_id = ? AND version = ?
`)
			.run(now, eventId, version);
	}

	markReportFileFailed(eventId: string, version: number, error: string): void {
		this.#database
			.prepare(`
UPDATE event_reports SET file_sync_error = ? WHERE event_id = ? AND version = ?
`)
			.run(error.slice(0, 500), eventId, version);
	}
}
