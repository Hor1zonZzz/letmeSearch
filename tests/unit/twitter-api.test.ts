import { describe, expect, it, vi } from 'vitest';
import { TwitterApiClient } from '../../src/news/twitter-api';

function parseRequestUrl(input: URL | RequestInfo): URL {
	try {
		return new URL(String(input));
	} catch (error) {
		throw new Error('Test received an invalid request URL', { cause: error });
	}
}

describe('TwitterApiClient', () => {
	it('reads the actual nested data.tweets response shape and applies the local limit', async () => {
		const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
			const url = parseRequestUrl(input);
			expect(url.pathname).toBe('/twitter/user/last_tweets');
			expect(url.searchParams.get('userName')).toBe('OpenAI');
			expect(url.searchParams.get('includeReplies')).toBe('false');
			expect(new Headers(init?.headers).get('X-API-Key')).toBe('test-key');
			return new Response(JSON.stringify({
				status: 'success',
				data: { tweets: [{ id: '1' }, { id: '2' }] },
				has_next_page: true,
				next_cursor: 'cursor-1',
			}));
		});
		const client = new TwitterApiClient({ apiKey: 'test-key', fetch: fetchMock as typeof fetch });

		const result = await client.fetchLatestTweets('OpenAI', 1);

		expect(result).toEqual({
			tweets: [{ id: '1' }],
			hasNextPage: true,
			nextCursor: 'cursor-1',
		});
	});

	it('surfaces provider-level errors', async () => {
		const client = new TwitterApiClient({
			apiKey: 'test-key',
			fetch: vi.fn(async () => new Response(JSON.stringify({
				status: 'error',
				msg: 'invalid account',
			}))) as typeof fetch,
		});

		await expect(client.fetchLatestTweets('missing', 5))
			.rejects.toThrow('invalid account');
	});
});
