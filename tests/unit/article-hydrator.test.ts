import { afterEach, describe, expect, it, vi } from "vitest";
import { hydratePostArticles } from "../../src/news/article-hydrator";
import { NewsDatabase } from "../../src/news/database";
import { normalizeTwitterApiTweet } from "../../src/news/normalizer";

function rawTweet(
	id: string,
	options: {
		card?: unknown;
		article?: unknown;
		retweetedTweet?: unknown;
	} = {},
): Record<string, unknown> {
	return {
		id,
		text:
			options.card || options.article
				? "https://t.co/article"
				: "A regular tweet",
		createdAt: "Wed Jul 22 10:00:00 +0000 2026",
		twitterUrl: `https://x.com/OpenAI/status/${id}`,
		isReply: false,
		inReplyToId: "",
		quoted_tweet: null,
		retweeted_tweet: options.retweetedTweet ?? null,
		card: options.card ?? null,
		article: options.article ?? null,
		author: {
			id: "4398626122",
			userName: "OpenAI",
			name: "OpenAI",
			followers: 5_000_000,
		},
	};
}

describe("article hydration", () => {
	const databases: NewsDatabase[] = [];

	afterEach(() => {
		for (const database of databases.splice(0)) database.close();
	});

	function database(): NewsDatabase {
		const database = new NewsDatabase(":memory:");
		databases.push(database);
		return database;
	}

	it("fetches only native X Articles and ignores external link cards", async () => {
		const db = database();
		db.seedAccounts([{ handle: "OpenAI", organization: "OpenAI" }]);
		const [account] = db.listEnabledAccounts();
		if (!account) throw new Error("Expected account");
		db.upsertPost(
			account.id,
			normalizeTwitterApiTweet(
				rawTweet("article", {
					article: {
						title: "A full article",
						preview_text: "Preview",
					},
				}),
			),
		);
		db.upsertPost(
			account.id,
			normalizeTwitterApiTweet(
				rawTweet("external-card", {
					card: { name: "summary_large_image" },
				}),
			),
		);
		db.upsertPost(account.id, normalizeTwitterApiTweet(rawTweet("regular")));
		const fetchArticle = vi.fn(async () => ({
			article: {
				title: "A full article",
				preview_text: "Preview",
				contents: [{ text: "First paragraph" }, { text: "Second paragraph" }],
			},
		}));

		const stats = await hydratePostArticles({
			database: db,
			client: { fetchArticle },
		});

		expect(stats).toEqual({
			candidates: 3,
			articlesFetched: 1,
			notArticles: 2,
			failed: 0,
		});
		expect(fetchArticle).toHaveBeenCalledOnce();
		expect(fetchArticle).toHaveBeenCalledWith("article");
		const posts = db.listPostsForTopicAnalysis();
		expect(posts).toHaveLength(3);
		expect(posts.find((post) => post.xPostId === "article")).toMatchObject({
			articleTitle: "A full article",
			articlePreview: "Preview",
			articleText: "First paragraph\n\nSecond paragraph",
		});
		expect(db.listPostsForArticleHydration()).toEqual([]);
	});

	it("uses the nested source tweet ID for a reposted X Article", async () => {
		const db = database();
		db.seedAccounts([{ handle: "OpenAI", organization: "OpenAI" }]);
		const [account] = db.listEnabledAccounts();
		if (!account) throw new Error("Expected account");
		const source = rawTweet("source-article", {
			article: { title: "Nested article", preview_text: "Preview" },
		});
		db.upsertPost(
			account.id,
			normalizeTwitterApiTweet(
				rawTweet("repost", {
					card: { name: "summary_large_image" },
					retweetedTweet: source,
				}),
			),
		);
		const fetchArticle = vi.fn(async () => ({
			article: {
				title: "Nested article",
				preview_text: "Preview",
				contents: [{ text: "Nested full body" }],
			},
		}));

		const stats = await hydratePostArticles({
			database: db,
			client: { fetchArticle },
		});

		expect(stats.articlesFetched).toBe(1);
		expect(fetchArticle).toHaveBeenCalledWith("source-article");
		expect(db.listPostsForTopicAnalysis()[0]?.articleText).toBe(
			"Nested full body",
		);
	});

	it("retries a transient article failure after one hour", async () => {
		const db = database();
		db.seedAccounts([{ handle: "OpenAI", organization: "OpenAI" }]);
		const [account] = db.listEnabledAccounts();
		if (!account) throw new Error("Expected account");
		db.upsertPost(
			account.id,
			normalizeTwitterApiTweet(
				rawTweet("article", {
					article: {
						title: "Recovered article",
						preview_text: "Preview",
					},
				}),
			),
		);
		const fetchArticle = vi
			.fn()
			.mockRejectedValueOnce(new Error("temporary outage"))
			.mockResolvedValueOnce({
				article: {
					title: "Recovered article",
					preview_text: "Preview",
					contents: [{ text: "Complete body" }],
				},
			});

		const first = await hydratePostArticles({
			database: db,
			client: { fetchArticle },
			now: () => new Date("2026-07-22T10:00:00.000Z"),
		});
		const second = await hydratePostArticles({
			database: db,
			client: { fetchArticle },
			now: () => new Date("2026-07-22T12:00:00.000Z"),
		});

		expect(first.failed).toBe(1);
		expect(second.articlesFetched).toBe(1);
		expect(fetchArticle).toHaveBeenCalledTimes(2);
		expect(db.listPostsForTopicAnalysis()[0]?.articleText).toBe(
			"Complete body",
		);
	});
});
