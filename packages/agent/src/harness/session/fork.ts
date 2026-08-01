import type { SessionForkOptions, SessionForkSelection, SessionTreeEntry } from "../types.ts";
import { SessionError } from "../types.ts";

type MaybePromise<T> = T | Promise<T>;

export interface SessionForkEntrySource {
	readEntry(id: string): MaybePromise<SessionTreeEntry | undefined>;
	readEntries(): MaybePromise<readonly SessionTreeEntry[]>;
	readPathToRootOrCompaction(leafId: string | null): MaybePromise<readonly SessionTreeEntry[]>;
}

export function createSessionForkSelection(options: SessionForkOptions): SessionForkSelection {
	if (!options.entryId) return { kind: "all" };
	return (options.position ?? "before") === "at"
		? { kind: "through_entry", entryId: options.entryId }
		: { kind: "before_user_message", entryId: options.entryId };
}

export async function readSessionEntriesForFork(
	reader: SessionForkEntrySource,
	selection: SessionForkSelection,
): Promise<readonly SessionTreeEntry[]> {
	if (selection.kind === "all") return reader.readEntries();
	const target = await reader.readEntry(selection.entryId);
	if (!target) throw new SessionError("invalid_fork_target", `Entry ${selection.entryId} not found`);
	if (selection.kind === "through_entry") return reader.readPathToRootOrCompaction(target.id);
	if (target.type !== "message" || target.message.role !== "user") {
		throw new SessionError("invalid_fork_target", `Entry ${selection.entryId} is not a user message`);
	}
	return reader.readPathToRootOrCompaction(target.parentId);
}
