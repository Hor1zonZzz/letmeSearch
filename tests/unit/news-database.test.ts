import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { NewsDatabase } from '../../src/news/database';
import type { MonitoredAccount, NormalizedPost } from '../../src/news/types';

function normalizedPost(overrides: Partial<NormalizedPost> = {}): NormalizedPost {
	return {
		xPostId: '2078243667081617826',
		author: {
			xUserId: '4398626122',
			handle: 'OpenAI',
			displayName: 'OpenAI',
			followersCount: 5_000_000,
			rawPayload: { id: '4398626122' },
		},
		postType: 'original',
		content: 'Introducing GPT Example',
		publishedAt: '2026-07-22T10:00:00.000Z',
		observedAt: '2026-07-22T10:00:05.000Z',
		tweetUrl: 'https://x.com/OpenAI/status/2078243667081617826',
		quotedXPostId: null,
		quotedPost: null,
		urls: [],
		mediaUrls: [],
		rawPayload: { id: '2078243667081617826' },
		...overrides,
	};
}

describe('official news database', () => {
	const databases: NewsDatabase[] = [];

	afterEach(() => {
		for (const database of databases.splice(0)) database.close();
	});

	function database(): NewsDatabase {
		const database = new NewsDatabase(':memory:');
		databases.push(database);
		return database;
	}

	function onlyAccount(database: NewsDatabase): MonitoredAccount {
		const [account] = database.listEnabledAccounts();
		if (!account) throw new Error('Expected one monitored account');
		return account;
	}

	it('seeds accounts and idempotently stores posts', () => {
		const db = database();
		db.seedAccounts([{ handle: 'OpenAI', organization: 'OpenAI' }]);
		db.seedAccounts([{ handle: 'openai', organization: 'OpenAI' }]);
		const account = onlyAccount(db);
		expect(account.handle).toBe('OpenAI');

		const first = db.upsertPost(account.id, normalizedPost());
		const duplicate = db.upsertPost(account.id, normalizedPost());

		expect(first.isNew).toBe(true);
		expect(duplicate.isNew).toBe(false);
		expect(db.listPostsForAnalysis()).toHaveLength(1);
	});

	it('queues successful tracked analyses for independent Topic resolution', () => {
		const db = database();
		db.seedAccounts([{ handle: 'OpenAI', organization: 'OpenAI' }]);
		const account = onlyAccount(db);
		const post = db.upsertPost(account.id, normalizedPost()).post;
		const now = '2026-07-22T10:01:00.000Z';
		db.savePostTopicAnalysis({
			postId: post.id,
			decision: 'observe',
			isImportant: false,
			domain: 'ai_technology',
			organizationIds: ['openai'],
			unknownOrganizationCandidates: [],
			topicCandidate: {
				titleZh: 'OpenAI 发布 GPT Example',
				titleEn: 'OpenAI Releases GPT Example',
				summaryZh: 'OpenAI 发布测试模型。',
				summaryEn: 'OpenAI released a test model.',
				type: 'model_release',
			},
			reason: 'Potential release',
			confidence: 0.8,
		}, 1, now);
		db.queuePostTopicResolution(post.id, 1, now);

		expect(db.listPendingTopicResolutions(10, 1, now)).toEqual([
			expect.objectContaining({
				postId: post.id,
				xPostId: post.xPostId,
				organizationIds: ['openai'],
				attemptCount: 0,
				resolutionVersion: 1,
			}),
		]);
	});

	it('commits an event and immutable report version atomically', () => {
		const db = database();
		db.seedAccounts([{ handle: 'OpenAI', organization: 'OpenAI' }]);
		const account = onlyAccount(db);
		const post = db.upsertPost(account.id, normalizedPost()).post;
		const eventId = randomUUID();
		const now = '2026-07-22T10:01:00.000Z';

		const result = db.commitEventChange({
			eventId,
			expectedEventId: null,
			expectedLockVersion: null,
			postId: post.id,
			analysis: { isImportant: true },
			category: 'ai_tech',
			canonicalTitle: 'OpenAI 发布 GPT Example',
			organization: 'OpenAI',
			subject: 'GPT Example',
			action: '发布',
			eventFingerprint: 'fingerprint-1',
			facts: [{ text: 'OpenAI 发布了 GPT Example', sourcePostIds: [post.xPostId] }],
			now,
			report: {
				markdown: '# OpenAI 发布 GPT Example',
				changeSummary: '创建首版快讯',
				eventSnapshot: { id: eventId },
				sourcePostIds: [post.xPostId],
				createdByRunId: 'run-1',
				filePath: `/tmp/${eventId}.md`,
			},
		});

		expect(result.reportVersion).toBe(1);
		expect(db.findEventByFingerprint('fingerprint-1')).toMatchObject({
			id: eventId,
			currentReportVersion: 1,
		});
		expect(db.getCurrentReportMarkdown(eventId, 1)).toContain('GPT Example');
		expect(db.listPendingReportExports()).toEqual([{
			eventId,
			version: 1,
			markdown: '# OpenAI 发布 GPT Example',
			filePath: `/tmp/${eventId}.md`,
		}]);
		db.markReportFileSynced(eventId, 1, now);
		expect(db.listPendingReportExports()).toEqual([]);
	});

	it('creates a new report version only when the caller supplies a material report', () => {
		const db = database();
		db.seedAccounts([{ handle: 'OpenAI', organization: 'OpenAI' }]);
		const account = onlyAccount(db);
		const firstPost = db.upsertPost(account.id, normalizedPost()).post;
		const eventId = randomUUID();
		const firstNow = '2026-07-22T10:01:00.000Z';
		db.commitEventChange({
			eventId,
			expectedEventId: null,
			expectedLockVersion: null,
			postId: firstPost.id,
			analysis: { isImportant: true },
			category: 'ai_tech',
			canonicalTitle: 'OpenAI 发布 GPT Example',
			organization: 'OpenAI',
			subject: 'GPT Example',
			action: '发布',
			eventFingerprint: 'fingerprint-versioning',
			facts: [{ text: 'OpenAI 发布了 GPT Example', sourcePostIds: [firstPost.xPostId] }],
			now: firstNow,
			report: {
				markdown: '# v1',
				changeSummary: '首版',
				eventSnapshot: { version: 1 },
				sourcePostIds: [firstPost.xPostId],
				createdByRunId: 'run-1',
				filePath: `/tmp/${eventId}.md`,
			},
		});

		const secondPost = db.upsertPost(account.id, normalizedPost({
			xPostId: '2078243667081617827',
			content: 'GPT Example is now available in the API',
			tweetUrl: 'https://x.com/OpenAI/status/2078243667081617827',
		})).post;
		const versionOne = db.findEventByFingerprint('fingerprint-versioning');
		if (!versionOne) throw new Error('Expected the first event version');
		const second = db.commitEventChange({
			eventId,
			expectedEventId: eventId,
			expectedLockVersion: versionOne.lockVersion,
			postId: secondPost.id,
			analysis: { isImportant: true },
			category: 'ai_tech',
			canonicalTitle: versionOne.canonicalTitle,
			organization: 'OpenAI',
			subject: 'GPT Example',
			action: '发布',
			eventFingerprint: 'fingerprint-versioning',
			facts: [
				...versionOne.facts,
				{ text: 'GPT Example 已在 API 上线', sourcePostIds: [secondPost.xPostId] },
			],
			now: '2026-07-22T10:02:00.000Z',
			report: {
				markdown: '# v2',
				changeSummary: '补充 API 上线信息',
				eventSnapshot: { version: 2 },
				sourcePostIds: [firstPost.xPostId, secondPost.xPostId],
				createdByRunId: 'run-2',
				filePath: `/tmp/${eventId}.md`,
			},
		});

		expect(second.reportVersion).toBe(2);
		expect(db.getCurrentReportMarkdown(eventId, 2)).toBe('# v2');
		expect(db.findEventByFingerprint('fingerprint-versioning')).toMatchObject({
			currentReportVersion: 2,
			lockVersion: 1,
		});
	});

});
