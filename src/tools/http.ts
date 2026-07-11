const DEFAULT_TIMEOUT_MS = 20_000;

export function requiredEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

export async function fetchJson(
	url: string,
	init: RequestInit,
	signal?: AbortSignal,
): Promise<unknown> {
	const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
	const response = await fetch(url, {
		...init,
		signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
	});

	const body = await response.text();
	if (!response.ok) {
		throw new Error(
			`Upstream request failed (${response.status}): ${body.slice(0, 500)}`,
		);
	}

	try {
		return JSON.parse(body) as unknown;
	} catch {
		throw new Error('Upstream returned invalid JSON');
	}
}

export function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null
		? (value as Record<string, unknown>)
		: {};
}

export function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}
