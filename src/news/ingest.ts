import type { NewsDatabase } from "./database";
import { normalizeTwitterApiTweet } from "./normalizer";
import type {
	LatestTweetsPageOptions,
	LatestTweetsResponse,
} from "./twitter-api";
import type { MonitoredAccount } from "./types";

export type TweetPageClient = {
	fetchLatestTweetsPage(
		handle: string,
		options?: LatestTweetsPageOptions,
	): Promise<LatestTweetsResponse>;
};

export type NewsIngestError = {
	scope: string;
	message: string;
};

export type NewsIngestStats = {
	accountsAttempted: number;
	accountsSucceeded: number;
	fetchedPosts: number;
	newPosts: number;
	errors: NewsIngestError[];
};

export type NewsIngestOptions = {
	database: NewsDatabase;
	client: TweetPageClient;
	concurrency?: number;
	now?: () => Date;
};

type AccountIngestResult = Omit<NewsIngestStats, "accountsAttempted">;

function errorMessage(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

async function mapConcurrent<T, R>(
	items: T[],
	concurrency: number,
	operation: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	const runWorker = async (): Promise<void> => {
		while (true) {
			const index = nextIndex;
			nextIndex += 1;
			const item = items[index];
			if (item === undefined) return;
			results[index] = await operation(item);
		}
	};
	const workers: Promise<void>[] = [];
	for (let index = 0; index < Math.min(concurrency, items.length); index += 1) {
		workers.push(runWorker());
	}
	await Promise.all(workers);
	return results;
}

async function ingestAccount(
	account: MonitoredAccount,
	database: NewsDatabase,
	client: TweetPageClient,
	now: () => Date,
): Promise<AccountIngestResult> {
	const result: AccountIngestResult = {
		accountsSucceeded: 0,
		fetchedPosts: 0,
		newPosts: 0,
		errors: [],
	};
	const boundary = account.ingestBoundaryPostAt;
	const seenCursors = new Set<string>();
	let cursor: string | null = null;
	let profile = null;
	let newestPostAt = boundary;
	let hadNormalizationError = false;
	let reachedBoundary = false;

	try {
		while (true) {
			const observedAt = now().toISOString();
			const page = await client.fetchLatestTweetsPage(account.handle, {
				cursor,
				includeReplies: true,
			});
			const pageTweets = boundary ? page.tweets : page.tweets.slice(0, 20);
			result.fetchedPosts += pageTweets.length;

			for (const rawTweet of pageTweets) {
				try {
					const normalized = normalizeTwitterApiTweet(rawTweet, observedAt);
					if (
						normalized.author.handle.toLowerCase() !==
						account.handle.toLowerCase()
					) {
						throw new Error(
							`Expected @${account.handle}, received @${normalized.author.handle}`,
						);
					}
					profile ??= normalized.author;
					if (!newestPostAt || normalized.publishedAt > newestPostAt) {
						newestPostAt = normalized.publishedAt;
					}

					if (
						boundary &&
						(normalized.publishedAt < boundary ||
							(normalized.publishedAt === boundary &&
								database.hasPost(normalized.xPostId)))
					) {
						reachedBoundary = true;
						continue;
					}

					const stored = database.upsertPost(account.id, normalized);
					if (stored.isNew) result.newPosts += 1;
				} catch (error) {
					hadNormalizationError = true;
					result.errors.push({
						scope: `normalize:@${account.handle}`,
						message: errorMessage(error),
					});
				}
			}

			if (!boundary || reachedBoundary) break;
			if (!page.hasNextPage) {
				throw new Error(
					"TwitterAPI.io pagination ended before the previous ingest boundary",
				);
			}
			if (!page.nextCursor) {
				throw new Error(
					"TwitterAPI.io indicated another page without a cursor",
				);
			}
			if (seenCursors.has(page.nextCursor)) {
				throw new Error("TwitterAPI.io repeated a pagination cursor");
			}
			seenCursors.add(page.nextCursor);
			cursor = page.nextCursor;
		}

		if (hadNormalizationError) {
			const message = "One or more tweets could not be normalized";
			database.recordAccountPullFailure(
				account.id,
				message,
				now().toISOString(),
			);
			return result;
		}
		database.recordAccountIngestSuccess(
			account.id,
			profile,
			newestPostAt,
			now().toISOString(),
		);
		result.accountsSucceeded = 1;
		return result;
	} catch (error) {
		const message = errorMessage(error);
		database.recordAccountPullFailure(account.id, message, now().toISOString());
		result.errors.push({ scope: `pull:@${account.handle}`, message });
		return result;
	}
}

export async function ingestNews(
	options: NewsIngestOptions,
): Promise<NewsIngestStats> {
	const { database, client } = options;
	const concurrency = options.concurrency ?? 10;
	if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) {
		throw new Error("concurrency must be an integer between 1 and 10");
	}
	const now = options.now ?? (() => new Date());
	const accounts = database.listEnabledAccounts();
	const accountResults = await mapConcurrent(accounts, concurrency, (account) =>
		ingestAccount(account, database, client, now),
	);

	return accountResults.reduce<NewsIngestStats>(
		(stats, account) => ({
			accountsAttempted: stats.accountsAttempted,
			accountsSucceeded: stats.accountsSucceeded + account.accountsSucceeded,
			fetchedPosts: stats.fetchedPosts + account.fetchedPosts,
			newPosts: stats.newPosts + account.newPosts,
			errors: [...stats.errors, ...account.errors],
		}),
		{
			accountsAttempted: accounts.length,
			accountsSucceeded: 0,
			fetchedPosts: 0,
			newPosts: 0,
			errors: [],
		},
	);
}
