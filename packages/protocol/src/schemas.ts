import Type, { type Static } from "typebox";

export const PROTOCOL_VERSION = 1 as const;

const IdSchema = Type.String({ minLength: 1 });
const TimestampSchema = Type.Integer({ minimum: 0 });
const StrictObject = <const T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

// Keep explicit types on composite schema exports. Inference recursively expands
// referenced TypeBox schemas in declarations, multiplying downstream checker work.

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const JsonValueRecursiveSchema = Type.Cyclic(
	{
		JsonValue: Type.Union([
			Type.Null(),
			Type.Boolean(),
			Type.Number(),
			Type.String(),
			Type.Array(Type.Ref("JsonValue")),
			Type.Record(Type.String(), Type.Ref("JsonValue")),
		]),
	},
	"JsonValue",
);
export const JsonValueSchema = Type.Unsafe<JsonValue>(JsonValueRecursiveSchema);

export const ThinkingLevelSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);
export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;

/** Matches AgentHarnessPhase so adapters do not need a second phase vocabulary. */
export const SessionPhaseSchema = Type.Union([
	Type.Literal("idle"),
	Type.Literal("turn"),
	Type.Literal("compaction"),
	Type.Literal("branch_summary"),
	Type.Literal("retry"),
]);
export type SessionPhase = Static<typeof SessionPhaseSchema>;

export const ModelRefSchema = StrictObject({
	provider: IdSchema,
	id: IdSchema,
});
export type ModelRef = Static<typeof ModelRefSchema>;

export const ModelCostSchema = StrictObject({
	input: Type.Number({ minimum: 0 }),
	output: Type.Number({ minimum: 0 }),
	cacheRead: Type.Number({ minimum: 0 }),
	cacheWrite: Type.Number({ minimum: 0 }),
});

export const ModelMetadataSchema: Type.TObject<{
	readonly provider: typeof IdSchema;
	readonly id: typeof IdSchema;
	readonly name: Type.TString;
	readonly api: typeof IdSchema;
	readonly reasoning: Type.TBoolean;
	readonly input: Type.TArray<Type.TUnion<[Type.TLiteral<"text">, Type.TLiteral<"image">]>>;
	readonly contextWindow: Type.TInteger;
	readonly maxTokens: Type.TInteger;
	readonly cost: typeof ModelCostSchema;
	readonly supportedThinkingLevels: Type.TArray<typeof ThinkingLevelSchema>;
	readonly authenticated: Type.TBoolean;
}> = StrictObject({
	provider: IdSchema,
	id: IdSchema,
	name: Type.String({ minLength: 1 }),
	api: IdSchema,
	reasoning: Type.Boolean(),
	input: Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")])),
	contextWindow: Type.Integer({ minimum: 1 }),
	maxTokens: Type.Integer({ minimum: 1 }),
	cost: ModelCostSchema,
	supportedThinkingLevels: Type.Array(ThinkingLevelSchema, { minItems: 1 }),
	authenticated: Type.Boolean(),
});
export type ModelMetadata = Static<typeof ModelMetadataSchema>;

export const TextContentSchema = StrictObject({
	type: Type.Literal("text"),
	text: Type.String(),
});
export const ThinkingContentSchema = StrictObject({
	type: Type.Literal("thinking"),
	thinking: Type.String(),
	redacted: Type.Optional(Type.Boolean()),
});
export const ImageContentSchema = StrictObject({
	type: Type.Literal("image"),
	data: Type.String(),
	mimeType: Type.String({ minLength: 1 }),
});
export const ToolCallContentSchema = StrictObject({
	type: Type.Literal("toolCall"),
	toolCallId: IdSchema,
	toolName: IdSchema,
	input: JsonValueSchema,
});
export const UserContentSchema: Type.TUnion<[typeof TextContentSchema, typeof ImageContentSchema]> = Type.Union([
	TextContentSchema,
	ImageContentSchema,
]);
export const AssistantContentSchema: Type.TUnion<
	[typeof TextContentSchema, typeof ThinkingContentSchema, typeof ToolCallContentSchema]
> = Type.Union([TextContentSchema, ThinkingContentSchema, ToolCallContentSchema]);
export const ToolContentSchema: Type.TUnion<[typeof TextContentSchema, typeof ImageContentSchema]> = Type.Union([
	TextContentSchema,
	ImageContentSchema,
]);
export type TextContent = Static<typeof TextContentSchema>;
export type ThinkingContent = Static<typeof ThinkingContentSchema>;
export type ImageContent = Static<typeof ImageContentSchema>;
export type ToolCallContent = Static<typeof ToolCallContentSchema>;

export const UsageSchema = StrictObject({
	input: Type.Integer({ minimum: 0 }),
	output: Type.Integer({ minimum: 0 }),
	cacheRead: Type.Integer({ minimum: 0 }),
	cacheWrite: Type.Integer({ minimum: 0 }),
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
export type Usage = Static<typeof UsageSchema>;

export const UserTranscriptItemSchema: Type.TObject<{
	readonly id: typeof IdSchema;
	readonly role: Type.TLiteral<"user">;
	readonly content: Type.TArray<typeof UserContentSchema>;
	readonly timestamp: typeof TimestampSchema;
}> = StrictObject({
	id: IdSchema,
	role: Type.Literal("user"),
	content: Type.Array(UserContentSchema),
	timestamp: TimestampSchema,
});
const AssistantTranscriptItemProperties = {
	id: IdSchema,
	role: Type.Literal("assistant"),
	content: Type.Array(AssistantContentSchema),
	model: ModelRefSchema,
	responseModel: Type.Optional(Type.String({ minLength: 1 })),
	usage: Type.Optional(UsageSchema),
	timestamp: TimestampSchema,
} as const;
const StreamingAssistantTranscriptItemSchema = StrictObject({
	...AssistantTranscriptItemProperties,
	status: Type.Literal("streaming"),
});
const CompleteAssistantTranscriptItemSchema = StrictObject({
	...AssistantTranscriptItemProperties,
	status: Type.Literal("complete"),
	stopReason: Type.Union([Type.Literal("stop"), Type.Literal("length"), Type.Literal("toolUse")]),
});
const ErrorAssistantTranscriptItemSchema = StrictObject({
	...AssistantTranscriptItemProperties,
	status: Type.Literal("error"),
	stopReason: Type.Literal("error"),
	errorMessage: Type.Optional(Type.String({ minLength: 1 })),
});
const AbortedAssistantTranscriptItemSchema = StrictObject({
	...AssistantTranscriptItemProperties,
	status: Type.Literal("aborted"),
	stopReason: Type.Literal("aborted"),
	errorMessage: Type.Optional(Type.String()),
});
export const AssistantTranscriptItemSchema: Type.TUnion<
	[
		typeof StreamingAssistantTranscriptItemSchema,
		typeof CompleteAssistantTranscriptItemSchema,
		typeof ErrorAssistantTranscriptItemSchema,
		typeof AbortedAssistantTranscriptItemSchema,
	]
> = Type.Union([
	StreamingAssistantTranscriptItemSchema,
	CompleteAssistantTranscriptItemSchema,
	ErrorAssistantTranscriptItemSchema,
	AbortedAssistantTranscriptItemSchema,
]);
const ToolTranscriptItemProperties = {
	id: IdSchema,
	role: Type.Literal("tool"),
	toolCallId: IdSchema,
	toolName: IdSchema,
	input: JsonValueSchema,
	content: Type.Array(ToolContentSchema),
	details: Type.Optional(JsonValueSchema),
	usage: Type.Optional(UsageSchema),
	timestamp: TimestampSchema,
} as const;
const RunningToolTranscriptItemSchema = StrictObject({
	...ToolTranscriptItemProperties,
	status: Type.Literal("running"),
	isError: Type.Literal(false),
});
const CompleteToolTranscriptItemSchema = StrictObject({
	...ToolTranscriptItemProperties,
	status: Type.Literal("complete"),
	isError: Type.Literal(false),
});
const ErrorToolTranscriptItemSchema = StrictObject({
	...ToolTranscriptItemProperties,
	status: Type.Literal("error"),
	isError: Type.Literal(true),
});
export const ToolTranscriptItemSchema: Type.TUnion<
	[
		typeof RunningToolTranscriptItemSchema,
		typeof CompleteToolTranscriptItemSchema,
		typeof ErrorToolTranscriptItemSchema,
	]
> = Type.Union([RunningToolTranscriptItemSchema, CompleteToolTranscriptItemSchema, ErrorToolTranscriptItemSchema]);
export const TranscriptItemSchema: Type.TUnion<
	[typeof UserTranscriptItemSchema, typeof AssistantTranscriptItemSchema, typeof ToolTranscriptItemSchema]
> = Type.Union([UserTranscriptItemSchema, AssistantTranscriptItemSchema, ToolTranscriptItemSchema]);
export type UserTranscriptItem = Static<typeof UserTranscriptItemSchema>;
export type AssistantTranscriptItem = Static<typeof AssistantTranscriptItemSchema>;
export type ToolTranscriptItem = Static<typeof ToolTranscriptItemSchema>;
export type TranscriptItem = Static<typeof TranscriptItemSchema>;

/** Normalized incremental activity. Snapshots remain authoritative. */
const TranscriptItemStartedSchema: Type.TObject<{
	readonly type: Type.TLiteral<"item_started">;
	readonly item: typeof TranscriptItemSchema;
}> = StrictObject({
	type: Type.Literal("item_started"),
	item: TranscriptItemSchema,
});
const TranscriptAssistantDeltaSchema: Type.TObject<{
	readonly type: Type.TLiteral<"assistant_delta">;
	readonly messageId: typeof IdSchema;
	readonly contentIndex: Type.TInteger;
	readonly kind: Type.TUnion<[Type.TLiteral<"text">, Type.TLiteral<"thinking">, Type.TLiteral<"toolCall">]>;
	readonly delta: Type.TString;
}> = StrictObject({
	type: Type.Literal("assistant_delta"),
	messageId: IdSchema,
	contentIndex: Type.Integer({ minimum: 0 }),
	kind: Type.Union([Type.Literal("text"), Type.Literal("thinking"), Type.Literal("toolCall")]),
	delta: Type.String(),
});
const TranscriptItemUpdatedSchema: Type.TObject<{
	readonly type: Type.TLiteral<"item_updated">;
	readonly item: Type.TUnion<[typeof AssistantTranscriptItemSchema, typeof ToolTranscriptItemSchema]>;
}> = StrictObject({
	type: Type.Literal("item_updated"),
	item: Type.Union([AssistantTranscriptItemSchema, ToolTranscriptItemSchema]),
});
const TranscriptItemFinishedSchema: Type.TObject<{
	readonly type: Type.TLiteral<"item_finished">;
	readonly item: Type.TUnion<
		[
			typeof CompleteAssistantTranscriptItemSchema,
			typeof ErrorAssistantTranscriptItemSchema,
			typeof AbortedAssistantTranscriptItemSchema,
			typeof CompleteToolTranscriptItemSchema,
			typeof ErrorToolTranscriptItemSchema,
		]
	>;
}> = StrictObject({
	type: Type.Literal("item_finished"),
	item: Type.Union([
		CompleteAssistantTranscriptItemSchema,
		ErrorAssistantTranscriptItemSchema,
		AbortedAssistantTranscriptItemSchema,
		CompleteToolTranscriptItemSchema,
		ErrorToolTranscriptItemSchema,
	]),
});
export const TranscriptProgressSchema: Type.TUnion<
	[
		typeof TranscriptItemStartedSchema,
		typeof TranscriptAssistantDeltaSchema,
		typeof TranscriptItemUpdatedSchema,
		typeof TranscriptItemFinishedSchema,
	]
> = Type.Union([
	TranscriptItemStartedSchema,
	TranscriptAssistantDeltaSchema,
	TranscriptItemUpdatedSchema,
	TranscriptItemFinishedSchema,
]);
export type TranscriptProgress = Static<typeof TranscriptProgressSchema>;

export const SessionMetadataSchema = StrictObject({
	id: IdSchema,
	createdAt: TimestampSchema,
	updatedAt: Type.Optional(TimestampSchema),
	parentSessionId: Type.Optional(IdSchema),
	sessionName: Type.Optional(Type.String()),
	cwd: Type.Optional(Type.String({ minLength: 1 })),
});
export const SessionSnapshotSchema: Type.TObject<{
	readonly id: typeof IdSchema;
	readonly name: Type.TOptional<Type.TString>;
	readonly cwd: Type.TString;
	readonly createdAt: typeof TimestampSchema;
	readonly updatedAt: typeof TimestampSchema;
	readonly phase: typeof SessionPhaseSchema;
	readonly model: typeof ModelRefSchema;
	readonly thinkingLevel: typeof ThinkingLevelSchema;
	readonly attached: Type.TBoolean;
	readonly locked: Type.TBoolean;
	readonly revision: Type.TInteger;
	readonly transcript: Type.TArray<typeof TranscriptItemSchema>;
	readonly queuedSteer: Type.TArray<typeof UserTranscriptItemSchema>;
	readonly queuedSteerCount: Type.TInteger;
}> = StrictObject({
	id: IdSchema,
	name: Type.Optional(Type.String()),
	cwd: Type.String({ minLength: 1 }),
	createdAt: TimestampSchema,
	updatedAt: TimestampSchema,
	phase: SessionPhaseSchema,
	model: ModelRefSchema,
	thinkingLevel: ThinkingLevelSchema,
	attached: Type.Boolean(),
	locked: Type.Boolean(),
	revision: Type.Integer({ minimum: 0 }),
	transcript: Type.Array(TranscriptItemSchema),
	queuedSteer: Type.Array(UserTranscriptItemSchema),
	queuedSteerCount: Type.Integer({ minimum: 0 }),
});
export type SessionMetadata = Static<typeof SessionMetadataSchema>;
export type SessionSnapshot = Static<typeof SessionSnapshotSchema>;

export const ServerSnapshotSchema: Type.TObject<{
	readonly serverId: typeof IdSchema;
	readonly protocolVersion: Type.TLiteral<typeof PROTOCOL_VERSION>;
	readonly revision: Type.TInteger;
	readonly sessions: Type.TArray<typeof SessionMetadataSchema>;
	readonly models: Type.TArray<typeof ModelMetadataSchema>;
}> = StrictObject({
	serverId: IdSchema,
	protocolVersion: Type.Literal(PROTOCOL_VERSION),
	revision: Type.Integer({ minimum: 0 }),
	sessions: Type.Array(SessionMetadataSchema),
	models: Type.Array(ModelMetadataSchema),
});
export type ServerSnapshot = Static<typeof ServerSnapshotSchema>;

export const ProtocolErrorCodeSchema = Type.Union([
	Type.Literal("version"),
	Type.Literal("busy"),
	Type.Literal("session_locked"),
	Type.Literal("not_found"),
	Type.Literal("invalid_request"),
	Type.Literal("not_implemented"),
	Type.Literal("internal_error"),
]);
export const ProtocolErrorSchema: Type.TObject<{
	readonly code: typeof ProtocolErrorCodeSchema;
	readonly message: Type.TString;
	readonly details: Type.TOptional<typeof JsonValueSchema>;
}> = StrictObject({
	code: ProtocolErrorCodeSchema,
	message: Type.String(),
	details: Type.Optional(JsonValueSchema),
});
export type ProtocolErrorCode = Static<typeof ProtocolErrorCodeSchema>;
export type ProtocolError = Static<typeof ProtocolErrorSchema>;

const PromptPayloadProperties = {
	sessionId: IdSchema,
	text: Type.String(),
} as const;

export const ListCommandSchema = StrictObject({ command: Type.Literal("list") });
export const CreateCommandSchema = StrictObject({
	command: Type.Literal("create"),
	cwd: Type.Optional(Type.String({ minLength: 1 })),
	name: Type.Optional(Type.String()),
	model: Type.Optional(ModelRefSchema),
	thinkingLevel: Type.Optional(ThinkingLevelSchema),
});
export const AttachCommandSchema = StrictObject({ command: Type.Literal("attach"), sessionId: IdSchema });
export const DetachCommandSchema = StrictObject({ command: Type.Literal("detach"), sessionId: IdSchema });
export const PromptCommandSchema = StrictObject({ command: Type.Literal("prompt"), ...PromptPayloadProperties });
export const SteerCommandSchema = StrictObject({ command: Type.Literal("steer"), ...PromptPayloadProperties });
export const AbortCommandSchema = StrictObject({ command: Type.Literal("abort"), sessionId: IdSchema });
export const SetModelCommandSchema = StrictObject({
	command: Type.Literal("set_model"),
	sessionId: IdSchema,
	model: ModelRefSchema,
});
export const SetThinkingCommandSchema = StrictObject({
	command: Type.Literal("set_thinking"),
	sessionId: IdSchema,
	thinkingLevel: ThinkingLevelSchema,
});
export const CommandSchema: Type.TUnion<
	[
		typeof ListCommandSchema,
		typeof CreateCommandSchema,
		typeof AttachCommandSchema,
		typeof DetachCommandSchema,
		typeof PromptCommandSchema,
		typeof SteerCommandSchema,
		typeof AbortCommandSchema,
		typeof SetModelCommandSchema,
		typeof SetThinkingCommandSchema,
	]
> = Type.Union([
	ListCommandSchema,
	CreateCommandSchema,
	AttachCommandSchema,
	DetachCommandSchema,
	PromptCommandSchema,
	SteerCommandSchema,
	AbortCommandSchema,
	SetModelCommandSchema,
	SetThinkingCommandSchema,
]);
export type Command = Static<typeof CommandSchema>;
export type CommandName = Command["command"];

export const CreateResultSchema: Type.TObject<{
	readonly command: Type.TLiteral<"create">;
	readonly session: typeof SessionSnapshotSchema;
}> = StrictObject({
	command: Type.Literal("create"),
	session: SessionSnapshotSchema,
});
export const AttachResultSchema: Type.TObject<{
	readonly command: Type.TLiteral<"attach">;
	readonly session: typeof SessionSnapshotSchema;
}> = StrictObject({
	command: Type.Literal("attach"),
	session: SessionSnapshotSchema,
});
export const PromptResultSchema: Type.TObject<{
	readonly command: Type.TLiteral<"prompt">;
	readonly session: typeof SessionSnapshotSchema;
}> = StrictObject({
	command: Type.Literal("prompt"),
	session: SessionSnapshotSchema,
});
export const SteerResultSchema: Type.TObject<{
	readonly command: Type.TLiteral<"steer">;
	readonly session: typeof SessionSnapshotSchema;
}> = StrictObject({
	command: Type.Literal("steer"),
	session: SessionSnapshotSchema,
});
export const AbortResultSchema: Type.TObject<{
	readonly command: Type.TLiteral<"abort">;
	readonly session: typeof SessionSnapshotSchema;
}> = StrictObject({
	command: Type.Literal("abort"),
	session: SessionSnapshotSchema,
});
export const SetModelResultSchema: Type.TObject<{
	readonly command: Type.TLiteral<"set_model">;
	readonly session: typeof SessionSnapshotSchema;
}> = StrictObject({
	command: Type.Literal("set_model"),
	session: SessionSnapshotSchema,
});
export const SetThinkingResultSchema: Type.TObject<{
	readonly command: Type.TLiteral<"set_thinking">;
	readonly session: typeof SessionSnapshotSchema;
}> = StrictObject({
	command: Type.Literal("set_thinking"),
	session: SessionSnapshotSchema,
});

export const ListResultSchema = StrictObject({
	command: Type.Literal("list"),
	sessions: Type.Array(SessionMetadataSchema),
});
export const DetachResultSchema = StrictObject({
	command: Type.Literal("detach"),
	sessionId: IdSchema,
});
export const CommandResultSchema: Type.TUnion<
	[
		typeof ListResultSchema,
		typeof CreateResultSchema,
		typeof AttachResultSchema,
		typeof DetachResultSchema,
		typeof PromptResultSchema,
		typeof SteerResultSchema,
		typeof AbortResultSchema,
		typeof SetModelResultSchema,
		typeof SetThinkingResultSchema,
	]
> = Type.Union([
	ListResultSchema,
	CreateResultSchema,
	AttachResultSchema,
	DetachResultSchema,
	PromptResultSchema,
	SteerResultSchema,
	AbortResultSchema,
	SetModelResultSchema,
	SetThinkingResultSchema,
]);
export type CommandResult = Static<typeof CommandResultSchema>;

export type ResultForCommand<TCommand extends Command> = TCommand["command"] extends "list"
	? Static<typeof ListResultSchema>
	: TCommand["command"] extends "detach"
		? Static<typeof DetachResultSchema>
		: Extract<CommandResult, { command: TCommand["command"] }>;

/** Must be the first frame sent by a client. Version is intentionally an integer, not a coercible string. */
export const ClientHelloSchema = StrictObject({
	type: Type.Literal("hello"),
	version: Type.Integer({ minimum: 0 }),
});
export type ClientHello = Static<typeof ClientHelloSchema>;

export const RequestEnvelopeSchema: Type.TObject<{
	readonly type: Type.TLiteral<"request">;
	readonly id: typeof IdSchema;
	readonly request: typeof CommandSchema;
}> = StrictObject({
	type: Type.Literal("request"),
	id: IdSchema,
	request: CommandSchema,
});
export type RequestEnvelope = Static<typeof RequestEnvelopeSchema>;
export const ClientMessageSchema: Type.TUnion<[typeof ClientHelloSchema, typeof RequestEnvelopeSchema]> = Type.Union([
	ClientHelloSchema,
	RequestEnvelopeSchema,
]);
export type ClientMessage = Static<typeof ClientMessageSchema>;

const ServerSnapshotEventSchema: Type.TObject<{
	readonly type: Type.TLiteral<"server_snapshot">;
	readonly snapshot: typeof ServerSnapshotSchema;
}> = StrictObject({ type: Type.Literal("server_snapshot"), snapshot: ServerSnapshotSchema });
const SessionSnapshotEventSchema: Type.TObject<{
	readonly type: Type.TLiteral<"session_snapshot">;
	readonly snapshot: typeof SessionSnapshotSchema;
}> = StrictObject({ type: Type.Literal("session_snapshot"), snapshot: SessionSnapshotSchema });
const SessionProgressEventSchema: Type.TObject<{
	readonly type: Type.TLiteral<"session_progress">;
	readonly sessionId: typeof IdSchema;
	readonly progress: typeof TranscriptProgressSchema;
}> = StrictObject({
	type: Type.Literal("session_progress"),
	sessionId: IdSchema,
	progress: TranscriptProgressSchema,
});
const SessionRemovedEventSchema: Type.TObject<{
	readonly type: Type.TLiteral<"session_removed">;
	readonly sessionId: typeof IdSchema;
}> = StrictObject({ type: Type.Literal("session_removed"), sessionId: IdSchema });
export const ServerEventSchema: Type.TUnion<
	[
		typeof ServerSnapshotEventSchema,
		typeof SessionSnapshotEventSchema,
		typeof SessionProgressEventSchema,
		typeof SessionRemovedEventSchema,
	]
> = Type.Union([
	ServerSnapshotEventSchema,
	SessionSnapshotEventSchema,
	SessionProgressEventSchema,
	SessionRemovedEventSchema,
]);
export type ServerEvent = Static<typeof ServerEventSchema>;

export const ServerHelloSchema: Type.TObject<{
	readonly type: Type.TLiteral<"hello">;
	readonly version: Type.TLiteral<typeof PROTOCOL_VERSION>;
	readonly connectionId: typeof IdSchema;
	readonly snapshot: typeof ServerSnapshotSchema;
}> = StrictObject({
	type: Type.Literal("hello"),
	version: Type.Literal(PROTOCOL_VERSION),
	connectionId: IdSchema,
	snapshot: ServerSnapshotSchema,
});
export const ServerHelloErrorSchema: Type.TObject<{
	readonly type: Type.TLiteral<"hello_error">;
	readonly error: typeof ProtocolErrorSchema;
}> = StrictObject({
	type: Type.Literal("hello_error"),
	error: ProtocolErrorSchema,
});
const SuccessfulResponseEnvelopeSchema: Type.TObject<{
	readonly type: Type.TLiteral<"response">;
	readonly id: typeof IdSchema;
	readonly ok: Type.TLiteral<true>;
	readonly result: typeof CommandResultSchema;
}> = StrictObject({
	type: Type.Literal("response"),
	id: IdSchema,
	ok: Type.Literal(true),
	result: CommandResultSchema,
});
const ErrorResponseEnvelopeSchema: Type.TObject<{
	readonly type: Type.TLiteral<"response">;
	readonly id: typeof IdSchema;
	readonly ok: Type.TLiteral<false>;
	readonly error: typeof ProtocolErrorSchema;
}> = StrictObject({
	type: Type.Literal("response"),
	id: IdSchema,
	ok: Type.Literal(false),
	error: ProtocolErrorSchema,
});
export const ResponseEnvelopeSchema: Type.TUnion<
	[typeof SuccessfulResponseEnvelopeSchema, typeof ErrorResponseEnvelopeSchema]
> = Type.Union([SuccessfulResponseEnvelopeSchema, ErrorResponseEnvelopeSchema]);
export const EventEnvelopeSchema: Type.TObject<{
	readonly type: Type.TLiteral<"event">;
	readonly event: typeof ServerEventSchema;
}> = StrictObject({
	type: Type.Literal("event"),
	event: ServerEventSchema,
});
export const ServerMessageSchema: Type.TUnion<
	[typeof ServerHelloSchema, typeof ServerHelloErrorSchema, typeof ResponseEnvelopeSchema, typeof EventEnvelopeSchema]
> = Type.Union([ServerHelloSchema, ServerHelloErrorSchema, ResponseEnvelopeSchema, EventEnvelopeSchema]);
export type ServerHello = Static<typeof ServerHelloSchema>;
export type ServerHelloError = Static<typeof ServerHelloErrorSchema>;
export type ResponseEnvelope = Static<typeof ResponseEnvelopeSchema>;
export type EventEnvelope = Static<typeof EventEnvelopeSchema>;
export type ServerMessage = Static<typeof ServerMessageSchema>;
