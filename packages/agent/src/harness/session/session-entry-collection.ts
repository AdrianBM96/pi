import type {
	SessionBranchQuery,
	SessionEntryCursorOptions,
	SessionHead,
	SessionMetadata,
	SessionReader,
	SessionTreeEntry,
} from "../types.ts";
import { SessionError } from "../types.ts";

/** Ordered entries and derived indexes for an array-backed session store. */
export class SessionEntryCollection {
	private entries: SessionTreeEntry[] = [];
	private byId = new Map<string, SessionTreeEntry>();
	private leafId: string | null = null;

	constructor(entries: readonly SessionTreeEntry[] = []) {
		this.replace(entries);
	}

	has(id: string): boolean {
		return this.byId.has(id);
	}

	append(entry: SessionTreeEntry): void {
		if (this.byId.has(entry.id)) {
			throw new SessionError("invalid_entry", `Entry ${entry.id} already exists`);
		}
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = entry.type === "leaf" ? entry.targetId : entry.id;
	}

	replace(entries: readonly SessionTreeEntry[]): void {
		const nextEntries = [...entries];
		const nextById = new Map<string, SessionTreeEntry>();
		let nextLeafId: string | null = null;
		for (const entry of nextEntries) {
			if (nextById.has(entry.id)) {
				throw new SessionError("invalid_entry", `Entry ${entry.id} already exists`);
			}
			nextById.set(entry.id, entry);
			nextLeafId = entry.type === "leaf" ? entry.targetId : entry.id;
		}
		this.entries = nextEntries;
		this.byId = nextById;
		this.leafId = nextLeafId;
	}

	readHead(): SessionHead {
		if (this.leafId !== null && !this.byId.has(this.leafId)) {
			throw new SessionError("invalid_session", `Entry ${this.leafId} not found`);
		}
		return { leafId: this.leafId };
	}

	readEntry(id: string): SessionTreeEntry | undefined {
		return this.byId.get(id);
	}

	readEntries(options?: SessionEntryCursorOptions): readonly SessionTreeEntry[] {
		const start = options?.afterEntrySeq ?? 0;
		const end = options?.limit === undefined ? undefined : start + options.limit;
		return this.entries.slice(start, end);
	}

	findEntriesOnBranch(query: SessionBranchQuery & { start: string | null }): readonly SessionTreeEntry[] {
		if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit <= 0)) {
			throw new RangeError("Session branch query limit must be a positive integer");
		}
		if (query.start === null) return [];
		const pathFromStart: SessionTreeEntry[] = [];
		const visited = new Set<string>();
		let current = this.byId.get(query.start);
		if (!current) throw new SessionError("not_found", `Entry ${query.start} not found`);
		while (current) {
			if (visited.has(current.id)) {
				throw new SessionError("invalid_session", `Session branch contains a cycle at ${current.id}`);
			}
			visited.add(current.id);
			pathFromStart.push(current);
			if (query.order !== "oldestFirst" && (current.id === query.stopAtId || current.type === query.stopAtType)) {
				break;
			}
			if (!current.parentId) break;
			const parent = this.byId.get(current.parentId);
			if (!parent) throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
			current = parent;
		}
		const traversal = query.order === "oldestFirst" ? pathFromStart.reverse() : pathFromStart;
		const stopIndex =
			query.order === "oldestFirst"
				? traversal.findIndex((entry) => entry.id === query.stopAtId || entry.type === query.stopAtType)
				: -1;
		const bounded = stopIndex === -1 ? traversal : traversal.slice(0, stopIndex + 1);
		const entries = bounded.filter(
			(entry) =>
				(query.type === undefined || entry.type === query.type) &&
				(query.customType === undefined || (entry.type === "custom" && entry.customType === query.customType)),
		);
		return query.limit === undefined ? entries : entries.slice(0, query.limit);
	}

	readPathToRootOrCompaction(requestedLeafId: string | null): readonly SessionTreeEntry[] {
		if (requestedLeafId === null) return [];
		const path: SessionTreeEntry[] = [];
		let stopAtEntryId: string | null = null;
		let current = this.byId.get(requestedLeafId);
		if (!current) throw new SessionError("not_found", `Entry ${requestedLeafId} not found`);
		while (current) {
			path.push(current);
			if (stopAtEntryId !== null && current.id === stopAtEntryId) break;
			if (current.type === "compaction") {
				if (current.retainedTail) break;
				stopAtEntryId = current.firstKeptEntryId ?? null;
			}
			if (!current.parentId) break;
			const parent = this.byId.get(current.parentId);
			if (!parent) throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
			current = parent;
		}
		return path.reverse();
	}
}

export function createSessionEntryCollectionReader<TMetadata extends SessionMetadata>(
	metadata: TMetadata,
	entries: SessionEntryCollection,
): SessionReader<TMetadata> {
	return {
		metadata,
		async readHead() {
			return entries.readHead();
		},
		async readEntry(id) {
			return entries.readEntry(id);
		},
		async readEntries(options) {
			return entries.readEntries(options);
		},
		async findEntriesOnBranch(query) {
			return entries.findEntriesOnBranch(query);
		},
		async readPathToRootOrCompaction(leafId) {
			return entries.readPathToRootOrCompaction(leafId);
		},
	};
}
