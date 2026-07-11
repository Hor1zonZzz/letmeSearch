import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { asRecord, asString, fetchJson, requiredEnv } from './http';

const searchResultSchema = v.object({
	title: v.string(),
	url: v.string(),
	snippet: v.string(),
	sitelinks: v.optional(v.array(v.object({
		title: v.string(),
		url: v.string(),
	}))),
});

const SERPER_SEARCH_URL = 'https://google.serper.dev/search';
const MAX_SEARCH_RESULTS = 10;

export type WebSearchRunState = {
	seenUrls: Set<string>;
};

function normalizeUrl(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		url.hash = '';
		url.hostname = url.hostname.toLowerCase();
		if (
			(url.protocol === 'https:' && url.port === '443') ||
			(url.protocol === 'http:' && url.port === '80')
		) {
			url.port = '';
		}
		if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
		for (const key of [...url.searchParams.keys()]) {
			if (key.toLowerCase().startsWith('utm_') || ['fbclid', 'gclid'].includes(key.toLowerCase())) {
				url.searchParams.delete(key);
			}
		}
		url.searchParams.sort();
		return url.toString();
	} catch {
		return rawUrl;
	}
}

export function createWebSearch(state: WebSearchRunState) {
	return defineTool({
	name: 'web_search',
	description:
		'Search the live web with Google. Returns only URLs not already shown by web_search during this research run. If most results are duplicates, use a meaningfully different query or stop searching. Fetch promising URLs with web_fetch before answering.',
	input: v.object({
		query: v.pipe(
			v.string(),
			v.minLength(2),
			v.maxLength(500),
			v.description('A focused web search query'),
		),
	}),
	output: v.object({
		query: v.string(),
		results: v.array(searchResultSchema),
		stats: v.object({
			receivedResults: v.number(),
			returnedResults: v.number(),
			duplicateUrlsFiltered: v.number(),
		}),
	}),

	async run({ input, signal }) {
		const payload = asRecord(
			await fetchJson(
				SERPER_SEARCH_URL,
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'X-API-KEY': requiredEnv('SERPER_API_KEY'),
					},
					body: JSON.stringify({
						q: input.query,
						gl: 'us',
						hl: 'en',
					}),
				},
				signal,
			),
		);

		const organic = Array.isArray(payload.organic) ? payload.organic : [];
		const candidateResults = organic.slice(0, MAX_SEARCH_RESULTS);
		let duplicateUrlsFiltered = 0;
		const results = candidateResults.flatMap((item) => {
			const result = asRecord(item);
			const url = asString(result.link);
			if (!url) return [];
			const normalizedUrl = normalizeUrl(url);
			if (state.seenUrls.has(normalizedUrl)) {
				duplicateUrlsFiltered += 1;
				return [];
			}
			state.seenUrls.add(normalizedUrl);
			const sitelinks = (Array.isArray(result.sitelinks) ? result.sitelinks : [])
				.flatMap((item) => {
					const sitelink = asRecord(item);
					const sitelinkUrl = asString(sitelink.link);
					if (!sitelinkUrl) return [];
					const normalizedSitelinkUrl = normalizeUrl(sitelinkUrl);
					if (state.seenUrls.has(normalizedSitelinkUrl)) {
						duplicateUrlsFiltered += 1;
						return [];
					}
					state.seenUrls.add(normalizedSitelinkUrl);
					return [{
						title: asString(sitelink.title) ?? sitelinkUrl,
						url: sitelinkUrl,
					}];
				});
			return [{
				title: asString(result.title) ?? url,
				url,
				snippet: asString(result.snippet) ?? '',
				...(sitelinks.length > 0 ? { sitelinks } : {}),
			}];
		});

		return {
			query: input.query,
			results,
			stats: {
				receivedResults: organic.length,
				returnedResults: results.length,
				duplicateUrlsFiltered,
			},
		};
	},
});
}
