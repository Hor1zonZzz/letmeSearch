import { afterEach, describe, expect, it, vi } from "vitest";
import { NewsDatabase } from "../../src/news/database";
import { ingestNews, type TweetPageClient } from "../../src/news/ingest";
import { normalizeTwitterApiTweet } from "../../src/news/normalizer";
import type { LatestTweetsResponse } from "../../src/news/twitter-api";

function rawTweet(
	id: string,
	createdAt: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id,
		text: `Tweet ${id}`,
		createdAt,
		twitterUrl: `https://x.com/OpenAI/status/${id}`,
		isReply: false,
		inReplyToId: "",
		quoted_tweet: null,
		retweeted_tweet: null,
		author: {
			id: "4398626122",
			userName: "OpenAI",
			name: "OpenAI",
			followers: 5_000_000,
		},
		...overrides,
	};
}

function page(
	tweets: unknown[],
	hasNextPage = false,
	nextCursor: string | null = null,
): LatestTweetsResponse {
	return { tweets, hasNextPage, nextCursor };
}

describe("news ingestion", () => {
	const databases: NewsDatabase[] = [];

	afterEach(() => {
		for (const database of databases.splice(0)) database.close();
	});

	function database(): NewsDatabase {
		const database = new NewsDatabase(":memory:");
		databases.push(database);
		return database;
	}

	it("stores one initial page including originals, quotes, replies, and reposts", async () => {
		const db = database();
		db.seedAccounts([{ handle: "OpenAI", organization: "OpenAI" }]);
		const tweets = [
			rawTweet("1", "Wed Jul 22 10:00:00 +0000 2026"),
			rawTweet("2", "Wed Jul 22 09:00:00 +0000 2026", {
				quoted_tweet: { id: "quoted", text: "Quoted" },
			}),
			rawTweet("3", "Wed Jul 22 08:00:00 +0000 2026", {
				isReply: true,
				inReplyToId: "parent",
			}),
			rawTweet("4", "Wed Jul 22 07:00:00 +0000 2026", {
				retweeted_tweet: { id: "reposted", text: "Reposted" },
			}),
		];
		const client: TweetPageClient = {
			fetchLatestTweetsPage: vi.fn(async () => page(tweets, true, "older")),
		};

		const stats = await ingestNews({ database: db, client });

		expect(stats).toMatchObject({
			accountsAttempted: 1,
			accountsSucceeded: 1,
			fetchedPosts: 4,
			newPosts: 4,
			ignoredPosts: 2,
			errors: [],
		});
		for (const id of ["1", "2", "3", "4"]) expect(db.hasPost(id)).toBe(true);
		expect(db.listPostsForAnalysis()).toHaveLength(2);
		expect(client.fetchLatestTweetsPage).toHaveBeenCalledOnce();
		expect(client.fetchLatestTweetsPage).toHaveBeenCalledWith("OpenAI", {
			cursor: null,
			includeReplies: true,
		});
	});

	it("uses cursors until it reaches the previous successful timestamp boundary", async () => {
		const db = database();
		db.seedAccounts([{ handle: "OpenAI", organization: "OpenAI" }]);
		const [account] = db.listEnabledAccounts();
		if (!account) throw new Error("Expected an account");
		const baseline = normalizeTwitterApiTweet(
			rawTweet("boundary", "Mon Jul 20 10:00:00 +0000 2026"),
			"2026-07-20T10:01:00.000Z",
		);
		db.upsertPost(account.id, baseline);
		db.recordAccountIngestSuccess(
			account.id,
			baseline.author,
			baseline.publishedAt,
			"2026-07-20T10:01:00.000Z",
		);
		const fetchLatestTweetsPage = vi
			.fn<TweetPageClient["fetchLatestTweetsPage"]>()
			.mockResolvedValueOnce(
				page(
					[
						rawTweet("new-1", "Wed Jul 22 10:00:00 +0000 2026"),
						rawTweet("new-2", "Tue Jul 21 10:00:00 +0000 2026"),
					],
					true,
					"page-2",
				),
			)
			.mockResolvedValueOnce(
				page(
					[
						rawTweet("boundary", "Mon Jul 20 10:00:00 +0000 2026"),
						rawTweet("same-time-new", "Mon Jul 20 10:00:00 +0000 2026"),
						rawTweet("older", "Sun Jul 19 10:00:00 +0000 2026"),
					],
					true,
					"page-3",
				),
			);

		const stats = await ingestNews({
			database: db,
			client: { fetchLatestTweetsPage },
		});

		expect(fetchLatestTweetsPage).toHaveBeenNthCalledWith(1, "OpenAI", {
			cursor: null,
			includeReplies: true,
		});
		expect(fetchLatestTweetsPage).toHaveBeenNthCalledWith(2, "OpenAI", {
			cursor: "page-2",
			includeReplies: true,
		});
		expect(stats.newPosts).toBe(3);
		expect(db.hasPost("new-1")).toBe(true);
		expect(db.hasPost("new-2")).toBe(true);
		expect(db.hasPost("same-time-new")).toBe(true);
		expect(db.hasPost("older")).toBe(false);
		expect(db.listEnabledAccounts()[0]?.ingestBoundaryPostAt).toBe(
			"2026-07-22T10:00:00.000Z",
		);
	});

	it("does not truncate established-account pages before the boundary", async () => {
		const db = database();
		db.seedAccounts([{ handle: "OpenAI", organization: "OpenAI" }]);
		const [account] = db.listEnabledAccounts();
		if (!account) throw new Error("Expected an account");
		const baseline = normalizeTwitterApiTweet(
			rawTweet("boundary", "Wed Jul 01 00:00:00 +0000 2026"),
		);
		db.upsertPost(account.id, baseline);
		db.recordAccountIngestSuccess(
			account.id,
			baseline.author,
			baseline.publishedAt,
			"2026-07-01T00:01:00.000Z",
		);
		const newerTweets = Array.from({ length: 25 }, (_, index) =>
			rawTweet(
				`new-${index}`,
				new Date(Date.UTC(2026, 6, 22, 0, 0, -index)).toUTCString(),
			),
		);
		const client: TweetPageClient = {
			fetchLatestTweetsPage: vi.fn(async () =>
				page([
					...newerTweets,
					rawTweet("boundary", "Wed Jul 01 00:00:00 +0000 2026"),
				]),
			),
		};

		const stats = await ingestNews({ database: db, client });

		expect(stats.fetchedPosts).toBe(26);
		expect(stats.newPosts).toBe(25);
		expect(db.hasPost("new-24")).toBe(true);
	});

	it("does not advance the boundary when pagination ends before reaching it", async () => {
		const db = database();
		db.seedAccounts([{ handle: "OpenAI", organization: "OpenAI" }]);
		const [account] = db.listEnabledAccounts();
		if (!account) throw new Error("Expected an account");
		const baseline = normalizeTwitterApiTweet(
			rawTweet("boundary", "Mon Jul 20 10:00:00 +0000 2026"),
		);
		db.recordAccountIngestSuccess(
			account.id,
			baseline.author,
			baseline.publishedAt,
			"2026-07-20T10:01:00.000Z",
		);
		const client: TweetPageClient = {
			fetchLatestTweetsPage: vi.fn(async () =>
				page([rawTweet("new-1", "Wed Jul 22 10:00:00 +0000 2026")]),
			),
		};

		const stats = await ingestNews({ database: db, client });

		expect(stats.accountsSucceeded).toBe(0);
		expect(stats.errors[0]?.message).toContain(
			"before the previous ingest boundary",
		);
		expect(db.listEnabledAccounts()[0]?.ingestBoundaryPostAt).toBe(
			baseline.publishedAt,
		);
	});

	it("keeps the ingest boundary monotonic", () => {
		const db = database();
		db.seedAccounts([{ handle: "OpenAI", organization: "OpenAI" }]);
		const [account] = db.listEnabledAccounts();
		if (!account) throw new Error("Expected an account");

		db.recordAccountIngestSuccess(
			account.id,
			null,
			"2026-07-22T10:00:00.000Z",
			"2026-07-22T10:01:00.000Z",
		);
		db.recordAccountIngestSuccess(
			account.id,
			null,
			"2026-07-21T10:00:00.000Z",
			"2026-07-22T10:02:00.000Z",
		);

		expect(db.listEnabledAccounts()[0]?.ingestBoundaryPostAt).toBe(
			"2026-07-22T10:00:00.000Z",
		);
	});

	it("caps an initial provider page at 20 tweets", async () => {
		const db = database();
		db.seedAccounts([{ handle: "OpenAI", organization: "OpenAI" }]);
		const tweets = Array.from({ length: 25 }, (_, index) =>
			rawTweet(
				String(index),
				`Wed Jul 22 ${String(23 - index).padStart(2, "0")}:00:00 +0000 2026`,
			),
		);
		const client: TweetPageClient = {
			fetchLatestTweetsPage: vi.fn(async () => page(tweets, true, "older")),
		};

		const stats = await ingestNews({ database: db, client });

		expect(stats.fetchedPosts).toBe(20);
		expect(stats.newPosts).toBe(20);
		expect(db.hasPost("20")).toBe(false);
	});

	it("never exceeds the configured account concurrency", async () => {
		const db = database();
		db.seedAccounts(
			Array.from({ length: 12 }, (_, index) => ({
				handle: `account${index}`,
				organization: `Account ${index}`,
			})),
		);
		let active = 0;
		let maximumActive = 0;
		const client: TweetPageClient = {
			async fetchLatestTweetsPage() {
				active += 1;
				maximumActive = Math.max(maximumActive, active);
				await new Promise((resolve) => setTimeout(resolve, 5));
				active -= 1;
				return page([]);
			},
		};

		const stats = await ingestNews({ database: db, client, concurrency: 10 });

		expect(stats.accountsSucceeded).toBe(12);
		expect(maximumActive).toBe(10);
	});

	it("rejects account concurrency above ten", async () => {
		const db = database();
		const client: TweetPageClient = {
			fetchLatestTweetsPage: vi.fn(async () => page([])),
		};

		await expect(
			ingestNews({ database: db, client, concurrency: 11 }),
		).rejects.toThrow("between 1 and 10");
	});
});
