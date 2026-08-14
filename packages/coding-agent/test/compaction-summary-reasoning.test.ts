import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CompactionPreparation,
	compact,
	generateSummary,
	generateSummaryWithUsage,
} from "../src/core/compaction/index.ts";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

function createModel(reasoning: boolean, maxTokens = 8192): Model<"anthropic-messages"> {
	return {
		id: reasoning ? "reasoning-model" : "non-reasoning-model",
		name: reasoning ? "Reasoning Model" : "Non-reasoning Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens,
	};
}

const mockSummaryResponse: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "## Goal\nTest summary" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	usage: {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};

const messages: AgentMessage[] = [{ role: "user", content: "Summarize this.", timestamp: Date.now() }];

describe("generateSummary reasoning options", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(mockSummaryResponse);
	});

	it("uses the provided thinking level for reasoning-capable models", async () => {
		const result = await generateSummaryWithUsage(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(result.text).toBe("## Goal\nTest summary");
		expect(result.usage).toEqual(mockSummaryResponse.usage);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			reasoning: "medium",
			apiKey: "test-key",
		});
	});

	it("preserves the string result from generateSummary", async () => {
		await expect(generateSummary(messages, createModel(false), 2000, "test-key")).resolves.toBe(
			"## Goal\nTest summary",
		);
	});

	it("uses fresh routing sessions without prompt caching", async () => {
		await generateSummary(messages, createModel(false), 2000, "test-key");
		await generateSummary(messages, createModel(false), 2000, "test-key");

		const requestOptions = completeSimpleMock.mock.calls.map((call) => call[2]);
		expect(requestOptions).toHaveLength(2);
		expect(requestOptions.every((options) => options?.cacheRetention === "none")).toBe(true);

		const sessionIds = requestOptions.map((options) => options?.sessionId);
		expect(sessionIds[0]).not.toBe(sessionIds[1]);
	});

	it("does not set reasoning when thinking is off", async () => {
		await generateSummary(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"off",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("does not set reasoning for non-reasoning models", async () => {
		await generateSummary(
			messages,
			createModel(false),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("clamps compaction summary maxTokens to the model output cap", async () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 600000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 500000, keepRecentTokens: 20000 },
		};

		const result = await compact(preparation, createModel(false, 128000), "test-key", null);

		expect(result.usage).toEqual({
			...mockSummaryResponse.usage,
			input: 20,
			output: 20,
			totalTokens: 40,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		expect(completeSimpleMock.mock.calls.map((call) => call[2]?.maxTokens)).toEqual([128000, 128000]);
	});

	it("summarizes a split turn with one append request", async () => {
		const prefixMessages: Context["messages"] = [
			{ role: "user", content: "old request", timestamp: Date.now() },
			createAssistantMessageForPrefix("old response"),
		];
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [prefixMessages[0]],
			turnPrefixMessages: [prefixMessages[1]],
			isSplitTurn: true,
			tokensBefore: 1000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 100 },
		};
		const tools = [{ name: "read", description: "Read a file", parameters: Type.Object({}) }];

		const result = await compact(
			preparation,
			createModel(false),
			"test-key",
			{
				systemPrompt: "normal coding system prompt",
				tools,
				sessionId: "existing-session",
				contextPrefixMessages: prefixMessages,
			},
			undefined,
			"focus on decisions",
		);

		expect(result.summary).toContain("## Goal");
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		const [, context, options] = completeSimpleMock.mock.calls[0];
		expect(context.systemPrompt).toBe("normal coding system prompt");
		expect(context.tools).toBe(tools);
		expect(context.messages.slice(0, -1)).toEqual(prefixMessages);
		const summaryRequest = JSON.stringify(context.messages.at(-1));
		expect(context.messages.at(-1)?.role).toBe("user");
		expect(summaryRequest).toContain("Do not continue the task");
		expect(summaryRequest).toContain("middle of the latest turn");
		expect(summaryRequest).toContain("Additional focus: focus on decisions");
		expect(options).toMatchObject({ sessionId: "existing-session", apiKey: "test-key" });
		expect(options).not.toHaveProperty("cacheRetention");
	});
});

function createAssistantMessageForPrefix(text: string): AssistantMessage {
	return {
		...mockSummaryResponse,
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}
