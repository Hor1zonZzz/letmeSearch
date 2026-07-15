import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { archiveImages } from "../../src/resources/image-archive";

async function filesUnder(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = await Promise.all(
		entries.map(async (entry) => {
			const entryPath = path.join(directory, entry.name);
			return entry.isDirectory() ? filesUnder(entryPath) : [entryPath];
		}),
	);
	return files.flat();
}

async function readOnlyMetadata(
	directory: string,
): Promise<Record<string, unknown>> {
	const files = await filesUnder(directory);
	const metadataFiles = files.filter((file) => file.endsWith(".json"));
	expect(metadataFiles).toHaveLength(1);
	try {
		return JSON.parse(
			await readFile(metadataFiles[0] as string, "utf8"),
		) as Record<string, unknown>;
	} catch (error) {
		throw new Error("Image metadata was not valid JSON", { cause: error });
	}
}

describe("image archive", () => {
	let resourceDirectory: string;

	beforeEach(async () => {
		resourceDirectory = await mkdtemp(
			path.join(tmpdir(), "letme-search-images-"),
		);
		vi.stubEnv("IMAGE_RESOURCE_DIR", resourceDirectory);
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		await rm(resourceDirectory, { recursive: true, force: true });
	});

	it("stores an image and persistently deduplicates its normalized URL", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				new Response(new Uint8Array([137, 80, 78, 71]), {
					headers: { "Content-Type": "image/png" },
				}),
			);

		await archiveImages([
			{
				pageUrl: "https://example.com/first",
				imageUrls: ["https://1.1.1.1/photo.png#first"],
			},
			{
				pageUrl: "https://example.com/second",
				imageUrls: ["https://1.1.1.1/photo.png"],
			},
		]);
		await archiveImages([
			{
				pageUrl: "https://example.com/third",
				imageUrls: ["https://1.1.1.1/photo.png"],
			},
		]);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const metadata = await readOnlyMetadata(resourceDirectory);
		expect(metadata).toMatchObject({
			status: "stored",
			normalizedUrl: "https://1.1.1.1/photo.png",
			mimeType: "image/png",
			byteLength: 4,
			attempts: 1,
		});
		expect(metadata.originalUrls).toEqual([
			"https://1.1.1.1/photo.png",
			"https://1.1.1.1/photo.png#first",
		]);
		expect(metadata.sourcePageUrls).toEqual([
			"https://example.com/first",
			"https://example.com/second",
			"https://example.com/third",
		]);
		const relativePath = metadata.relativePath as string;
		const image = await stat(path.join(resourceDirectory, relativePath));
		expect(image.size).toBe(4);
	});

	it("records a failed sidecar without rejecting the archive operation", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("not an image", {
				headers: { "Content-Type": "text/html" },
			}),
		);

		await expect(
			archiveImages([
				{
					pageUrl: "https://example.com/page",
					imageUrls: ["https://1.0.0.1/not-an-image"],
				},
			]),
		).resolves.toBeUndefined();

		const metadata = await readOnlyMetadata(resourceDirectory);
		expect(metadata).toMatchObject({
			status: "failed",
			relativePath: null,
			lastError: "Image URL returned a non-image content type",
		});
	});

	it("rejects private image addresses before making a request", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch");

		await archiveImages([
			{
				pageUrl: "https://example.com/page",
				imageUrls: ["http://127.0.0.1/private.png"],
			},
		]);

		expect(fetchMock).not.toHaveBeenCalled();
		const metadata = await readOnlyMetadata(resourceDirectory);
		expect(metadata).toMatchObject({
			status: "failed",
			lastError: "Private or non-routable image addresses are not supported",
		});
	});
});
