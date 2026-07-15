import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webFetch } from "../../src/tools/web-fetch";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function requestBody(call: unknown[]): Record<string, unknown> {
	const init = call[1] as RequestInit;
	try {
		return JSON.parse(String(init.body)) as Record<string, unknown>;
	} catch (error) {
		throw new Error("Request body was not valid JSON", { cause: error });
	}
}

describe("web_fetch", () => {
	beforeEach(() => {
		vi.stubEnv("EXA_API_KEY", "test-exa-key");
		vi.stubEnv("DEEPSEEK_API_KEY", "test-deepseek-key");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("does not disclose the research query to the page-fetching provider", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({
				results: [
					{ url: "https://example.com", title: "Example", text: "short page" },
				],
				statuses: [{ id: "https://example.com", status: "success" }],
			}),
		);

		const result = await webFetch.run({
			input: {
				urls: ["https://example.com"],
				query: "private research question",
			},
			signal: undefined,
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const exaBody = requestBody(fetchMock.mock.calls[0] ?? []);
		expect(JSON.stringify(exaBody)).not.toContain("private research question");
		expect(exaBody.extras).toEqual({ imageLinks: 5_000 });
		expect(result.pages[0]?.contentType).toBe("raw");
		expect(result.pages[0]).not.toHaveProperty("images");
	});

	it("compresses long content around the research query", async () => {
		const longContent = "x".repeat(7_000);
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				jsonResponse({
					results: [
						{
							url: "https://example.com/long",
							title: "Long page",
							text: longContent,
						},
					],
					statuses: [{ id: "https://example.com/long", status: "success" }],
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					choices: [
						{
							message: {
								content: JSON.stringify({
									overview: "Relevant summary",
									keyFacts: ["Fact"],
									importantDetails: [],
								}),
							},
						},
					],
				}),
			);

		const result = await webFetch.run({
			input: { urls: ["https://example.com/long"], query: "What matters?" },
			signal: undefined,
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		const deepseekBody = requestBody(fetchMock.mock.calls[1] ?? []);
		const messages = deepseekBody.messages as Array<{ content: string }>;
		expect(messages[1]?.content).toContain("What matters?");
		expect(result.pages[0]).toMatchObject({
			contentType: "compressed",
			fetchedCharacters: longContent.length,
		});
	});

	it("returns a marked excerpt when long-content compression fails", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				jsonResponse({
					results: [
						{
							url: "https://example.com/fallback",
							title: "Fallback",
							text: "x".repeat(7_000),
						},
					],
					statuses: [{ id: "https://example.com/fallback", status: "success" }],
				}),
			)
			.mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, 503));

		const result = await webFetch.run({
			input: {
				urls: ["https://example.com/fallback"],
				query: "Find the facts",
			},
			signal: undefined,
		});

		expect(result.pages[0]?.contentType).toBe("fallback_excerpt");
		expect(result.pages[0]?.content.length).toBeGreaterThan(0);
	});
});
