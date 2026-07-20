import { describe, expect, it } from 'vitest';
import { normalizeTwitterApiTweet } from '../../src/news/normalizer';

function rawTweet(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: '2078243667081617826',
		text: 'Introducing a new model https://t.co/example',
		createdAt: 'Wed Jul 22 10:00:00 +0000 2026',
		twitterUrl: 'https://x.com/OpenAI/status/2078243667081617826',
		isReply: false,
		inReplyToId: '',
		quoted_tweet: null,
		retweeted_tweet: null,
		author: {
			id: '4398626122',
			userName: 'OpenAI',
			name: 'OpenAI',
			followers: 5_000_000,
		},
		entities: {
			urls: [{ expanded_url: 'https://openai.com/model' }],
		},
		extendedEntities: {
			media: [{ media_url_https: 'https://pbs.twimg.com/model.png' }],
		},
		...overrides,
	};
}

describe('TwitterAPI.io normalizer', () => {
	it('normalizes an original tweet while preserving string IDs', () => {
		const result = normalizeTwitterApiTweet(
			rawTweet(),
			'2026-07-22T10:00:05.000Z',
		);

		expect(result).toMatchObject({
			xPostId: '2078243667081617826',
			postType: 'original',
			publishedAt: '2026-07-22T10:00:00.000Z',
			observedAt: '2026-07-22T10:00:05.000Z',
			author: {
				xUserId: '4398626122',
				handle: 'OpenAI',
			},
		});
		expect(result.urls).toEqual(['https://openai.com/model']);
		expect(result.mediaUrls).toEqual(['https://pbs.twimg.com/model.png']);
	});

	it('distinguishes quote, reply, and repost payloads', () => {
		expect(normalizeTwitterApiTweet(rawTweet({
			quoted_tweet: { id: '100', text: 'Quoted evidence' },
		})).postType).toBe('quote');
		expect(normalizeTwitterApiTweet(rawTweet({
			isReply: true,
			inReplyToId: '101',
		})).postType).toBe('reply');
		expect(normalizeTwitterApiTweet(rawTweet({
			retweeted_tweet: { id: '102', text: 'Reposted content' },
		})).postType).toBe('repost');
	});

	it('rejects malformed provider timestamps', () => {
		expect(() => normalizeTwitterApiTweet(rawTweet({ createdAt: 'not-a-date' })))
			.toThrow('invalid timestamp');
	});
});
