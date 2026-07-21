import { describe, expect, it, vi } from "vitest";
import { TwitterApiClient } from "../../src/news/twitter-api";

function parseRequestUrl(input: URL | RequestInfo): URL {
	try {
		return new URL(String(input));
	} catch (error) {
		throw new Error("Test received an invalid request URL", { cause: error });
	}
}

describe("TwitterApiClient", () => {
	it("reads the actual nested data.tweets response shape and applies the local limit", async () => {
		const fetchMock = vi.fn(
			async (input: URL | RequestInfo, init?: RequestInit) => {
				const url = parseRequestUrl(input);
				expect(url.pathname).toBe("/twitter/user/last_tweets");
				expect(url.searchParams.get("userName")).toBe("OpenAI");
				expect(url.searchParams.get("includeReplies")).toBe("false");
				expect(new Headers(init?.headers).get("X-API-Key")).toBe("test-key");
				return new Response(
					JSON.stringify({
						status: "success",
						data: { tweets: [{ id: "1" }, { id: "2" }] },
						has_next_page: true,
						next_cursor: "cursor-1",
					}),
				);
			},
		);
		const client = new TwitterApiClient({
			apiKey: "test-key",
			fetch: fetchMock as typeof fetch,
		});

		const result = await client.fetchLatestTweets("OpenAI", 1);

		expect(result).toEqual({
			tweets: [{ id: "1" }],
			hasNextPage: true,
			nextCursor: "cursor-1",
		});
	});

	it("requests reply-inclusive cursor pages without truncating them", async () => {
		const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
			const url = parseRequestUrl(input);
			expect(url.searchParams.get("includeReplies")).toBe("true");
			expect(url.searchParams.get("cursor")).toBe("older-page");
			return new Response(
				JSON.stringify({
					status: "success",
					data: { tweets: [{ id: "1" }, { id: "2" }] },
					has_next_page: false,
					next_cursor: "",
				}),
			);
		});
		const client = new TwitterApiClient({
			apiKey: "test-key",
			fetch: fetchMock as typeof fetch,
		});

		const result = await client.fetchLatestTweetsPage("OpenAI", {
			cursor: "older-page",
			includeReplies: true,
		});

		expect(result).toEqual({
			tweets: [{ id: "1" }, { id: "2" }],
			hasNextPage: false,
			nextCursor: null,
		});
	});

	it("fetches current metrics for a batch of X post IDs", async () => {
		const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
			const url = parseRequestUrl(input);
			expect(url.pathname).toBe("/twitter/tweets");
			expect(url.searchParams.get("tweet_ids")).toBe("post-1,post-2");
			return new Response(
				JSON.stringify({
					status: "success",
					tweets: [
						{
							id: "post-1",
							viewCount: 1200,
							likeCount: 30,
							retweetCount: 4,
							replyCount: 5,
							quoteCount: 2,
						},
						{
							id: "post-2",
							viewCount: 900,
							likeCount: 20,
							retweetCount: 3,
							replyCount: 1,
							quoteCount: 0,
						},
					],
				}),
			);
		});
		const client = new TwitterApiClient({
			apiKey: "test-key",
			fetch: fetchMock as typeof fetch,
		});

		await expect(
			client.fetchTweetMetrics(["post-1", "post-2"]),
		).resolves.toEqual([
			{
				xPostId: "post-1",
				views: 1200,
				likes: 30,
				reposts: 4,
				replies: 5,
				quotes: 2,
			},
			{
				xPostId: "post-2",
				views: 900,
				likes: 20,
				reposts: 3,
				replies: 1,
				quotes: 0,
			},
		]);
	});

	it("fetches an X Article by tweet ID", async () => {
		const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
			const url = parseRequestUrl(input);
			expect(url.pathname).toBe("/twitter/article");
			expect(url.searchParams.get("tweet_id")).toBe("article-tweet");
			return new Response(
				JSON.stringify({
					status: "success",
					article: { title: "Full article", contents: [{ text: "Body" }] },
				}),
			);
		});
		const client = new TwitterApiClient({
			apiKey: "test-key",
			fetch: fetchMock as typeof fetch,
		});

		const result = await client.fetchArticle("article-tweet");

		expect(result.article).toMatchObject({ title: "Full article" });
	});

	it("surfaces provider-level errors", async () => {
		const client = new TwitterApiClient({
			apiKey: "test-key",
			fetch: vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							status: "error",
							msg: "invalid account",
						}),
					),
			) as typeof fetch,
		});

		await expect(client.fetchLatestTweets("missing", 5)).rejects.toThrow(
			"invalid account",
		);
	});
});
