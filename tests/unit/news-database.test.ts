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
	});

	it('queues successful tracked analyses for independent Topic resolution', () => {
		const db = database();
		db.seedAccounts([{ handle: 'OpenAI', organization: 'OpenAI' }]);
		const account = onlyAccount(db);
		const post = db.upsertPost(account.id, normalizedPost()).post;
		const now = '2026-07-22T10:01:00.000Z';
		db.savePostTopicAnalysis({
			postId: post.id,
			decision: 'important',
			isImportant: true,
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
			reason: 'Important release',
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

	it('commits Topic batches with optimistic revisions', () => {
		const db = database();
		db.seedAccounts([{ handle: 'OpenAI', organization: 'OpenAI' }]);
		db.seedOrganizations([
			{ id: 'openai', nameZh: 'OpenAI', nameEn: 'OpenAI', aliases: [] },
		]);
		const account = onlyAccount(db);
		const first = db.upsertPost(account.id, normalizedPost()).post;
		const second = db.upsertPost(account.id, normalizedPost({
			xPostId: '2078243667081617827',
			tweetUrl: 'https://x.com/OpenAI/status/2078243667081617827',
		})).post;
		const saveAnalysis = (postId: string) => {
			db.savePostTopicAnalysis({
				postId,
				decision: 'important',
				isImportant: true,
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
				reason: 'Model release',
				confidence: 0.9,
			}, 1, '2026-07-22T10:01:00.000Z');
			db.queuePostTopicResolution(postId, 1, '2026-07-22T10:01:00.000Z');
		};
		saveAnalysis(first.id);
		saveAnalysis(second.id);
		const topic = {
			titleZh: 'OpenAI 发布 GPT Example',
			titleEn: 'OpenAI Releases GPT Example',
			summaryZh: 'OpenAI 发布测试模型。',
			summaryEn: 'OpenAI released a test model.',
			type: 'model_release' as const,
		};
		const created = db.commitTopicBatch({
			postIds: [first.id],
			decision: 'create',
			targetTopicId: null,
			expectedTopicRevision: null,
			topic,
			searchTrace: { searches: [] },
			modelRunId: 'run-1',
			resolutionVersion: 1,
			now: '2026-07-22T10:02:00.000Z',
		});
		db.commitTopicBatch({
			postIds: [second.id],
			decision: 'attach',
			targetTopicId: created.topicId,
			expectedTopicRevision: 0,
			topic: null,
			searchTrace: { searches: ['search-1'] },
			modelRunId: 'run-2',
			resolutionVersion: 1,
			now: '2026-07-22T10:03:00.000Z',
		});

		expect(db.listTopicsForSearch('2026-07-19T00:00:00.000Z', '2026-07-23T00:00:00.000Z')).toEqual([
			expect.objectContaining({ id: created.topicId, revision: 1 }),
		]);
	});

});
