import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type {
	AccountProfile,
	EventCategory,
	EventFact,
	EventSourcePost,
	MonitoredAccount,
	NewsEvent,
	NormalizedPost,
	PostForAnalysis,
	StoredPost,
} from './types';

type AccountSeed = {
	handle: string;
	organization: string;
};

type UpsertPostResult = {
	post: StoredPost;
	isNew: boolean;
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

const migrations = [{
	version: 1,
	name: 'initial-official-news-schema',
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
}];

function rowString(row: Row, key: string): string {
	const value = row[key];
	if (typeof value !== 'string') throw new Error(`Database row is missing ${key}`);
	return value;
}

function nullableString(row: Row, key: string): string | null {
	return typeof row[key] === 'string' ? row[key] as string : null;
}

function rowNumber(row: Row, key: string): number {
	const value = row[key];
	if (typeof value !== 'number') throw new Error(`Database row is missing numeric ${key}`);
	return value;
}

function parseJson<T>(value: unknown, fallback: T): T {
	if (typeof value !== 'string') return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function mapAccount(row: Row): MonitoredAccount {
	return {
		id: rowString(row, 'id'),
		xUserId: nullableString(row, 'x_user_id'),
		handle: rowString(row, 'handle'),
		displayName: nullableString(row, 'display_name'),
		organization: rowString(row, 'organization'),
		monitoringStatus: rowString(row, 'monitoring_status') as MonitoredAccount['monitoringStatus'],
		lastSeenPostAt: nullableString(row, 'last_seen_post_at'),
	};
}

function mapPost(row: Row): StoredPost {
	return {
		id: rowString(row, 'id'),
		xPostId: rowString(row, 'x_post_id'),
		accountId: rowString(row, 'account_id'),
		eventId: nullableString(row, 'event_id'),
		postType: rowString(row, 'post_type') as StoredPost['postType'],
		content: rowString(row, 'content'),
		publishedAt: rowString(row, 'published_at'),
		observedAt: rowString(row, 'observed_at'),
		tweetUrl: rowString(row, 'tweet_url'),
		quotedXPostId: nullableString(row, 'quoted_x_post_id'),
		quotedPost: parseJson<Record<string, unknown> | null>(row.quoted_post_json, null),
		processingStatus: rowString(row, 'processing_status') as StoredPost['processingStatus'],
	};
}

function mapPostForAnalysis(row: Row): PostForAnalysis {
	return {
		...mapPost(row),
		accountHandle: rowString(row, 'account_handle'),
		accountOrganization: rowString(row, 'account_organization'),
	};
}

function mapEvent(row: Row): NewsEvent {
	return {
		id: rowString(row, 'id'),
		category: rowString(row, 'category') as NewsEvent['category'],
		canonicalTitle: rowString(row, 'canonical_title'),
		organization: rowString(row, 'organization'),
		subject: rowString(row, 'subject'),
		action: rowString(row, 'action'),
		eventFingerprint: rowString(row, 'event_fingerprint'),
		facts: parseJson<EventFact[]>(row.facts_json, []),
		status: rowString(row, 'status') as NewsEvent['status'],
		firstSeenAt: rowString(row, 'first_seen_at'),
		lastUpdatedAt: rowString(row, 'last_updated_at'),
		currentReportVersion: rowNumber(row, 'current_report_version'),
		lockVersion: rowNumber(row, 'lock_version'),
	};
}

export class NewsDatabase {
	readonly #database: DatabaseSync;

	constructor(databasePath?: ':memory:') {
		if (databasePath === ':memory:') {
			this.#database = new DatabaseSync(':memory:', { timeout: 5_000 });
		} else {
			mkdirSync('./data', { recursive: true });
			this.#database = new DatabaseSync('./data/news.db', { timeout: 5_000 });
		}
		this.#database.exec('PRAGMA foreign_keys = ON');
		if (databasePath !== ':memory:') this.#database.exec('PRAGMA journal_mode = WAL');
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
			(this.#database.prepare('SELECT version FROM news_schema_migrations').all() as Row[])
				.map((row) => rowNumber(row, 'version')),
		);
		for (const migration of migrations) {
			if (applied.has(migration.version)) continue;
			this.#database.exec('BEGIN IMMEDIATE');
			try {
				this.#database.exec(migration.sql);
				this.#database.prepare(
					'INSERT INTO news_schema_migrations(version, name, applied_at) VALUES (?, ?, ?)',
				).run(migration.version, migration.name, new Date().toISOString());
				this.#database.exec('COMMIT');
			} catch (error) {
				if (this.#database.isTransaction) this.#database.exec('ROLLBACK');
				throw error;
			}
		}
	}

	close(): void {
		this.#database.close();
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

	listEnabledAccounts(): MonitoredAccount[] {
		return (this.#database.prepare(`
SELECT id, x_user_id, handle, display_name, organization, monitoring_status, last_seen_post_at
FROM monitored_accounts
WHERE monitoring_enabled = 1
ORDER BY handle COLLATE NOCASE`).all() as Row[]).map(mapAccount);
	}

	recordAccountPullSuccess(
		accountId: string,
		profile: AccountProfile | null,
		lastSeenPostAt: string | null,
		now: string,
	): void {
		this.#database.prepare(`
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
WHERE id = ?`).run(
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

	recordAccountPullFailure(accountId: string, error: string, now: string): void {
		this.#database.prepare(`
UPDATE monitored_accounts SET monitoring_status = 'error', last_error = ?, updated_at = ? WHERE id = ?
`).run(error.slice(0, 500), now, accountId);
	}

	upsertPost(accountId: string, post: NormalizedPost): UpsertPostResult {
		const existing = this.#database.prepare(`
SELECT id, x_post_id, account_id, event_id, post_type, content, published_at, observed_at,
	tweet_url, quoted_x_post_id, quoted_post_json, processing_status
FROM posts WHERE x_post_id = ?`).get(post.xPostId) as Row | undefined;
		if (existing) return { post: mapPost(existing), isNew: false };

		const id = randomUUID();
		const now = new Date().toISOString();
		const processingStatus = ['reply', 'repost'].includes(post.postType) ? 'ignored' : 'pending';
		this.#database.prepare(`
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
		return (this.#database.prepare(`
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
LIMIT ?`).all(limit) as Row[]).map(mapPostForAnalysis);
	}

	markPostIgnored(postId: string, analysis: unknown, analysisVersion: number, now: string): void {
		this.#database.prepare(`
UPDATE posts SET processing_status = 'ignored', analysis_json = ?, analysis_version = ?,
	processing_error = NULL, analyzed_at = ?, updated_at = ? WHERE id = ?
`).run(JSON.stringify(analysis), analysisVersion, now, now, postId);
	}

	markPostFailed(postId: string, error: string, now: string): void {
		this.#database.prepare(`
UPDATE posts SET processing_status = 'failed', processing_error = ?, updated_at = ? WHERE id = ?
`).run(error.slice(0, 500), now, postId);
	}

	findEventByFingerprint(fingerprint: string): NewsEvent | null {
		const row = this.#database.prepare(`
SELECT id, category, canonical_title, organization, subject, action, event_fingerprint,
	facts_json, status, first_seen_at, last_updated_at, current_report_version, lock_version
FROM events WHERE event_fingerprint = ?`).get(fingerprint) as Row | undefined;
		return row ? mapEvent(row) : null;
	}

	getCurrentReportMarkdown(eventId: string, version: number): string | null {
		if (version < 1) return null;
		const row = this.#database.prepare(
			'SELECT markdown FROM event_reports WHERE event_id = ? AND version = ?',
		).get(eventId, version) as Row | undefined;
		return row ? rowString(row, 'markdown') : null;
	}

	getPostSource(postId: string): EventSourcePost {
		const row = this.#database.prepare(`
SELECT posts.id, posts.x_post_id, monitored_accounts.handle, posts.content,
	posts.published_at, posts.tweet_url
FROM posts
JOIN monitored_accounts ON monitored_accounts.id = posts.account_id
WHERE posts.id = ?`).get(postId) as Row | undefined;
		if (!row) throw new Error(`Post not found: ${postId}`);
		return {
			id: rowString(row, 'id'),
			xPostId: rowString(row, 'x_post_id'),
			handle: rowString(row, 'handle'),
			content: rowString(row, 'content'),
			publishedAt: rowString(row, 'published_at'),
			tweetUrl: rowString(row, 'tweet_url'),
		};
	}

	listEventSourcePosts(eventId: string): EventSourcePost[] {
		return (this.#database.prepare(`
SELECT posts.id, posts.x_post_id, monitored_accounts.handle, posts.content,
	posts.published_at, posts.tweet_url
FROM posts
JOIN monitored_accounts ON monitored_accounts.id = posts.account_id
WHERE posts.event_id = ?
ORDER BY posts.published_at ASC`).all(eventId) as Row[]).map((row) => ({
			id: rowString(row, 'id'),
			xPostId: rowString(row, 'x_post_id'),
			handle: rowString(row, 'handle'),
			content: rowString(row, 'content'),
			publishedAt: rowString(row, 'published_at'),
			tweetUrl: rowString(row, 'tweet_url'),
		}));
	}

	commitEventChange(input: CommitEventChangeInput): CommitEventChangeResult {
		this.#database.exec('BEGIN IMMEDIATE');
		try {
			const current = this.findEventByFingerprint(input.eventFingerprint);
			if (input.expectedEventId === null) {
				if (current) throw new Error('Event was created concurrently; retry the post');
				if (!input.report) throw new Error('A new event must create its first report');
				this.#database.prepare(`
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
				if (!current || current.id !== input.expectedEventId || current.lockVersion !== input.expectedLockVersion) {
					throw new Error('Event version changed concurrently; retry the post');
				}
				const nextReportVersion = input.report
					? current.currentReportVersion + 1
					: current.currentReportVersion;
				const update = this.#database.prepare(`
UPDATE events SET
	category = ?, canonical_title = ?, organization = ?, subject = ?, action = ?,
	facts_json = ?, status = ?, last_updated_at = ?, current_report_version = ?,
	lock_version = lock_version + 1, updated_at = ?
WHERE id = ? AND lock_version = ?`).run(
					input.category,
					input.canonicalTitle,
					input.organization,
					input.subject,
					input.action,
					JSON.stringify(input.facts),
					input.report ? 'updated' : current.status,
					input.now,
					nextReportVersion,
					input.now,
					current.id,
					current.lockVersion,
				);
				if (Number(update.changes) !== 1) throw new Error('Failed to acquire event version lock');
			}

			this.#database.prepare(`
UPDATE posts SET event_id = ?, processing_status = 'processed', analysis_json = ?,
	analysis_version = 1, processing_error = NULL, analyzed_at = ?, updated_at = ?
WHERE id = ?`).run(input.eventId, JSON.stringify(input.analysis), input.now, input.now, input.postId);

			let reportVersion: number | null = null;
			if (input.report) {
				const baseVersion = current?.currentReportVersion ?? 0;
				reportVersion = baseVersion + 1;
				this.#database.prepare(`
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
			this.#database.exec('COMMIT');
			return {
				eventId: input.eventId,
				reportVersion,
				filePath: input.report?.filePath ?? null,
			};
		} catch (error) {
			if (this.#database.isTransaction) this.#database.exec('ROLLBACK');
			throw error;
		}
	}

	listPendingReportExports(): PendingReportExport[] {
		return (this.#database.prepare(`
SELECT event_id, version, markdown, file_path
FROM event_reports
WHERE file_synced_at IS NULL
ORDER BY created_at ASC`).all() as Row[]).map((row) => ({
			eventId: rowString(row, 'event_id'),
			version: rowNumber(row, 'version'),
			markdown: rowString(row, 'markdown'),
			filePath: rowString(row, 'file_path'),
		}));
	}

	markReportFileSynced(eventId: string, version: number, now: string): void {
		this.#database.prepare(`
UPDATE event_reports SET file_synced_at = ?, file_sync_error = NULL WHERE event_id = ? AND version = ?
`).run(now, eventId, version);
	}

	markReportFileFailed(eventId: string, version: number, error: string): void {
		this.#database.prepare(`
UPDATE event_reports SET file_sync_error = ? WHERE event_id = ? AND version = ?
`).run(error.slice(0, 500), eventId, version);
	}
}
