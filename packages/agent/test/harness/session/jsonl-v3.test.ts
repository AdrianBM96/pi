import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../../src/harness/env/nodejs.ts";
import { JsonlSessionRepo } from "../../../src/harness/session/index.ts";
import { JsonlDecodeError } from "../../../src/harness/session/jsonl/errors.ts";
import { type JsonlV3Header, parseJsonlV3Entry, parseJsonlV3Header } from "../../../src/harness/session/jsonl/v3.ts";
import type { ModelChangeEntry, ThinkingLevelEntry } from "../../../src/harness/session/types.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-agent-jsonl-v3-"));
	tempDirs.push(directory);
	return directory;
}

function createRepository(root: string): JsonlSessionRepo {
	return new JsonlSessionRepo({
		fs: new NodeExecutionEnv({ cwd: root }),
		sessionsRoot: root,
	});
}

afterEach(() => {
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("JSONL v3 codec", () => {
	it("preserves the wire header shape", () => {
		const header = {
			type: "session",
			version: 3,
			id: "legacy-session",
			timestamp: "2025-01-01T00:00:00.000Z",
			cwd: "/workspace/project",
			parentSession: "/sessions/parent.jsonl",
		} satisfies JsonlV3Header;

		expect(parseJsonlV3Header(JSON.stringify(header))).toEqual({ ok: true, value: header });
	});

	it("normalizes model and thinking changes", () => {
		const timestamp = "2025-01-01T00:00:01.000Z";
		expect(
			parseJsonlV3Entry(
				JSON.stringify({
					type: "model_change",
					id: "model-1",
					parentId: "message-1",
					timestamp,
					provider: "anthropic",
					modelId: "claude-sonnet-4-5",
				}),
				2,
			),
		).toEqual({
			ok: true,
			value: {
				type: "model_change",
				id: "model-1",
				parentId: "message-1",
				seq: 2,
				timestamp: Date.parse(timestamp),
				provider: "anthropic",
				modelId: "claude-sonnet-4-5",
			} satisfies ModelChangeEntry,
		});
		expect(
			parseJsonlV3Entry(
				JSON.stringify({
					type: "thinking_level_change",
					id: "thinking-1",
					parentId: "model-1",
					timestamp,
					thinkingLevel: "high",
				}),
				3,
			),
		).toEqual({
			ok: true,
			value: {
				type: "thinking_level_change",
				id: "thinking-1",
				parentId: "model-1",
				seq: 3,
				timestamp: Date.parse(timestamp),
				thinkingLevel: "high",
			} satisfies ThinkingLevelEntry,
		});
	});

	it("rejects invalid model and thinking fields", () => {
		const base = {
			id: "config-1",
			parentId: null,
			timestamp: "2025-01-01T00:00:01.000Z",
		};
		for (const [entry, field] of [
			[{ ...base, type: "model_change", provider: 42, modelId: "model" }, "provider"],
			[{ ...base, type: "model_change", provider: "provider" }, "modelId"],
			[{ ...base, type: "thinking_level_change", thinkingLevel: false }, "thinkingLevel"],
		] as const) {
			const result = parseJsonlV3Entry(JSON.stringify(entry), 1);
			expect(result.ok).toBe(false);
			if (result.ok) throw new Error(`Expected invalid ${field}`);
			expect(result.error).toMatchObject({ kind: "schema", message: `has invalid ${field}` });
		}
	});

	it("returns syntax and schema errors", () => {
		for (const [line, kind] of [
			["{", "syntax"],
			[JSON.stringify({ type: "session", version: 3 }), "schema"],
		] as const) {
			const result = parseJsonlV3Header(line);
			expect(result.ok).toBe(false);
			if (result.ok) throw new Error(`Expected ${kind} decode error`);
			expect(result.error).toBeInstanceOf(JsonlDecodeError);
			expect(result.error).toMatchObject({ kind });
		}
	});
});

describe("JSONL v3 read-only normalization", () => {
	it("opens a minimal session as an idle main lane without modifying the file", async () => {
		const root = createTempDir();
		const path = join(root, "minimal-v3.jsonl");
		const headerTimestamp = "2025-01-01T00:00:00.000Z";
		const messageTimestamp = "2025-01-01T00:00:01.000Z";
		const message = {
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: Date.parse(messageTimestamp),
		};
		const contents = `${JSON.stringify({
			type: "session",
			version: 3,
			id: "legacy-session",
			timestamp: headerTimestamp,
			cwd: root,
		})}\n${JSON.stringify({
			type: "message",
			id: "message-1",
			parentId: null,
			timestamp: messageTimestamp,
			message,
		})}\n`;
		writeFileSync(path, contents);
		const fixedMtime = new Date("2025-01-02T00:00:00.000Z");
		utimesSync(path, fixedMtime, fixedMtime);
		const modifiedAt = statSync(path).mtimeMs;

		const session = await createRepository(root).open({
			id: "legacy-session",
			createdAt: Date.parse(headerTimestamp),
			cwd: root,
			path,
			modifiedAt,
			sourceFormat: 3,
		});

		expect(await session.getMetadata()).toEqual({
			id: "legacy-session",
			createdAt: Date.parse(headerTimestamp),
			cwd: root,
			path,
			modifiedAt,
			sourceFormat: 3,
		});
		expect(await session.getLanes()).toEqual([{ lane: "main", leafId: "message-1" }]);
		expect(await session.findEntries({ order: "oldestFirst" })).toEqual([
			{
				type: "message",
				id: "message-1",
				parentId: null,
				seq: 1,
				timestamp: Date.parse(messageTimestamp),
				message,
			},
		]);
		expect(await session.findRecords()).toEqual([]);
		expect(await session.findOpenOperations("main", { limit: 2 })).toEqual([]);
		expect(readFileSync(path, "utf8")).toBe(contents);
		expect(statSync(path).mtimeMs).toBe(modifiedAt);
	});

	it("retains model and thinking changes and restores main at the final entry", async () => {
		const root = createTempDir();
		const path = join(root, "config-v3.jsonl");
		const headerTimestamp = "2025-01-01T00:00:00.000Z";
		const messageTimestamp = "2025-01-01T00:00:01.000Z";
		const modelTimestamp = "2025-01-01T00:00:02.000Z";
		const thinkingTimestamp = "2025-01-01T00:00:03.000Z";
		const message = { role: "user", content: "hello", timestamp: Date.parse(messageTimestamp) };
		const contents = `${[
			{
				type: "session",
				version: 3,
				id: "legacy-config-session",
				timestamp: headerTimestamp,
				cwd: root,
			},
			{ type: "message", id: "message-1", parentId: null, timestamp: messageTimestamp, message },
			{
				type: "model_change",
				id: "model-1",
				parentId: "message-1",
				timestamp: modelTimestamp,
				provider: "anthropic",
				modelId: "claude-sonnet-4-5",
			},
			{
				type: "thinking_level_change",
				id: "thinking-1",
				parentId: "model-1",
				timestamp: thinkingTimestamp,
				thinkingLevel: "high",
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n")}\n`;
		writeFileSync(path, contents);
		const fixedMtime = new Date("2025-01-02T00:00:00.000Z");
		utimesSync(path, fixedMtime, fixedMtime);
		const modifiedAt = statSync(path).mtimeMs;

		const session = await createRepository(root).open({
			id: "legacy-config-session",
			createdAt: Date.parse(headerTimestamp),
			cwd: root,
			path,
			modifiedAt,
			sourceFormat: 3,
		});

		expect(await session.getLanes()).toEqual([{ lane: "main", leafId: "thinking-1" }]);
		expect(await session.findEntries({ order: "oldestFirst" })).toEqual([
			{
				type: "message",
				id: "message-1",
				parentId: null,
				seq: 1,
				timestamp: Date.parse(messageTimestamp),
				message,
			},
			{
				type: "model_change",
				id: "model-1",
				parentId: "message-1",
				seq: 2,
				timestamp: Date.parse(modelTimestamp),
				provider: "anthropic",
				modelId: "claude-sonnet-4-5",
			},
			{
				type: "thinking_level_change",
				id: "thinking-1",
				parentId: "model-1",
				seq: 3,
				timestamp: Date.parse(thinkingTimestamp),
				thinkingLevel: "high",
			},
		]);
		expect(readFileSync(path, "utf8")).toBe(contents);
		expect(statSync(path).mtimeMs).toBe(modifiedAt);
	});

	it("reports the physical line of a malformed entry without modifying the file", async () => {
		const root = createTempDir();
		const path = join(root, "malformed-v3.jsonl");
		const headerTimestamp = "2025-01-01T00:00:00.000Z";
		const contents = `${JSON.stringify({
			type: "session",
			version: 3,
			id: "malformed-session",
			timestamp: headerTimestamp,
			cwd: root,
		})}\n${JSON.stringify({
			type: "message",
			id: "message-1",
			parentId: null,
			timestamp: "2025-01-01T00:00:01.000Z",
			message: { role: "user", content: "hello", timestamp: 1 },
		})}\n{`;
		writeFileSync(path, contents);
		const modifiedAt = statSync(path).mtimeMs;

		await expect(
			createRepository(root).open({
				id: "malformed-session",
				createdAt: Date.parse(headerTimestamp),
				cwd: root,
				path,
				modifiedAt,
				sourceFormat: 3,
			}),
		).rejects.toMatchObject({
			code: "invalid_entry",
			message: expect.stringMatching(/v3 session .*line 3/),
			cause: { kind: "syntax" },
		});
		expect(readFileSync(path, "utf8")).toBe(contents);
	});
});
