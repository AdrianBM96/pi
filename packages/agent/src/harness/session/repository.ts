import { uuidv7 } from "@earendil-works/pi-ai";
import {
	type FileError,
	type Result,
	type SessionCommitHandler,
	type SessionCreateOptions,
	SessionError,
	type SessionForkOptions,
	type SessionMetadata,
	type SessionSearch,
	type SessionSearchHit,
	type SessionStore,
	type SessionTreeEntry,
} from "../types.ts";
import { createSessionForkSelection } from "./fork.ts";
import { createSession, type Session, type SessionContextBuildOptions } from "./session.ts";

export function createSessionId(): string {
	return uuidv7();
}

export function createTimestamp(): string {
	return new Date().toISOString();
}

export class SessionRepository<
	TMetadata extends SessionMetadata = SessionMetadata,
	TCreateOptions extends SessionCreateOptions = SessionCreateOptions,
	TListOptions = void,
> {
	private readonly store: SessionStore<TMetadata, TCreateOptions, TListOptions>;
	private readonly searchStore: SessionSearch<TMetadata> | null;
	private readonly contextBuildOptions: SessionContextBuildOptions;
	private readonly onCommit: SessionCommitHandler<TMetadata> | undefined;

	constructor(options: {
		store: SessionStore<TMetadata, TCreateOptions, TListOptions>;
		search?: SessionSearch<TMetadata> | null;
		contextBuildOptions?: SessionContextBuildOptions;
		onCommit?: SessionCommitHandler<TMetadata>;
	}) {
		this.store = options.store;
		this.searchStore = options.search ?? null;
		this.contextBuildOptions = options.contextBuildOptions ?? {};
		this.onCommit = options.onCommit;
	}

	async create(options: TCreateOptions): Promise<Session<TMetadata>> {
		const metadata = await this.store.sessions.create(options);
		await this.onCommit?.({ kind: "session_created", metadata });
		return createSession(this.store.entries, metadata, this.contextBuildOptions, this.onCommit);
	}

	async open(metadata: TMetadata): Promise<Session<TMetadata>> {
		const canonical = await this.store.sessions.open(metadata);
		return createSession(this.store.entries, canonical, this.contextBuildOptions, this.onCommit);
	}

	async list(options?: TListOptions): Promise<TMetadata[]> {
		return await this.store.sessions.list(options);
	}

	async delete(metadata: TMetadata): Promise<void> {
		await this.store.sessions.delete(metadata);
		await this.onCommit?.({ kind: "session_deleted", metadata });
	}

	async fork(source: TMetadata, options: SessionForkOptions & TCreateOptions): Promise<Session<TMetadata>> {
		const selection = createSessionForkSelection(options);
		const createOptions = { ...options };
		delete createOptions.entryId;
		delete createOptions.position;
		const metadata = await this.store.sessions.fork(source, createOptions, selection);
		await this.onCommit?.({ kind: "session_forked", metadata, source });
		return createSession(this.store.entries, metadata, this.contextBuildOptions, this.onCommit);
	}

	async search(options: Parameters<SessionSearch<TMetadata>["search"]>[0]): Promise<SessionSearchHit<TMetadata>[]> {
		return this.searchStore ? await this.searchStore.search(options) : [];
	}
}

export function createSessionRepository<
	TMetadata extends SessionMetadata = SessionMetadata,
	TCreateOptions extends SessionCreateOptions = SessionCreateOptions,
	TListOptions = void,
>(options: {
	store: SessionStore<TMetadata, TCreateOptions, TListOptions>;
	search?: SessionSearch<TMetadata> | null;
	contextBuildOptions?: SessionContextBuildOptions;
	onCommit?: SessionCommitHandler<TMetadata>;
}): SessionRepository<TMetadata, TCreateOptions, TListOptions> {
	return new SessionRepository(options);
}

export function findSessionEntryMatches<TMetadata extends SessionMetadata>(
	metadata: TMetadata,
	entries: readonly SessionTreeEntry[],
	text: string,
): SessionSearchHit<TMetadata>[] {
	const normalizedText = text.trim().toLowerCase();
	if (!normalizedText) return [];
	return entries.flatMap((entry) => {
		const payload = JSON.stringify(entry);
		if (!payload.toLowerCase().includes(normalizedText)) return [];
		return [{ metadata, entryId: entry.id, timestamp: entry.timestamp, snippet: payload }];
	});
}

export function getFileSystemResultOrThrow<TValue>(result: Result<TValue, FileError>, message: string): TValue {
	if (!result.ok) {
		const code = result.error.code === "not_found" ? "not_found" : "storage";
		throw new SessionError(code, `${message}: ${result.error.message}`, result.error);
	}
	return result.value;
}
