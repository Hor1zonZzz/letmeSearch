import type { TweetMetrics } from "./types";

type FetchImplementation = typeof globalThis.fetch;

type TwitterApiClientOptions = {
	apiKey?: string;
	fetch?: FetchImplementation;
	timeoutMs?: number;
};

export type LatestTweetsResponse = {
	tweets: unknown[];
	hasNextPage: boolean;
	nextCursor: string | null;
};

export type LatestTweetsPageOptions = {
	cursor?: string | null;
	includeReplies?: boolean;
	signal?: AbortSignal;
};

export type ArticleResponse = {
	article: Record<string, unknown> | null;
};

const API_BASE_URL = "https://api.twitterapi.io";
const DEFAULT_TIMEOUT_MS = 20_000;

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: {};
}

function metricCount(tweet: Record<string, unknown>, key: string): number {
	const value = tweet[key];
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new Error(`TwitterAPI.io returned invalid ${key}`);
	}
	return value as number;
}

function configuredApiKey(): string {
	const value =
		process.env.TWITTERAPI_IO_KEY?.trim() ??
		process.env.TWITTERAPI_IO_API_KEY?.trim();
	if (!value)
		throw new Error("Missing required environment variable: TWITTERAPI_IO_KEY");
	return value;
}

export class TwitterApiClient {
	readonly #apiKey: string;
	readonly #fetch: FetchImplementation;
	readonly #timeoutMs: number;

	constructor(options: TwitterApiClientOptions = {}) {
		this.#apiKey = options.apiKey?.trim() || configuredApiKey();
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	async fetchLatestTweets(
		handle: string,
		limit: number,
		signal?: AbortSignal,
	): Promise<LatestTweetsResponse> {
		const page = await this.fetchLatestTweetsPage(handle, { signal });
		return { ...page, tweets: page.tweets.slice(0, limit) };
	}

	async fetchTweetMetrics(xPostIds: string[]): Promise<TweetMetrics[]> {
		if (xPostIds.length === 0) return [];
		if (xPostIds.length > 50)
			throw new Error("TwitterAPI.io accepts at most 50 tweet IDs");
		const url = new URL("/twitter/tweets", API_BASE_URL);
		url.searchParams.set("tweet_ids", xPostIds.join(","));
		const response = await this.#fetch(url, {
			headers: { "X-API-Key": this.#apiKey },
			signal: AbortSignal.timeout(this.#timeoutMs),
		});
		const text = await response.text();
		if (!response.ok) {
			throw new Error(
				`TwitterAPI.io metrics request failed (${response.status}): ${text.slice(0, 500)}`,
			);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text) as unknown;
		} catch {
			throw new Error("TwitterAPI.io returned invalid metrics JSON");
		}
		const root = asRecord(parsed);
		if (typeof root.status === "string" && root.status !== "success") {
			throw new Error(
				`TwitterAPI.io returned a metrics error: ${String(root.msg ?? root.message ?? root.status).slice(0, 500)}`,
			);
		}
		const tweets = Array.isArray(root.tweets) ? root.tweets : [];
		return tweets.map((value) => {
			const tweet = asRecord(value);
			if (typeof tweet.id !== "string" || tweet.id.length === 0) {
				throw new Error("TwitterAPI.io returned metrics without a tweet ID");
			}
			return {
				xPostId: tweet.id,
				views: metricCount(tweet, "viewCount"),
				likes: metricCount(tweet, "likeCount"),
				reposts: metricCount(tweet, "retweetCount"),
				replies: metricCount(tweet, "replyCount"),
				quotes: metricCount(tweet, "quoteCount"),
			};
		});
	}

	async fetchArticle(
		tweetId: string,
		signal?: AbortSignal,
	): Promise<ArticleResponse> {
		const url = new URL("/twitter/article", API_BASE_URL);
		url.searchParams.set("tweet_id", tweetId);
		const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
		const response = await this.#fetch(url, {
			headers: { "X-API-Key": this.#apiKey },
			signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
		});
		const text = await response.text();
		if (!response.ok) {
			throw new Error(
				`TwitterAPI.io article request failed (${response.status}): ${text.slice(0, 500)}`,
			);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text) as unknown;
		} catch {
			throw new Error("TwitterAPI.io returned invalid article JSON");
		}
		const root = asRecord(parsed);
		if (typeof root.status === "string" && root.status !== "success") {
			throw new Error(
				`TwitterAPI.io returned an article error: ${String(root.msg ?? root.message ?? root.status).slice(0, 500)}`,
			);
		}
		return {
			article:
				typeof root.article === "object" && root.article !== null
					? (root.article as Record<string, unknown>)
					: null,
		};
	}

	async fetchLatestTweetsPage(
		handle: string,
		options: LatestTweetsPageOptions = {},
	): Promise<LatestTweetsResponse> {
		const url = new URL("/twitter/user/last_tweets", API_BASE_URL);
		url.searchParams.set("userName", handle);
		url.searchParams.set(
			"includeReplies",
			String(options.includeReplies ?? false),
		);
		if (options.cursor) url.searchParams.set("cursor", options.cursor);
		const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
		const response = await this.#fetch(url, {
			headers: { "X-API-Key": this.#apiKey },
			signal: options.signal
				? AbortSignal.any([options.signal, timeoutSignal])
				: timeoutSignal,
		});
		const text = await response.text();
		if (!response.ok) {
			throw new Error(
				`TwitterAPI.io request failed (${response.status}): ${text.slice(0, 500)}`,
			);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(text) as unknown;
		} catch {
			throw new Error("TwitterAPI.io returned invalid JSON");
		}
		const root = asRecord(parsed);
		if (typeof root.status === "string" && root.status !== "success") {
			throw new Error(
				`TwitterAPI.io returned an error: ${String(root.msg ?? root.message ?? root.status).slice(0, 500)}`,
			);
		}
		const data = asRecord(root.data);
		let rawTweets: unknown[] = [];
		if (Array.isArray(data.tweets)) rawTweets = data.tweets;
		else if (Array.isArray(root.tweets)) rawTweets = root.tweets;
		return {
			tweets: rawTweets,
			hasNextPage: root.has_next_page === true,
			nextCursor:
				typeof root.next_cursor === "string" && root.next_cursor.length > 0
					? root.next_cursor
					: null,
		};
	}
}
