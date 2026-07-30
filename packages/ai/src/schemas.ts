import Type from "typebox";

const StrictObject = <T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export const ThinkingLevelSchema = Type.Union([
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);

export const ModelThinkingLevelSchema = Type.Union([Type.Literal("off"), ThinkingLevelSchema]);

export const TextContentSchema = StrictObject({
	type: Type.Literal("text"),
	text: Type.String(),
	/** Provider message metadata, such as an OpenAI response item identifier. */
	textSignature: Type.Optional(Type.String()),
});

export const ThinkingContentSchema = StrictObject({
	type: Type.Literal("thinking"),
	thinking: Type.String(),
	/** Opaque provider reasoning identifier or encrypted payload used for multi-turn continuity. */
	thinkingSignature: Type.Optional(Type.String()),
	/** Whether safety filters redacted the thinking content. */
	redacted: Type.Optional(Type.Boolean()),
});

export const ImageContentSchema = StrictObject({
	type: Type.Literal("image"),
	/** Base64-encoded image data. */
	data: Type.String(),
	mimeType: Type.String({ minLength: 1 }),
});

export const ToolCallSchema = StrictObject({
	type: Type.Literal("toolCall"),
	id: Type.String(),
	name: Type.String(),
	arguments: Type.Record(Type.String(), Type.Any()),
	/** Google-specific opaque signature for reusing thought context. */
	thoughtSignature: Type.Optional(Type.String()),
});

export const UsageSchema = StrictObject({
	input: Type.Integer({ minimum: 0 }),
	output: Type.Integer({ minimum: 0 }),
	cacheRead: Type.Integer({ minimum: 0 }),
	cacheWrite: Type.Integer({ minimum: 0 }),
	/** Subset of cacheWrite written with one-hour retention. */
	cacheWrite1h: Type.Optional(Type.Integer({ minimum: 0 })),
	/** Provider-reported reasoning tokens, already included in output. */
	reasoning: Type.Optional(Type.Integer({ minimum: 0 })),
	totalTokens: Type.Integer({ minimum: 0 }),
	cost: StrictObject({
		input: Type.Number({ minimum: 0 }),
		output: Type.Number({ minimum: 0 }),
		cacheRead: Type.Number({ minimum: 0 }),
		cacheWrite: Type.Number({ minimum: 0 }),
		total: Type.Number({ minimum: 0 }),
	}),
});

export const StopReasonSchema = Type.Union([
	Type.Literal("pending"),
	Type.Literal("stop"),
	Type.Literal("length"),
	Type.Literal("toolUse"),
	Type.Literal("error"),
	Type.Literal("aborted"),
]);

export const ModelCostRatesSchema = StrictObject({
	input: Type.Number({ minimum: 0 }),
	output: Type.Number({ minimum: 0 }),
	cacheRead: Type.Number({ minimum: 0 }),
	cacheWrite: Type.Number({ minimum: 0 }),
});
