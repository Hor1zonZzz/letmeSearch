import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EventSourcePost, ReportDraft } from './types';

const EVENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function reportPathForEvent(eventId: string): string {
	const safeEventId = path.basename(eventId);
	if (safeEventId !== eventId || !EVENT_ID_PATTERN.test(safeEventId)) {
		throw new Error('Invalid event ID for report export');
	}
	return `data/reports/${safeEventId}.md`;
}

function oneLine(value: string): string {
	return value.trim().replace(/\s+/g, ' ');
}

export function renderReportMarkdown(
	draft: ReportDraft,
	sources: EventSourcePost[],
	updatedAt: string,
): string {
	const facts = draft.keyFacts.map((fact) => `- ${oneLine(fact)}`).join('\n');
	const sourceLines = sources.map((source) =>
		`- [@${source.handle} · ${source.publishedAt}](${source.tweetUrl})`,
	).join('\n');
	return [
		`# ${oneLine(draft.headline)}`,
		`> 最后更新：${updatedAt}`,
		'## 快讯',
		draft.summary.trim(),
		'## 关键信息',
		facts,
		'## 来源',
		sourceLines,
		'',
	].join('\n\n');
}

export async function writeReportFile(filePath: string, markdown: string): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, markdown, 'utf8');
		await rename(temporaryPath, filePath);
	} finally {
		await rm(temporaryPath, { force: true });
	}
}
