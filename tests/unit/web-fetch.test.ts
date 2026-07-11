import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import { webFetch } from '../../src/tools/web-fetch';

const EXA_URL = 'https://api.exa.ai/contents';
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

function requestBody(call: unknown[]): Record<string, unknown> {
	const init = call[1] as RequestInit;
	return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe('web_fetch', () => {
	beforeEach(() => {
		vi.stubEnv('EXA_API_KEY', 'test-exa-key');
		vi.stubEnv('DEEPSEEK_API_KEY', 'test-deepseek-key');
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it('sends only URLs and a per-page 50,000 character limit to Exa', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
			results: [{ url: 'https://example.com', title: 'Example', text: 'short page' }],
			statuses: [{ id: 'https://example.com', status: 'success' }],
		}));

		const result = await webFetch.run({
			input: { urls: ['https://example.com'], query: 'private research question' },
			signal: undefined,
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(EXA_URL);
		expect(requestBody(fetchMock.mock.calls[0] ?? [])).toEqual({
			urls: ['https://example.com'],
			text: { maxCharacters: 50_000 },
		});
		expect(JSON.stringify(requestBody(fetchMock.mock.calls[0] ?? [])))
			.not.toContain('private research question');
		expect(result.pages[0]?.contentType).toBe('raw');
	});

	it('compresses long content around the research query and caps source input at 50,000 characters', async () => {
		const longContent = `start-${'x'.repeat(50_000)}-must-not-be-sent`;
		const fetchMock = vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(jsonResponse({
				results: [{ url: 'https://example.com/long', title: 'Long page', text: longContent }],
				statuses: [{ id: 'https://example.com/long', status: 'success' }],
			}))
			.mockResolvedValueOnce(jsonResponse({
				choices: [{ message: { content: JSON.stringify({
					overview: 'Relevant summary',
					keyFacts: ['Fact'],
					importantDetails: [],
				}) } }],
			}));

		const result = await webFetch.run({
			input: { urls: ['https://example.com/long'], query: 'What matters?' },
			signal: undefined,
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[1]?.[0]).toBe(DEEPSEEK_URL);
		const deepseekBody = requestBody(fetchMock.mock.calls[1] ?? []);
		const messages = deepseekBody.messages as Array<{ content: string }>;
		expect(messages[1]?.content).toContain('What matters?');
		expect(messages[1]?.content).not.toContain('must-not-be-sent');
		expect(result.pages[0]).toMatchObject({
			contentType: 'compressed',
			fetchedCharacters: longContent.length,
			possiblyTruncated: true,
		});
	});

	it('returns a marked excerpt when long-content compression fails', async () => {
		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(jsonResponse({
				results: [{ url: 'https://example.com/fallback', title: 'Fallback', text: 'x'.repeat(7_000) }],
				statuses: [{ id: 'https://example.com/fallback', status: 'success' }],
			}))
			.mockResolvedValueOnce(jsonResponse({ error: 'unavailable' }, 503));

		const result = await webFetch.run({
			input: { urls: ['https://example.com/fallback'], query: 'Find the facts' },
			signal: undefined,
		});

		expect(result.pages[0]?.contentType).toBe('fallback_excerpt');
		expect(result.pages[0]?.content).toContain('content omitted after compression failure');
		expect(result.pages[0]?.content.length).toBeLessThanOrEqual(6_000);
	});

	it('rejects more than three URLs at the public tool boundary', () => {
		const parsed = v.safeParse(webFetch.input, {
			urls: [
				'https://example.com/1',
				'https://example.com/2',
				'https://example.com/3',
				'https://example.com/4',
			],
			query: 'Research question',
		});

		expect(parsed.success).toBe(false);
	});
});
