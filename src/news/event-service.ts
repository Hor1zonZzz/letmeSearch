import { createHash } from 'node:crypto';
import type { PostAnalysis } from './schemas';
import type { EventCategory, EventFact, NewsEvent } from './types';

export type ImportantPostAnalysis = PostAnalysis & {
	isImportant: true;
	category: EventCategory;
};

function normalizedText(value: string): string {
	return value
		.normalize('NFKC')
		.toLocaleLowerCase('en-US')
		.replace(/[\p{P}\p{S}\s]+/gu, '');
}

export function isImportantAnalysis(analysis: PostAnalysis): analysis is ImportantPostAnalysis {
	return analysis.isImportant
		&& analysis.category !== 'other'
		&& analysis.organization.trim().length > 0
		&& analysis.subject.trim().length > 0
		&& analysis.action.trim().length > 0
		&& analysis.canonicalTitle.trim().length > 0
		&& analysis.facts.length > 0;
}

export function createEventFingerprint(analysis: ImportantPostAnalysis): string {
	const identity = [
		analysis.category,
		normalizedText(analysis.organization),
		normalizedText(analysis.subject),
		normalizedText(analysis.action),
	].join('|');
	return createHash('sha256').update(identity).digest('hex');
}

export function mergeEventFacts(
	existingFacts: EventFact[],
	incomingFacts: string[],
	sourcePostId: string,
): { facts: EventFact[]; hasNewFacts: boolean } {
	const facts = existingFacts.map((fact) => ({
		text: fact.text,
		sourcePostIds: [...new Set(fact.sourcePostIds)],
	}));
	const byFingerprint = new Map(
		facts.map((fact, index) => [normalizedText(fact.text), index]),
	);
	let hasNewFacts = false;
	for (const rawFact of incomingFacts) {
		const text = rawFact.trim().replace(/\s+/g, ' ');
		if (!text) continue;
		const fingerprint = normalizedText(text);
		const existingIndex = byFingerprint.get(fingerprint);
		if (existingIndex === undefined) {
			facts.push({ text, sourcePostIds: [sourcePostId] });
			byFingerprint.set(fingerprint, facts.length - 1);
			hasNewFacts = true;
			continue;
		}
		const existing = facts[existingIndex];
		if (existing && !existing.sourcePostIds.includes(sourcePostId)) {
			existing.sourcePostIds.push(sourcePostId);
		}
	}
	return { facts, hasNewFacts };
}

export function eventSnapshot(options: {
	eventId: string;
	analysis: ImportantPostAnalysis;
	fingerprint: string;
	facts: EventFact[];
	previous: NewsEvent | null;
	updatedAt: string;
}): Record<string, unknown> {
	const { eventId, analysis, fingerprint, facts, previous, updatedAt } = options;
	return {
		id: eventId,
		category: analysis.category,
		canonicalTitle: analysis.canonicalTitle,
		organization: analysis.organization,
		subject: analysis.subject,
		action: analysis.action,
		eventFingerprint: fingerprint,
		facts,
		status: previous ? 'updated' : 'active',
		firstSeenAt: previous?.firstSeenAt ?? updatedAt,
		lastUpdatedAt: updatedAt,
	};
}
