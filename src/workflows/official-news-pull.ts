import { randomUUID } from 'node:crypto';
import { defineWorkflow, type FlueHarness } from '@flue/runtime';
import * as v from 'valibot';
import agent from '../agents/breaking-news-reporter';
import { ANALYSIS_VERSION, DEFAULT_POSTS_PER_ACCOUNT, MAX_POSTS_PER_ACCOUNT, MONITORED_ACCOUNT_SEEDS } from '../news/config';
import { NewsDatabase } from '../news/database';
import {
	createEventFingerprint,
	eventSnapshot,
	isImportantAnalysis,
	mergeEventFacts,
	type ImportantPostAnalysis,
} from '../news/event-service';
import { normalizeTwitterApiTweet } from '../news/normalizer';
import { classificationPrompt, reportPrompt } from '../news/prompts';
import { renderReportMarkdown, reportPathForEvent, writeReportFile } from '../news/report-files';
import {
	postAnalysisBatchSchema,
	reportDraftSchema,
	type PostAnalysis,
} from '../news/schemas';
import { TwitterApiClient } from '../news/twitter-api';
import type { EventSourcePost, NewsEvent, PostForAnalysis, StoredPost } from '../news/types';

const inputSchema = v.object({
	maxPostsPerAccount: v.optional(
		v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_POSTS_PER_ACCOUNT)),
		DEFAULT_POSTS_PER_ACCOUNT,
	),
});

const errorSchema = v.object({
	scope: v.string(),
	message: v.string(),
});

const outputSchema = v.object({
	accountsAttempted: v.number(),
	accountsSucceeded: v.number(),
	fetchedPosts: v.number(),
	newPosts: v.number(),
	ignoredPosts: v.number(),
	analyzedPosts: v.number(),
	eventsCreated: v.number(),
	reportsCreated: v.number(),
	reportsUpdated: v.number(),
	filesWritten: v.number(),
	errors: v.array(errorSchema),
});

type WorkflowStats = v.InferOutput<typeof outputSchema>;

function errorMessage(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function uniqueSources(sources: EventSourcePost[]): EventSourcePost[] {
	const seen = new Set<string>();
	return sources.filter((source) => {
		if (seen.has(source.xPostId)) return false;
		seen.add(source.xPostId);
		return true;
	});
}

function validateAnalysisCoverage(posts: StoredPost[], analyses: PostAnalysis[]): Map<string, PostAnalysis> {
	const expectedIds = new Set(posts.map((post) => post.id));
	const byPostId = new Map<string, PostAnalysis>();
	for (const analysis of analyses) {
		if (!expectedIds.has(analysis.postId)) {
			throw new Error(`Classification returned an unknown postId: ${analysis.postId}`);
		}
		if (byPostId.has(analysis.postId)) {
			throw new Error(`Classification returned duplicate postId: ${analysis.postId}`);
		}
		byPostId.set(analysis.postId, analysis);
	}
	const missing = posts.filter((post) => !byPostId.has(post.id));
	if (missing.length > 0) {
		throw new Error(`Classification omitted ${missing.length} post(s)`);
	}
	return byPostId;
}

function effectiveAnalysis(
	analysis: ImportantPostAnalysis,
	existing: NewsEvent | null,
): ImportantPostAnalysis {
	if (!existing) return analysis;
	return {
		...analysis,
		category: existing.category,
		organization: existing.organization,
		subject: existing.subject,
		action: existing.action,
		canonicalTitle: existing.canonicalTitle,
	};
}

async function processImportantPost(options: {
	database: NewsDatabase;
	harness: FlueHarness;
	post: PostForAnalysis;
	analysis: ImportantPostAnalysis;
	processingRunId: string;
	reportSessionIndex: number;
}): Promise<{ eventCreated: boolean; reportVersion: number | null }> {
	const { database, harness, post, analysis, processingRunId, reportSessionIndex } = options;
	const fingerprint = createEventFingerprint(analysis);
	const existing = database.findEventByFingerprint(fingerprint);
	const eventId = existing?.id ?? randomUUID();
	const merged = mergeEventFacts(existing?.facts ?? [], analysis.facts, post.xPostId);
	const materialChange = !existing || merged.hasNewFacts;
	const currentSource = database.getPostSource(post.id);
	const sources = uniqueSources([
		...(existing ? database.listEventSourcePosts(existing.id) : []),
		currentSource,
	]);
	const analysisForEvent = effectiveAnalysis(analysis, existing);
	let report: {
		markdown: string;
		changeSummary: string;
		eventSnapshot: unknown;
		sourcePostIds: string[];
		createdByRunId: string;
		filePath: string;
	} | null = null;
	let canonicalTitle = existing?.canonicalTitle ?? analysis.canonicalTitle;

	if (materialChange) {
		const previousMarkdown = existing
			? database.getCurrentReportMarkdown(existing.id, existing.currentReportVersion)
			: null;
		const reportSession = await harness.session(`report-${reportSessionIndex}`);
		const { data: draft } = await reportSession.prompt(
			reportPrompt({
				analysis: analysisForEvent,
				facts: merged.facts,
				sources,
				previousEvent: existing,
				previousMarkdown,
			}),
			{ result: reportDraftSchema },
		);
		canonicalTitle = draft.headline;
		const updatedAnalysis = { ...analysisForEvent, canonicalTitle };
		const now = new Date().toISOString();
		report = {
			markdown: renderReportMarkdown(draft, sources, now),
			changeSummary: draft.changeSummary,
			eventSnapshot: eventSnapshot({
				eventId,
				analysis: updatedAnalysis,
				fingerprint,
				facts: merged.facts,
				previous: existing,
				updatedAt: now,
			}),
			sourcePostIds: sources.map((source) => source.xPostId),
			createdByRunId: processingRunId,
			filePath: reportPathForEvent(eventId),
		};
	}

	const now = new Date().toISOString();
	const committed = database.commitEventChange({
		eventId,
		expectedEventId: existing?.id ?? null,
		expectedLockVersion: existing?.lockVersion ?? null,
		postId: post.id,
		analysis,
		category: existing?.category ?? analysis.category,
		canonicalTitle,
		organization: existing?.organization ?? analysis.organization,
		subject: existing?.subject ?? analysis.subject,
		action: existing?.action ?? analysis.action,
		eventFingerprint: fingerprint,
		facts: merged.facts,
		now,
		report,
	});
	return { eventCreated: !existing, reportVersion: committed.reportVersion };
}

async function exportPendingReports(database: NewsDatabase, stats: WorkflowStats): Promise<void> {
	for (const report of database.listPendingReportExports()) {
		try {
			await writeReportFile(report.filePath, report.markdown);
			database.markReportFileSynced(report.eventId, report.version, new Date().toISOString());
			stats.filesWritten += 1;
		} catch (error) {
			const message = errorMessage(error);
			database.markReportFileFailed(report.eventId, report.version, message);
			stats.errors.push({ scope: `report-file:${report.eventId}:${report.version}`, message });
		}
	}
}

export default defineWorkflow({
	agent,
	input: inputSchema,
	output: outputSchema,

	async run({ harness, input }) {
		const stats: WorkflowStats = {
			accountsAttempted: 0,
			accountsSucceeded: 0,
			fetchedPosts: 0,
			newPosts: 0,
			ignoredPosts: 0,
			analyzedPosts: 0,
			eventsCreated: 0,
			reportsCreated: 0,
			reportsUpdated: 0,
			filesWritten: 0,
			errors: [],
		};
		const database = new NewsDatabase();
		const processingRunId = randomUUID();
		try {
			database.seedAccounts(MONITORED_ACCOUNT_SEEDS);
			const client = new TwitterApiClient();
			for (const account of database.listEnabledAccounts()) {
				stats.accountsAttempted += 1;
				const observedAt = new Date().toISOString();
				try {
					const response = await client.fetchLatestTweets(
						account.handle,
						input.maxPostsPerAccount,
					);
					stats.fetchedPosts += response.tweets.length;
					let profile = null;
					let lastSeenPostAt: string | null = null;
					for (const rawTweet of response.tweets) {
						try {
							const normalized = normalizeTwitterApiTweet(rawTweet, observedAt);
							if (normalized.author.handle.toLowerCase() !== account.handle.toLowerCase()) {
								throw new Error(`Expected @${account.handle}, received @${normalized.author.handle}`);
							}
							profile ??= normalized.author;
							if (!lastSeenPostAt || normalized.publishedAt > lastSeenPostAt) {
								lastSeenPostAt = normalized.publishedAt;
							}
							const result = database.upsertPost(account.id, normalized);
							if (result.isNew) {
								stats.newPosts += 1;
								if (result.post.processingStatus === 'ignored') stats.ignoredPosts += 1;
							}
						} catch (error) {
							stats.errors.push({ scope: `normalize:@${account.handle}`, message: errorMessage(error) });
						}
					}
					database.recordAccountPullSuccess(account.id, profile, lastSeenPostAt, new Date().toISOString());
					stats.accountsSucceeded += 1;
				} catch (error) {
					const message = errorMessage(error);
					database.recordAccountPullFailure(account.id, message, new Date().toISOString());
					stats.errors.push({ scope: `pull:@${account.handle}`, message });
				}
			}

			const posts = database.listPostsForAnalysis();
			if (posts.length > 0) {
				try {
					const classificationSession = await harness.session('classification');
					const { data } = await classificationSession.prompt(
						classificationPrompt(posts),
						{ result: postAnalysisBatchSchema },
					);
					const analyses = validateAnalysisCoverage(posts, data.analyses);
					let reportSessionIndex = 0;
					for (const post of posts) {
						const analysis = analyses.get(post.id);
						if (!analysis) continue;
						stats.analyzedPosts += 1;
						if (!analysis.isImportant) {
							database.markPostIgnored(post.id, analysis, ANALYSIS_VERSION, new Date().toISOString());
							stats.ignoredPosts += 1;
							continue;
						}
						const officialAnalysis = {
							...analysis,
							organization: post.accountOrganization,
						};
						if (!isImportantAnalysis(officialAnalysis)) {
							const message = 'Important classification omitted required event fields or facts';
							database.markPostFailed(post.id, message, new Date().toISOString());
							stats.errors.push({ scope: `analysis:${post.xPostId}`, message });
							continue;
						}
						try {
							reportSessionIndex += 1;
							const result = await processImportantPost({
								database,
								harness,
								post,
								analysis: officialAnalysis,
								processingRunId,
								reportSessionIndex,
							});
							if (result.eventCreated) stats.eventsCreated += 1;
							if (result.reportVersion === 1) stats.reportsCreated += 1;
							else if (result.reportVersion !== null) stats.reportsUpdated += 1;
						} catch (error) {
							const message = errorMessage(error);
							database.markPostFailed(post.id, message, new Date().toISOString());
							stats.errors.push({ scope: `process:${post.xPostId}`, message });
						}
					}
				} catch (error) {
					stats.errors.push({ scope: 'classification', message: errorMessage(error) });
				}
			}

			await exportPendingReports(database, stats);
			return stats;
		} finally {
			database.close();
		}
	},
});
