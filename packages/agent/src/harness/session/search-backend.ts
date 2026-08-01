import type {
	SessionMetadata,
	SessionSearch,
	SessionSearchHit,
	SessionSearchOptions,
	SessionTreeEntry,
} from "../types.ts";
import { findSessionEntryMatches } from "./repository.ts";

type SessionSearchSource<TMetadata extends SessionMetadata> = {
	sessions: {
		open(metadata: TMetadata): Promise<TMetadata>;
		list(): Promise<TMetadata[]>;
	};
	entries: {
		readEntries(metadata: TMetadata): Promise<readonly SessionTreeEntry[]>;
	};
};

/** Searches canonical sessions directly and therefore has no index to maintain. */
class ScanningSessionSearch<TMetadata extends SessionMetadata = SessionMetadata> implements SessionSearch<TMetadata> {
	private readonly source: SessionSearchSource<TMetadata>;

	constructor(source: SessionSearchSource<TMetadata>) {
		this.source = source;
	}

	async search(options: SessionSearchOptions): Promise<SessionSearchHit<TMetadata>[]> {
		const hits: SessionSearchHit<TMetadata>[] = [];
		for (const metadata of await this.source.sessions.list()) {
			const cwd = (metadata as { cwd?: unknown }).cwd;
			if (options.cwd !== undefined && cwd !== options.cwd) continue;
			const canonical = await this.source.sessions.open(metadata);
			hits.push(
				...findSessionEntryMatches(canonical, await this.source.entries.readEntries(canonical), options.text),
			);
		}
		return hits;
	}
}

export function createScanningSessionSearch<TMetadata extends SessionMetadata>(
	source: SessionSearchSource<TMetadata>,
): SessionSearch<TMetadata> {
	return new ScanningSessionSearch(source);
}
