import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

const DEFAULT_RESOURCE_DIRECTORY = "./data/resources";
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_CONCURRENT_DOWNLOADS = 4;
const MAX_REDIRECTS = 5;

export type ImageArchiveSource = {
	pageUrl: string;
	imageUrls: string[];
};

type ImageArchiveEntry = {
	originalUrls: Set<string>;
	sourcePageUrls: Set<string>;
};

type ResourceMetadata = {
	version: 1;
	id: string;
	status: "stored" | "failed";
	normalizedUrl: string;
	originalUrls: string[];
	sourcePageUrls: string[];
	relativePath: string | null;
	mimeType: string | null;
	byteLength: number | null;
	contentSha256: string | null;
	attempts: number;
	createdAt: string;
	updatedAt: string;
	lastError: string | null;
};

type DownloadedImage = {
	bytes: Uint8Array;
	mimeType: string;
};

const resourceLocks = new Map<string, Promise<void>>();

function resourceDirectory(): string {
	return path.resolve(
		process.env.IMAGE_RESOURCE_DIR?.trim() || DEFAULT_RESOURCE_DIRECTORY,
	);
}

function maxImageBytes(): number {
	const configured = Number(process.env.IMAGE_MAX_BYTES);
	return Number.isSafeInteger(configured) && configured > 0
		? configured
		: DEFAULT_MAX_IMAGE_BYTES;
}

function normalizeImageUrl(rawUrl: string): string | undefined {
	try {
		const url = new URL(rawUrl);
		if (!["http:", "https:"].includes(url.protocol)) return undefined;
		if (url.username || url.password) return undefined;
		url.hash = "";
		url.hostname = url.hostname.toLowerCase();
		if (
			(url.protocol === "https:" && url.port === "443") ||
			(url.protocol === "http:" && url.port === "80")
		) {
			url.port = "";
		}
		return url.toString();
	} catch {
		return undefined;
	}
}

const blockedIpv4Ranges: Array<[number, number]> = [
	[0x00000000, 0x00ffffff],
	[0x0a000000, 0x0affffff],
	[0x64400000, 0x647fffff],
	[0x7f000000, 0x7fffffff],
	[0xa9fe0000, 0xa9feffff],
	[0xac100000, 0xac1fffff],
	[0xc0000000, 0xc00000ff],
	[0xc0000200, 0xc00002ff],
	[0xc0a80000, 0xc0a8ffff],
	[0xc6336400, 0xc63364ff],
	[0xcb007100, 0xcb0071ff],
	[0xe0000000, 0xffffffff],
];

function isBlockedIpv4(address: string): boolean {
	const octets = address.split(".").map(Number);
	if (
		octets.length !== 4 ||
		octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
	) {
		return true;
	}
	const numericAddress = octets.reduce(
		(value, octet) => value * 256 + octet,
		0,
	);
	return blockedIpv4Ranges.some(
		([start, end]) => numericAddress >= start && numericAddress <= end,
	);
}

function isBenchmarkIpv4(address: string): boolean {
	const [first, second] = address.split(".").map(Number);
	return first === 198 && (second === 18 || second === 19);
}

function isBlockedIpv6(address: string): boolean {
	const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
	if (normalized === "::" || normalized === "::1") return true;
	if (
		/^f[cd]/.test(normalized) ||
		/^fe[89ab]/.test(normalized) ||
		normalized.startsWith("ff")
	) {
		return true;
	}
	if (normalized.startsWith("2001:db8:")) return true;
	if (normalized.startsWith("::ffff:")) {
		const mapped = normalized.slice("::ffff:".length);
		if (isIP(mapped) === 4) return isBlockedIpv4(mapped);
		return true;
	}
	return false;
}

function isBlockedAddress(address: string): boolean {
	const version = isIP(address.replace(/^\[|\]$/g, ""));
	if (version === 4) return isBlockedIpv4(address);
	if (version === 6) return isBlockedIpv6(address);
	return true;
}

function parseImageUrl(rawUrl: string): URL {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error("Invalid image URL");
	}
	if (!["http:", "https:"].includes(url.protocol)) {
		throw new Error("Only HTTP(S) image URLs are supported");
	}
	if (url.username || url.password) {
		throw new Error("Image URLs containing credentials are not supported");
	}
	return url;
}

function isBlockedHostname(hostname: string): boolean {
	return (
		hostname === "localhost" ||
		[".localhost", ".local", ".internal"].some((suffix) =>
			hostname.endsWith(suffix),
		)
	);
}

async function assertPublicHostname(hostname: string): Promise<void> {
	if (isBlockedHostname(hostname))
		throw new Error("Private image hosts are not supported");
	const addressVersion = isIP(hostname);
	// Keep literal benchmark-range targets blocked. Some local network stacks use
	// 198.18.0.0/15 as a synthetic DNS proxy for otherwise public hostnames.
	if (addressVersion === 4 && isBenchmarkIpv4(hostname)) {
		throw new Error(
			"Private or non-routable image addresses are not supported",
		);
	}
	const resolved = addressVersion
		? undefined
		: await lookup(hostname, { all: true, verbatim: true });
	const addresses = resolved?.map((entry) => entry.address) ?? [hostname];
	if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
		throw new Error(
			"Private or non-routable image addresses are not supported",
		);
	}
}

async function assertPublicImageUrl(rawUrl: string): Promise<URL> {
	const url = parseImageUrl(rawUrl);
	const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	await assertPublicHostname(hostname);
	return url;
}

function extensionForMimeType(mimeType: string): string {
	return (
		{
			"image/avif": "avif",
			"image/bmp": "bmp",
			"image/gif": "gif",
			"image/jpeg": "jpg",
			"image/png": "png",
			"image/svg+xml": "svg",
			"image/tiff": "tiff",
			"image/vnd.microsoft.icon": "ico",
			"image/webp": "webp",
			"image/x-icon": "ico",
		}[mimeType] ?? "img"
	);
}

async function readResponseBytes(response: Response): Promise<Uint8Array> {
	const limit = maxImageBytes();
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > limit) {
		throw new Error(`Image exceeds the ${limit}-byte size limit`);
	}
	if (!response.body) throw new Error("Image response contained no body");

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel();
			throw new Error(`Image exceeds the ${limit}-byte size limit`);
		}
		chunks.push(value);
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

async function downloadImage(
	rawUrl: string,
	signal?: AbortSignal,
): Promise<DownloadedImage> {
	let currentUrl = rawUrl;
	for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
		const checkedUrl = await assertPublicImageUrl(currentUrl);
		const timeoutSignal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
		const response = await fetch(checkedUrl, {
			headers: { Accept: "image/*" },
			redirect: "manual",
			signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
		});

		if ([301, 302, 303, 307, 308].includes(response.status)) {
			await response.body?.cancel();
			const location = response.headers.get("location");
			if (!location)
				throw new Error("Image redirect did not include a location");
			if (redirects === MAX_REDIRECTS)
				throw new Error("Image exceeded the redirect limit");
			currentUrl = new URL(location, checkedUrl).toString();
			continue;
		}
		if (!response.ok)
			throw new Error(`Image request failed with HTTP ${response.status}`);

		const mimeType = response.headers
			.get("content-type")
			?.split(";", 1)[0]
			?.trim()
			.toLowerCase();
		if (!mimeType?.startsWith("image/")) {
			await response.body?.cancel();
			throw new Error("Image URL returned a non-image content type");
		}
		return { bytes: await readResponseBytes(response), mimeType };
	}
	throw new Error("Image exceeded the redirect limit");
}

function metadataFromUnknown(value: unknown): ResourceMetadata | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const metadata = value as Partial<ResourceMetadata>;
	return metadata.version === 1 && typeof metadata.id === "string"
		? (metadata as ResourceMetadata)
		: undefined;
}

async function readMetadata(
	metadataPath: string,
): Promise<ResourceMetadata | undefined> {
	try {
		return metadataFromUnknown(
			JSON.parse(await readFile(metadataPath, "utf8")) as unknown,
		);
	} catch {
		return undefined;
	}
}

async function writeAtomic(
	filePath: string,
	contents: string | Uint8Array,
): Promise<void> {
	const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, contents);
		await rename(temporaryPath, filePath);
	} finally {
		await rm(temporaryPath, { force: true });
	}
}

function mergeStrings(
	...values: Array<Iterable<string> | undefined>
): string[] {
	return [
		...new Set(values.flatMap((items) => (items ? [...items] : []))),
	].sort((left, right) => left.localeCompare(right));
}

function errorMessage(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

type ArchiveContext = {
	id: string;
	normalizedUrl: string;
	metadataPath: string;
	existing: ResourceMetadata | undefined;
	originalUrls: string[];
	sourcePageUrls: string[];
	now: string;
};

async function reuseStoredImage(context: ArchiveContext): Promise<boolean> {
	const { existing } = context;
	if (existing?.status !== "stored" || !existing.relativePath) return false;
	try {
		await stat(path.join(resourceDirectory(), existing.relativePath));
	} catch {
		return false;
	}
	await writeAtomic(
		context.metadataPath,
		JSON.stringify(
			{
				...existing,
				originalUrls: context.originalUrls,
				sourcePageUrls: context.sourcePageUrls,
				updatedAt: context.now,
			},
			null,
			2,
		),
	);
	return true;
}

async function storeDownloadedImage(
	context: ArchiveContext,
	downloaded: DownloadedImage,
): Promise<void> {
	const extension = extensionForMimeType(downloaded.mimeType);
	const relativePath = path.join(
		context.id.slice(0, 2),
		context.id.slice(2, 4),
		`${context.id}.${extension}`,
	);
	await writeAtomic(
		path.join(resourceDirectory(), relativePath),
		downloaded.bytes,
	);
	const metadata: ResourceMetadata = {
		version: 1,
		id: context.id,
		status: "stored",
		normalizedUrl: context.normalizedUrl,
		originalUrls: context.originalUrls,
		sourcePageUrls: context.sourcePageUrls,
		relativePath: relativePath.split(path.sep).join("/"),
		mimeType: downloaded.mimeType,
		byteLength: downloaded.bytes.byteLength,
		contentSha256: createHash("sha256").update(downloaded.bytes).digest("hex"),
		attempts: (context.existing?.attempts ?? 0) + 1,
		createdAt: context.existing?.createdAt ?? context.now,
		updatedAt: context.now,
		lastError: null,
	};
	await writeAtomic(context.metadataPath, JSON.stringify(metadata, null, 2));
}

async function storeFailedImage(
	context: ArchiveContext,
	error: unknown,
): Promise<void> {
	const metadata: ResourceMetadata = {
		version: 1,
		id: context.id,
		status: "failed",
		normalizedUrl: context.normalizedUrl,
		originalUrls: context.originalUrls,
		sourcePageUrls: context.sourcePageUrls,
		relativePath: null,
		mimeType: null,
		byteLength: null,
		contentSha256: null,
		attempts: (context.existing?.attempts ?? 0) + 1,
		createdAt: context.existing?.createdAt ?? context.now,
		updatedAt: context.now,
		lastError: errorMessage(error),
	};
	await writeAtomic(context.metadataPath, JSON.stringify(metadata, null, 2));
}

type ProcessImageOptions = {
	id: string;
	normalizedUrl: string;
	entry: ImageArchiveEntry;
	metadataPath: string;
	signal?: AbortSignal;
};

async function processImage(options: ProcessImageOptions): Promise<void> {
	const { id, normalizedUrl, entry, metadataPath, signal } = options;
	const existing = await readMetadata(metadataPath);
	const context: ArchiveContext = {
		id,
		normalizedUrl,
		metadataPath,
		existing,
		originalUrls: mergeStrings(existing?.originalUrls, entry.originalUrls),
		sourcePageUrls: mergeStrings(
			existing?.sourcePageUrls,
			entry.sourcePageUrls,
		),
		now: new Date().toISOString(),
	};
	if (await reuseStoredImage(context)) return;
	try {
		await storeDownloadedImage(
			context,
			await downloadImage(normalizedUrl, signal),
		);
	} catch (error) {
		if (signal?.aborted) throw error;
		await storeFailedImage(context, error);
	}
}

async function archiveOneImage(
	normalizedUrl: string,
	entry: ImageArchiveEntry,
	signal?: AbortSignal,
): Promise<void> {
	const id = createHash("sha256").update(normalizedUrl).digest("hex");
	const directory = path.join(
		resourceDirectory(),
		id.slice(0, 2),
		id.slice(2, 4),
	);
	const metadataPath = path.join(directory, `${id}.json`);
	await mkdir(directory, { recursive: true });

	const previous = resourceLocks.get(id) ?? Promise.resolve();
	const task = previous
		.catch(() => undefined)
		.then(() =>
			processImage({
				id,
				normalizedUrl,
				entry,
				metadataPath,
				signal,
			}),
		);
	resourceLocks.set(id, task);
	try {
		await task;
	} finally {
		if (resourceLocks.get(id) === task) resourceLocks.delete(id);
	}
}

async function archiveBatch(
	batch: Array<[string, ImageArchiveEntry]>,
	signal?: AbortSignal,
): Promise<void> {
	for (const [normalizedUrl, entry] of batch) {
		if (signal?.aborted) throw signal.reason;
		await archiveOneImage(normalizedUrl, entry, signal);
	}
}

export async function archiveImages(
	sources: ImageArchiveSource[],
	signal?: AbortSignal,
): Promise<void> {
	const entries = new Map<string, ImageArchiveEntry>();
	for (const source of sources) {
		for (const originalUrl of source.imageUrls) {
			const normalizedUrl = normalizeImageUrl(originalUrl);
			if (!normalizedUrl) continue;
			const entry = entries.get(normalizedUrl) ?? {
				originalUrls: new Set<string>(),
				sourcePageUrls: new Set<string>(),
			};
			entry.originalUrls.add(originalUrl);
			entry.sourcePageUrls.add(source.pageUrl);
			entries.set(normalizedUrl, entry);
		}
	}

	const batches = Array.from(
		{ length: Math.min(MAX_CONCURRENT_DOWNLOADS, entries.size) },
		() => [] as Array<[string, ImageArchiveEntry]>,
	);
	[...entries.entries()].forEach((entry, index) => {
		batches[index % batches.length]?.push(entry);
	});
	await Promise.all(batches.map((batch) => archiveBatch(batch, signal)));
}
