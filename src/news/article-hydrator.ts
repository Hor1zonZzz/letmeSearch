import type {
	ArticleHydrationCandidate,
	NewsDatabase,
	PostArticleInput,
} from "./database";
import type { ArticleResponse } from "./twitter-api";

export type ArticleClient = {
	fetchArticle(tweetId: string): Promise<ArticleResponse>;
};

export type ArticleHydrationStats = {
	candidates: number;
	articlesFetched: number;
	notArticles: number;
	failed: number;
};

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: {};
}

function nullableText(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}

function articleText(contents: unknown[]): string {
	return contents
		.map((item) => nullableText(asRecord(item).text))
		.filter((text): text is string => text !== null)
		.join("\n\n");
}

function nestedArticleTweetId(
	value: unknown,
	fallbackId: string,
): string | null {
	if (typeof value !== "object" || value === null) return null;
	const tweet = asRecord(value);
	if (typeof tweet.article === "object" && tweet.article !== null) {
		return typeof tweet.id === "string" && tweet.id.length > 0
			? tweet.id
			: fallbackId;
	}
	for (const key of ["quoted_tweet", "retweeted_tweet"]) {
		const nested = nestedArticleTweetId(tweet[key], fallbackId);
		if (nested) return nested;
	}
	return null;
}

export function articleTweetId(post: ArticleHydrationCandidate): string | null {
	return nestedArticleTweetId(post.rawPayload, post.xPostId);
}

export function isArticleCandidate(post: ArticleHydrationCandidate): boolean {
	return articleTweetId(post) !== null;
}

async function mapConcurrent<T>(
	items: T[],
	concurrency: number,
	operation: (item: T) => Promise<void>,
): Promise<void> {
	let nextIndex = 0;
	const runWorker = async (): Promise<void> => {
		while (true) {
			const item = items[nextIndex];
			nextIndex += 1;
			if (item === undefined) return;
			await operation(item);
		}
	};
	const workers: Promise<void>[] = [];
	for (let index = 0; index < Math.min(concurrency, items.length); index += 1) {
		workers.push(runWorker());
	}
	await Promise.all(workers);
}

export async function hydratePostArticles(options: {
	database: NewsDatabase;
	client: ArticleClient;
	limit?: number;
	concurrency?: number;
	now?: () => Date;
}): Promise<ArticleHydrationStats> {
	const { database, client } = options;
	const now = options.now ?? (() => new Date());
	const concurrency = options.concurrency ?? 5;
	if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) {
		throw new Error("article concurrency must be an integer between 1 and 10");
	}
	const retryFailedBefore = new Date(
		now().getTime() - 60 * 60 * 1_000,
	).toISOString();
	const posts = database.listPostsForArticleHydration(
		options.limit ?? 100,
		retryFailedBefore,
	);
	const stats: ArticleHydrationStats = {
		candidates: posts.length,
		articlesFetched: 0,
		notArticles: 0,
		failed: 0,
	};

	await mapConcurrent(posts, concurrency, async (post) => {
		const fetchedAt = now().toISOString();
		if (!isArticleCandidate(post)) {
			const input: PostArticleInput = {
				postId: post.postId,
				status: "not_article",
				title: null,
				previewText: null,
				fullText: null,
				contents: null,
				rawPayload: null,
				fetchedAt,
			};
			database.savePostArticle(input);
			stats.notArticles += 1;
			return;
		}

		try {
			const targetTweetId = articleTweetId(post);
			if (!targetTweetId)
				throw new Error("Article candidate lost its tweet ID");
			const response = await client.fetchArticle(targetTweetId);
			if (!response.article) {
				database.savePostArticle({
					postId: post.postId,
					status: "not_article",
					title: null,
					previewText: null,
					fullText: null,
					contents: null,
					rawPayload: null,
					fetchedAt,
				});
				stats.notArticles += 1;
				return;
			}
			const contents = Array.isArray(response.article.contents)
				? response.article.contents
				: [];
			const fullText = articleText(contents);
			if (contents.length === 0 || fullText.length === 0) {
				throw new Error(
					"TwitterAPI.io returned an article without full contents",
				);
			}
			database.savePostArticle({
				postId: post.postId,
				status: "available",
				title: nullableText(response.article.title),
				previewText: nullableText(response.article.preview_text),
				fullText,
				contents,
				rawPayload: response.article,
				fetchedAt,
			});
			stats.articlesFetched += 1;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			database.markPostArticleFailed(post.postId, message, fetchedAt);
			stats.failed += 1;
		}
	});
	return stats;
}
