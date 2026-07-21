import { afterEach, describe, expect, it, vi } from "vitest";
import { hydratePostArticles } from "../../src/news/article-hydrator";
import { NewsDatabase } from "../../src/news/database";
import { normalizeTwitterApiTweet } from "../../src/news/normalizer";

function rawTweet(id: string, card: unknown): Record<string, unknown> {
	return {
		id,
		text: card ? "https://t.co/article" : "A regular tweet",
		createdAt: "Wed Jul 22 10:00:00 +0000 2026",
		twitterUrl: `https://x.com/OpenAI/status/${id}`,
		isReply: false,
		inReplyToId: "",
		quoted_tweet: null,
		retweeted_tweet: null,
		card,
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

	it("fetches card articles, stores the full text, and marks regular tweets", async () => {
		const db = database();
		db.seedAccounts([{ handle: "OpenAI", organization: "OpenAI" }]);
		const [account] = db.listEnabledAccounts();
		if (!account) throw new Error("Expected account");
		db.upsertPost(account.id, normalizeTwitterApiTweet(rawTweet("article", {
			rest_id: "https://t.co/article",
		})));
		db.upsertPost(account.id, normalizeTwitterApiTweet(rawTweet("regular", null)));
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
			candidates: 2,
			articlesFetched: 1,
			notArticles: 1,
			failed: 0,
		});
		expect(fetchArticle).toHaveBeenCalledOnce();
		const posts = db.listPostsForTopicAnalysis();
		expect(posts).toHaveLength(2);
		expect(posts.find((post) => post.xPostId === "article")).toMatchObject({
			articleTitle: "A full article",
			articlePreview: "Preview",
			articleText: "First paragraph\n\nSecond paragraph",
		});
		expect(db.listPostsForArticleHydration()).toEqual([]);
	});

	it("retries a transient article failure after one hour", async () => {
		const db = database();
		db.seedAccounts([{ handle: "OpenAI", organization: "OpenAI" }]);
		const [account] = db.listEnabledAccounts();
		if (!account) throw new Error("Expected account");
		db.upsertPost(account.id, normalizeTwitterApiTweet(rawTweet("article", {
			rest_id: "https://t.co/article",
		})));
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
		expect(db.listPostsForTopicAnalysis()[0]?.articleText).toBe("Complete body");
	});
});
