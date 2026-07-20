import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderReportMarkdown, writeReportFile } from '../../src/news/report-files';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) =>
		rm(directory, { recursive: true, force: true }),
	));
});

describe('news report files', () => {
	it('renders verified source links and atomically writes the latest file', async () => {
		const markdown = renderReportMarkdown({
			headline: 'OpenAI 发布 GPT Example',
			summary: 'OpenAI 宣布了一个示例模型。',
			keyFacts: ['模型已经发布'],
			changeSummary: '创建首版',
		}, [{
			id: 'post-1',
			xPostId: 'x-1',
			handle: 'OpenAI',
			content: 'Introducing GPT Example',
			publishedAt: '2026-07-22T10:00:00.000Z',
			tweetUrl: 'https://x.com/OpenAI/status/x-1',
		}], '2026-07-22T10:01:00.000Z');
		const directory = await mkdtemp(path.join(tmpdir(), 'news-report-'));
		temporaryDirectories.push(directory);
		const filePath = path.join(directory, 'event.md');

		await writeReportFile(filePath, markdown);

		expect(await readFile(filePath, 'utf8')).toContain(
			'[@OpenAI · 2026-07-22T10:00:00.000Z](https://x.com/OpenAI/status/x-1)',
		);
	});
});
