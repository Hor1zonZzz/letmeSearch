import { describe, expect, it } from 'vitest';
import {
	createEventFingerprint,
	mergeEventFacts,
	type ImportantPostAnalysis,
} from '../../src/news/event-service';

function analysis(overrides: Partial<ImportantPostAnalysis> = {}): ImportantPostAnalysis {
	return {
		postId: 'post-1',
		isImportant: true,
		category: 'ai_tech',
		organization: 'OpenAI',
		subject: 'GPT Example',
		action: '发布',
		canonicalTitle: 'OpenAI 发布 GPT Example',
		facts: ['OpenAI 发布了 GPT Example'],
		reason: '这是模型发布公告',
		...overrides,
	};
}

describe('news event service', () => {
	it('creates a stable normalized event fingerprint', () => {
		expect(createEventFingerprint(analysis())).toBe(
			createEventFingerprint(analysis({ organization: ' openai ', subject: 'GPT-Example' })),
		);
	});

	it('deduplicates facts while accumulating source post IDs', () => {
		const first = mergeEventFacts([], ['OpenAI 发布了 GPT Example。'], 'x-1');
		const duplicate = mergeEventFacts(first.facts, ['openai 发布了 GPT Example'], 'x-2');

		expect(first.hasNewFacts).toBe(true);
		expect(duplicate.hasNewFacts).toBe(false);
		expect(duplicate.facts).toEqual([{
			text: 'OpenAI 发布了 GPT Example。',
			sourcePostIds: ['x-1', 'x-2'],
		}]);
	});
});
