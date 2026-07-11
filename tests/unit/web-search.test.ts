import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebSearch } from '../../src/tools/web-search';

const SERPER_URL = 'https://google.serper.dev/search';

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

function requestBody(call: unknown[]): Record<string, unknown> {
	const init = call[1] as RequestInit;
	return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe('web_search', () => {
	beforeEach(() => {
		vi.stubEnv('SERPER_API_KEY', 'test-serper-key');
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it('uses the fixed Serper search contract without a num parameter', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ organic: [] }));
		const tool = createWebSearch({ seenUrls: new Set<string>() });

		await tool.run({ input: { query: 'Flue framework' }, signal: undefined });

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(SERPER_URL);
		expect(requestBody(fetchMock.mock.calls[0] ?? [])).toEqual({
			q: 'Flue framework',
			gl: 'us',
			hl: 'en',
		});
		expect(requestBody(fetchMock.mock.calls[0] ?? [])).not.toHaveProperty('num');
	});

	it('maps sitelinks when present and omits the field when absent', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
			organic: [
				{
					title: 'Flue',
					link: 'https://flueframework.com/',
					snippet: 'Agent framework',
					sitelinks: [
						{ title: 'Documentation', link: 'https://flueframework.com/docs' },
					],
				},
				{
					title: 'GitHub',
					link: 'https://github.com/withastro/flue',
					snippet: 'Source repository',
				},
			],
		}));
		const tool = createWebSearch({ seenUrls: new Set<string>() });

		const result = await tool.run({ input: { query: 'Flue' }, signal: undefined });

		expect(result.results[0]?.sitelinks).toEqual([
			{ title: 'Documentation', url: 'https://flueframework.com/docs' },
		]);
		expect(result.results[1]).not.toHaveProperty('sitelinks');
	});

	it('filters equivalent URLs already returned during the same research run', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(jsonResponse({
				organic: [{
					title: 'First result',
					link: 'https://example.com/article/?utm_source=search#section',
					snippet: 'First appearance',
				}],
			}))
			.mockResolvedValueOnce(jsonResponse({
				organic: [{
					title: 'Duplicate result',
					link: 'https://example.com/article',
					snippet: 'Same page with a normalized URL',
				}],
			}));
		const tool = createWebSearch({ seenUrls: new Set<string>() });

		const first = await tool.run({ input: { query: 'first query' }, signal: undefined });
		const second = await tool.run({ input: { query: 'second query' }, signal: undefined });

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(first.results).toHaveLength(1);
		expect(second.results).toEqual([]);
		expect(second.stats).toMatchObject({
			receivedResults: 1,
			returnedResults: 0,
			duplicateUrlsFiltered: 1,
		});
	});
});
