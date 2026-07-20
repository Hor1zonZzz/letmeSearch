import type { AccountProfile, NormalizedPost, PostType } from './types';

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null
		? value as Record<string, unknown>
		: undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function requiredString(record: Record<string, unknown>, key: string): string {
	const value = asString(record[key]);
	if (!value) throw new Error(`TwitterAPI.io tweet is missing ${key}`);
	return value;
}

function isoTimestamp(value: string): string {
	const timestamp = new Date(value);
	if (Number.isNaN(timestamp.getTime())) {
		throw new Error(`TwitterAPI.io returned an invalid timestamp: ${value}`);
	}
	return timestamp.toISOString();
}

function nestedTweet(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
	return asRecord(record[key]) ?? null;
}

function determinePostType(tweet: Record<string, unknown>): PostType {
	if (nestedTweet(tweet, 'retweeted_tweet')) return 'repost';
	if (tweet.isReply === true || asString(tweet.inReplyToId)) return 'reply';
	if (nestedTweet(tweet, 'quoted_tweet')) return 'quote';
	return 'original';
}

function collectUrls(tweet: Record<string, unknown>): string[] {
	const entities = asRecord(tweet.entities);
	const urls = Array.isArray(entities?.urls) ? entities.urls : [];
	return [...new Set(urls.flatMap((item) => {
		const url = asRecord(item);
		return asString(url?.expanded_url) ?? asString(url?.expandedUrl) ?? asString(url?.url) ?? [];
	}))];
}

function collectMediaUrls(tweet: Record<string, unknown>): string[] {
	const extendedEntities = asRecord(tweet.extendedEntities) ?? asRecord(tweet.extended_entities);
	const media = Array.isArray(extendedEntities?.media) ? extendedEntities.media : [];
	return [...new Set(media.flatMap((item) => {
		const entry = asRecord(item);
		return asString(entry?.media_url_https) ?? asString(entry?.mediaUrlHttps) ?? asString(entry?.url) ?? [];
	}))];
}

function normalizeAuthor(tweet: Record<string, unknown>): AccountProfile {
	const author = asRecord(tweet.author);
	if (!author) throw new Error('TwitterAPI.io tweet is missing author');
	return {
		xUserId: requiredString(author, 'id'),
		handle: requiredString(author, 'userName'),
		displayName: asString(author.name) ?? requiredString(author, 'userName'),
		followersCount: asNumber(author.followers),
		rawPayload: author,
	};
}

export function normalizeTwitterApiTweet(
	value: unknown,
	observedAt = new Date().toISOString(),
): NormalizedPost {
	const tweet = asRecord(value);
	if (!tweet) throw new Error('TwitterAPI.io returned a non-object tweet');
	const xPostId = requiredString(tweet, 'id');
	const author = normalizeAuthor(tweet);
	const quotedPost = nestedTweet(tweet, 'quoted_tweet');
	return {
		xPostId,
		author,
		postType: determinePostType(tweet),
		content: asString(tweet.text) ?? '',
		publishedAt: isoTimestamp(requiredString(tweet, 'createdAt')),
		observedAt: isoTimestamp(observedAt),
		tweetUrl: asString(tweet.twitterUrl) ?? asString(tweet.url) ?? `https://x.com/${author.handle}/status/${xPostId}`,
		quotedXPostId: quotedPost ? asString(quotedPost.id) ?? null : null,
		quotedPost,
		urls: collectUrls(tweet),
		mediaUrls: collectMediaUrls(tweet),
		rawPayload: tweet,
	};
}
