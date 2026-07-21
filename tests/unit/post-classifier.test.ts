import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CLASSIFICATION_SYSTEM_PROMPT,
	classifyPosts,
	classifyPostsByAccount,
	requestDeepSeekClassification,
	type ClassificationResponse,
} from "../../src/news/post-classifier";
import type { PostAnalysis } from "../../src/news/schemas";
import type { PostForAnalysis } from "../../src/news/types";

function post(overrides: Partial<PostForAnalysis> = {}): PostForAnalysis {
	return {
		id: "post-1",
		xPostId: "x-1",
		accountId: "account-1",
		eventId: null,
		postType: "original",
		content: "Introducing Example Model",
		publishedAt: "2026-07-16T11:44:52.000Z",
		observedAt: "2026-07-16T11:45:00.000Z",
		tweetUrl: "https://x.com/OpenAI/status/x-1",
		quotedXPostId: null,
		quotedPost: null,
		processingStatus: "pending",
		accountHandle: "OpenAI",
		accountOrganization: "OpenAI",
		...overrides,
	};
}

function analysis(postId: string): PostAnalysis {
	return {
		postId,
		isImportant: false,
		category: "other",
		organization: "",
		subject: "",
		action: "",
		canonicalTitle: "",
		facts: [],
		reason: "Routine promotion",
	};
}

function response(value: unknown): ClassificationResponse {
	return { content: JSON.stringify(value), finishReason: "stop" };
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("post classifier", () => {
	it("requests JSON mode from DeepSeek without an agent session", async () => {
		vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
		const fetchMock = vi.fn(
			async (
				_input: Parameters<typeof fetch>[0],
				_init?: Parameters<typeof fetch>[1],
			) =>
				new Response(
					JSON.stringify({
						choices: [
							{
								finish_reason: "stop",
								index: 0,
								message: { role: "assistant", content: '{"analyses":[]}' },
							},
						],
						created: 1,
						id: "completion-1",
						model: "deepseek-v4-flash",
						object: "chat.completion",
					}),
					{ headers: { "content-type": "application/json" } },
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		await requestDeepSeekClassification({
			systemPrompt: "system",
			userPrompt: "user",
		});

		expect(fetchMock).toHaveBeenCalledOnce();
		const call = fetchMock.mock.calls[0];
		if (!call) throw new Error("Expected a DeepSeek fetch call");
		const [url, init] = call;
		expect(String(url)).toBe("https://api.deepseek.com/chat/completions");
		const body = JSON.parse(String(init?.body));
		expect(body).toMatchObject({
			model: "deepseek-v4-flash",
			response_format: { type: "json_object" },
			max_tokens: 8192,
			messages: [
				{ role: "system", content: "system" },
				{ role: "user", content: "user" },
			],
		});
	});

	it("parses and validates a complete classification batch", async () => {
		const posts = [post()];
		const requester = vi.fn(async () =>
			response({ analyses: [analysis("post-1")] }),
		);

		const result = await classifyPosts(posts, requester);

		expect(result.get("post-1")).toEqual(analysis("post-1"));
		expect(requester).toHaveBeenCalledWith({
			systemPrompt: CLASSIFICATION_SYSTEM_PROMPT,
			userPrompt: expect.stringContaining('"postId":"post-1"'),
		});
	});

	it.each([
		[
			"empty content",
			{ content: " ", finishReason: "stop" },
			"empty classification content",
		],
		[
			"invalid JSON",
			{ content: "{", finishReason: "stop" },
			"invalid classification JSON",
		],
		[
			"truncated output",
			{ content: "{}", finishReason: "length" },
			"finish reason: length",
		],
	])("rejects %s", async (_name, modelResponse, expected) => {
		await expect(
			classifyPosts([post()], async () => modelResponse),
		).rejects.toThrow(expected);
	});

	it("rejects schema-invalid output", async () => {
		await expect(
			classifyPosts([post()], async () =>
				response({
					analyses: [{ ...analysis("post-1"), category: "invalid" }],
				}),
			),
		).rejects.toThrow();
	});

	it.each([
		["missing", [], "omitted 1 post"],
		["duplicate", [analysis("post-1"), analysis("post-1")], "duplicate postId"],
		["unknown", [analysis("unknown")], "unknown postId"],
	])("rejects %s post IDs", async (_name, analyses, expected) => {
		await expect(
			classifyPosts([post()], async () => response({ analyses })),
		).rejects.toThrow(expected);
	});

	it("requires a DeepSeek API key", async () => {
		vi.stubEnv("DEEPSEEK_API_KEY", "");
		await expect(
			requestDeepSeekClassification({
				systemPrompt: "system",
				userPrompt: "user",
			}),
		).rejects.toThrow("DEEPSEEK_API_KEY");
	});
});

describe("account classification batches", () => {
	it("starts one concurrent request per account and keeps posts from an account together", async () => {
		const posts = [
			post({ id: "openai-1" }),
			post({
				id: "anthropic-1",
				accountId: "account-2",
				accountHandle: "AnthropicAI",
			}),
			post({ id: "openai-2" }),
		];
		const resolvers = new Map<
			string,
			(value: Map<string, PostAnalysis>) => void
		>();
		const calls: PostForAnalysis[][] = [];
		const classifier = vi.fn((batch: PostForAnalysis[]) => {
			calls.push(batch);
			return new Promise<Map<string, PostAnalysis>>((resolve) => {
				resolvers.set(batch[0]?.accountId ?? "", resolve);
			});
		});

		const pending = classifyPostsByAccount(posts, classifier);
		await Promise.resolve();
		expect(calls.map((batch) => batch.map((item) => item.id))).toEqual([
			["openai-1", "openai-2"],
			["anthropic-1"],
		]);
		expect(resolvers.size).toBe(2);

		for (const batch of calls) {
			resolvers.get(batch[0]?.accountId ?? "")?.(
				new Map(batch.map((item) => [item.id, analysis(item.id)])),
			);
		}
		const result = await pending;
		expect([...result.analyses.keys()]).toEqual([
			"openai-1",
			"openai-2",
			"anthropic-1",
		]);
		expect(result.failures).toEqual([]);
	});

	it("isolates a failed account while preserving successful analyses", async () => {
		const posts = [
			post({ id: "openai-1" }),
			post({
				id: "anthropic-1",
				accountId: "account-2",
				accountHandle: "AnthropicAI",
			}),
		];
		const result = await classifyPostsByAccount(posts, async (batch) => {
			if (batch[0]?.accountId === "account-1") throw new Error("bad JSON");
			const item = batch[0];
			if (!item) return new Map();
			return new Map([[item.id, analysis(item.id)]]);
		});

		expect([...result.analyses.keys()]).toEqual(["anthropic-1"]);
		expect(result.failures).toMatchObject([
			{
				accountId: "account-1",
				handle: "OpenAI",
				posts: [{ id: "openai-1" }],
				error: { message: "bad JSON" },
			},
		]);
	});
});
