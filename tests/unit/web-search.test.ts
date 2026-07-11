import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebSearch } from '../../src/tools/web-search';

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

describe('web_search', () => {
	beforeEach(() => {
		vi.stubEnv('SERPER_API_KEY', 'test-serper-key');
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
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

});
