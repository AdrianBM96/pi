import type {
	SessionCatalog,
	SessionEntries,
	SessionForkSelection,
	SessionMetadata,
	SessionStore,
	SessionTreeEntry,
} from "../types.ts";
import { SessionError } from "../types.ts";
import { readSessionEntriesForFork } from "./fork.ts";
import { KeyedOperationQueue } from "./keyed-operation-queue.ts";
import { createSessionId, createTimestamp } from "./repository.ts";
import { SessionEntryCollection } from "./session-entry-collection.ts";

export type InMemorySessionCreateOptions = { id?: string };

interface InMemorySessionState {
	metadata: SessionMetadata;
	entries: SessionEntryCollection;
}

class InMemorySessionStore implements SessionStore<SessionMetadata, InMemorySessionCreateOptions, void> {
	private readonly states = new Map<string, InMemorySessionState>();
	private readonly operations = new KeyedOperationQueue<string>();
	private disposed = false;
	private disposePromise: Promise<void> | undefined;

	readonly sessions: SessionCatalog<SessionMetadata, InMemorySessionCreateOptions, void> = {
		create: (options = {}) => this.create(options),
		open: (metadata) => this.open(metadata),
		list: () => this.list(),
		delete: (metadata) => this.delete(metadata),
		fork: (source, options, selection) => this.fork(source, options, selection),
	};

	readonly entries: SessionEntries<SessionMetadata> = {
		readHead: (metadata) => this.read(metadata, (entries) => entries.readHead()),
		readEntry: (metadata, id) => this.read(metadata, (entries) => entries.readEntry(id)),
		readEntries: (metadata, options) => this.read(metadata, (entries) => entries.readEntries(options)),
		findEntriesOnBranch: (metadata, query) => this.read(metadata, (entries) => entries.findEntriesOnBranch(query)),
		readPathToRootOrCompaction: (metadata, leafId) =>
			this.read(metadata, (entries) => entries.readPathToRootOrCompaction(leafId)),
		append: (metadata, entry) => this.append(metadata, entry),
		getLabel: (metadata, id) => this.read(metadata, (entries) => entries.getLabel(id)),
		getName: (metadata) => this.read(metadata, (entries) => entries.getName()),
		getStats: (metadata) => this.read(metadata, (entries) => entries.getStats()),
	};

	private create(options: InMemorySessionCreateOptions): Promise<SessionMetadata> {
		this.assertOpen();
		const id = options.id ?? createSessionId();
		return this.operations.enqueue(id, () => {
			const state: InMemorySessionState = {
				metadata: { id, createdAt: createTimestamp() },
				entries: new SessionEntryCollection(),
			};
			this.states.set(id, state);
			return state.metadata;
		});
	}

	private open(metadata: SessionMetadata): Promise<SessionMetadata> {
		this.assertOpen();
		return this.operations.enqueue(metadata.id, () => this.getState(metadata).metadata);
	}

	private list(): Promise<SessionMetadata[]> {
		this.assertOpen();
		return this.operations.enqueueBarrier(() => [...this.states.values()].map((state) => state.metadata));
	}

	private delete(metadata: SessionMetadata): Promise<void> {
		this.assertOpen();
		return this.operations.enqueue(metadata.id, () => {
			this.states.delete(metadata.id);
		});
	}

	private fork(
		source: SessionMetadata,
		options: InMemorySessionCreateOptions,
		selection: SessionForkSelection,
	): Promise<SessionMetadata> {
		this.assertOpen();
		const id = options.id ?? createSessionId();
		const sourceEntries = this.operations.enqueue(source.id, () =>
			readSessionEntriesForFork(this.getState(source).entries, selection),
		);
		return this.operations.enqueue(id, async () => {
			const state: InMemorySessionState = {
				metadata: { id, createdAt: createTimestamp() },
				entries: new SessionEntryCollection(await sourceEntries),
			};
			this.states.set(id, state);
			return state.metadata;
		});
	}

	private read<T>(metadata: SessionMetadata, read: (entries: SessionEntryCollection) => T): Promise<T> {
		this.assertOpen();
		return this.operations.enqueue(metadata.id, () => read(this.getState(metadata).entries));
	}

	private append(metadata: SessionMetadata, entry: SessionTreeEntry): Promise<void> {
		this.assertOpen();
		return this.operations.enqueue(metadata.id, () => {
			this.getState(metadata).entries.append(entry);
		});
	}

	async [Symbol.asyncDispose](): Promise<void> {
		if (!this.disposePromise) {
			this.disposed = true;
			this.disposePromise = this.operations.drain();
		}
		await this.disposePromise;
	}

	private assertOpen(): void {
		if (this.disposed) throw new SessionError("storage", "In-memory session store is disposed");
	}

	private getState(metadata: SessionMetadata): InMemorySessionState {
		const state = this.states.get(metadata.id);
		if (!state) throw new SessionError("not_found", `Session not found: ${metadata.id}`);
		return state;
	}
}

export function createInMemorySessionStore(): SessionStore<SessionMetadata, InMemorySessionCreateOptions, void> {
	return new InMemorySessionStore();
}
