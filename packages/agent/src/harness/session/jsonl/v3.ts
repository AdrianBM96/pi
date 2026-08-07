import type { AgentMessage } from "../../../types.ts";
import type { CustomMessage } from "../../messages.ts";
import { err, ok, type Result } from "../../types.ts";
import type { SessionMutation } from "../state.ts";
import type { CustomEntry, Entry, MessageEntry, ModelChangeEntry, ThinkingLevelEntry } from "../types.ts";
import { JsonlDecodeError } from "./errors.ts";
import type { JsonlSessionMetadata } from "./types.ts";

export interface JsonlV3Header {
	type: "session";
	version: 3;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(line: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		throw new JsonlDecodeError("syntax", "is not valid JSON", error instanceof Error ? error : undefined);
	}
	if (!isObject(value)) throw new JsonlDecodeError("schema", "is not a JSON object");
	return value;
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string") throw new JsonlDecodeError("schema", `has invalid ${field}`);
	return value;
}

function requireNullableString(value: unknown, field: string): string | null {
	if (value !== null && typeof value !== "string") {
		throw new JsonlDecodeError("schema", `has invalid ${field}`);
	}
	return value;
}

function requireBoolean(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") throw new JsonlDecodeError("schema", `has invalid ${field}`);
	return value;
}

function requireCustomMessageContent(value: unknown): CustomMessage["content"] {
	if (typeof value !== "string" && !Array.isArray(value)) {
		throw new JsonlDecodeError("schema", "has invalid content");
	}
	// TODO(J6): Validate legacy custom-message content blocks with the shared AgentMessage schema.
	return value as CustomMessage["content"];
}

function parseTimestamp(value: unknown): { source: string; milliseconds: number } {
	const source = requireString(value, "timestamp");
	const milliseconds = Date.parse(source);
	if (!Number.isFinite(milliseconds)) throw new JsonlDecodeError("schema", "has invalid timestamp");
	return { source, milliseconds };
}

function decodeResult<T>(decode: () => T): Result<T, JsonlDecodeError> {
	try {
		return ok<T, JsonlDecodeError>(decode());
	} catch (error) {
		if (error instanceof JsonlDecodeError) return err<T, JsonlDecodeError>(error);
		throw error;
	}
}

export function isJsonlV3Header(line: string): boolean {
	try {
		const value: unknown = JSON.parse(line);
		return isObject(value) && value.type === "session" && value.version === 3;
	} catch {
		return false;
	}
}

function decodeJsonlV3Header(line: string): JsonlV3Header {
	const value = parseObject(line);
	if (value.type !== "session" || value.version !== 3) {
		throw new JsonlDecodeError("schema", "is not a version 3 session header");
	}
	const parentSession = value.parentSession;
	if (parentSession !== undefined && typeof parentSession !== "string") {
		throw new JsonlDecodeError("schema", "has invalid parentSession");
	}
	return {
		type: "session",
		version: 3,
		id: requireString(value.id, "id"),
		timestamp: parseTimestamp(value.timestamp).source,
		cwd: requireString(value.cwd, "cwd"),
		parentSession,
	};
}

export function parseJsonlV3Header(line: string): Result<JsonlV3Header, JsonlDecodeError> {
	return decodeResult(() => decodeJsonlV3Header(line));
}

export function parseJsonlV3Entry(line: string, seq: number): Result<Entry, JsonlDecodeError> {
	return decodeResult(() => {
		const value = parseObject(line);
		const base = {
			id: requireString(value.id, "id"),
			parentId: requireNullableString(value.parentId, "parentId"),
			seq,
			timestamp: parseTimestamp(value.timestamp).milliseconds,
		};
		switch (value.type) {
			case "message":
				if (!isObject(value.message)) throw new JsonlDecodeError("schema", "has invalid message");
				return {
					...base,
					type: "message",
					// TODO(J6): Validate legacy message payloads with the shared AgentMessage schema.
					message: value.message as unknown as AgentMessage,
				} satisfies MessageEntry;
			case "model_change":
				return {
					...base,
					type: "model_change",
					provider: requireString(value.provider, "provider"),
					modelId: requireString(value.modelId, "modelId"),
				} satisfies ModelChangeEntry;
			case "thinking_level_change":
				return {
					...base,
					type: "thinking_level_change",
					thinkingLevel: requireString(value.thinkingLevel, "thinkingLevel"),
				} satisfies ThinkingLevelEntry;
			case "custom":
				return {
					...base,
					type: "custom",
					customType: requireString(value.customType, "customType"),
					...(value.data === undefined ? {} : { data: value.data }),
				} satisfies CustomEntry;
			case "custom_message":
				return {
					...base,
					type: "message",
					message: {
						role: "custom",
						customType: requireString(value.customType, "customType"),
						content: requireCustomMessageContent(value.content),
						display: requireBoolean(value.display, "display"),
						...(value.details === undefined ? {} : { details: value.details }),
						timestamp: base.timestamp,
					} satisfies CustomMessage,
				} satisfies MessageEntry;
			default:
				// TODO(J4): Decode and normalize the remaining supported coding-agent v3 entry types.
				throw new JsonlDecodeError("schema", `has unsupported entry type ${String(value.type)}`);
		}
	});
}

export function metadataFromV3Header(header: JsonlV3Header, path: string, modifiedAt: number): JsonlSessionMetadata {
	return {
		id: header.id,
		createdAt: Date.parse(header.timestamp),
		cwd: header.cwd,
		path,
		modifiedAt,
		sourceFormat: 3,
		// TODO(J4): Resolve available parent paths to parentSessionId and preserve only unresolved paths here.
		...(header.parentSession === undefined ? {} : { legacyParentSessionPath: header.parentSession }),
	};
}

export function mutationsFromV3Entries(entries: readonly Entry[]): SessionMutation[] {
	const mutations: SessionMutation[] = entries.map((entry) => ({ kind: "entry", entry }));
	const leaf = entries.at(-1);
	if (leaf !== undefined) {
		mutations.push({ kind: "lane", seq: leaf.seq + 1, lane: "main", leafId: leaf.id });
	}
	return mutations;
}
