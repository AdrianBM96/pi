import { existsSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { createJsonlSessionStore } from "../../src/harness/session/jsonl-store.ts";
import {
	createInMemorySessionStore,
	type InMemorySessionCreateOptions,
} from "../../src/harness/session/memory-store.ts";
import { createSessionRepository } from "../../src/harness/session/repository.ts";
import type { SessionCommit, SessionForkSelection, SessionMetadata, SessionStore } from "../../src/harness/types.ts";
import { createAssistantMessage, createTempDir, createUserMessage } from "./session-test-utils.ts";

afterEach(() => {
	vi.useRealTimers();
});

class CountingReadEnv extends NodeExecutionEnv {
	readCount = 0;

	override async readTextFile(path: string, abortSignal?: AbortSignal) {
		this.readCount += 1;
		return super.readTextFile(path, abortSignal);
	}
}

function createDeferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

function settlesBeforeNextTurn(promise: Promise<unknown>): Promise<boolean> {
	return Promise.race([
		promise.then(() => true),
		new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
	]);
}

class PerPathBlockingAppendEnv extends NodeExecutionEnv {
	private readonly appendBlocks = new Map<string, { started: Deferred; release: Deferred }>();
	private listBlock: { started: Deferred; release: Deferred } | undefined;
	readonly appendCounts = new Map<string, number>();

	blockAppend(path: string): { started: Deferred; release: Deferred } {
		const block = { started: createDeferred(), release: createDeferred() };
		this.appendBlocks.set(path, block);
		return block;
	}

	blockNextList(): { started: Deferred; release: Deferred } {
		const block = { started: createDeferred(), release: createDeferred() };
		this.listBlock = block;
		return block;
	}

	override async exists(path: string) {
		if (this.appendBlocks.has(path)) return { ok: true as const, value: true };
		return super.exists(path);
	}

	override async appendFile(path: string, content: string | Uint8Array) {
		this.appendCounts.set(path, (this.appendCounts.get(path) ?? 0) + 1);
		const block = this.appendBlocks.get(path);
		if (block) {
			block.started.resolve();
			await block.release.promise;
		}
		return super.appendFile(path, content);
	}

	override async listDir(path: string) {
		const block = this.listBlock;
		if (block) {
			this.listBlock = undefined;
			block.started.resolve();
			await block.release.promise;
		}
		return super.listDir(path);
	}
}

function createEntry(id: string) {
	return {
		type: "message" as const,
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: createUserMessage(id),
	};
}

class BlockingCreateEnv extends NodeExecutionEnv {
	readonly firstWriteStarted = createDeferred();
	readonly secondWriteStarted = createDeferred();
	readonly releaseFirstWrite = createDeferred();
	readonly writtenPaths = new Set<string>();
	readonly writePaths: string[] = [];

	override async createDir() {
		return { ok: true as const, value: undefined };
	}

	override async exists(path: string) {
		return { ok: true as const, value: this.writtenPaths.has(path) };
	}

	override async writeFile(path: string) {
		this.writePaths.push(path);
		if (this.writePaths.length === 1) {
			this.firstWriteStarted.resolve();
			await this.releaseFirstWrite.promise;
		}
		if (this.writePaths.length === 2) this.secondWriteStarted.resolve();
		this.writtenPaths.add(path);
		return { ok: true as const, value: undefined };
	}
}

class BlockingAppendEnv extends NodeExecutionEnv {
	readonly appendStarted = createDeferred();
	readonly releaseAppend = createDeferred();

	override async appendFile(path: string, content: string | Uint8Array) {
		this.appendStarted.resolve();
		await this.releaseAppend.promise;
		return super.appendFile(path, content);
	}
}

interface SessionStoreReadCounter {
	loadCount: number;
	readHeadCount: number;
	readEntriesCount: number;
	readPathCount: number;
	forkSelections: SessionForkSelection[];
}

function createCountingInMemorySessionStore(): {
	store: SessionStore<SessionMetadata, InMemorySessionCreateOptions, void>;
	counter: SessionStoreReadCounter;
} {
	const source = createInMemorySessionStore();
	const counter: SessionStoreReadCounter = {
		loadCount: 0,
		readHeadCount: 0,
		readEntriesCount: 0,
		readPathCount: 0,
		forkSelections: [],
	};
	return {
		counter,
		store: {
			sessions: {
				create: (options) => source.sessions.create(options),
				async open(metadata) {
					counter.loadCount += 1;
					return source.sessions.open(metadata);
				},
				list: (options) => source.sessions.list(options),
				delete: (metadata) => source.sessions.delete(metadata),
				fork: (metadata, options, selection) => {
					counter.forkSelections.push(selection);
					return source.sessions.fork(metadata, options, selection);
				},
			},
			entries: {
				...source.entries,
				readHead: (metadata) => {
					counter.readHeadCount += 1;
					return source.entries.readHead(metadata);
				},
				readEntries: (metadata, options) => {
					counter.readEntriesCount += 1;
					return source.entries.readEntries(metadata, options);
				},
				readPathToRootOrCompaction: (metadata, leafId) => {
					counter.readPathCount += 1;
					return source.entries.readPathToRootOrCompaction(metadata, leafId);
				},
			},
			[Symbol.asyncDispose]: () => source[Symbol.asyncDispose](),
		},
	};
}

describe("InMemorySessionStore", () => {
	it("opens, deletes, and forks by metadata", async () => {
		const repo = createSessionRepository({ store: createInMemorySessionStore() });
		const session = await repo.create({ id: "session-1" });
		const metadata = await session.getMetadata();
		const user1 = await session.appendMessage(createUserMessage("one"));
		const assistant1 = await session.appendMessage(createAssistantMessage("two"));
		const user2 = await session.appendMessage(createUserMessage("three"));
		await expect((await repo.open(metadata)).getMetadata()).resolves.toEqual(metadata);
		expect((await repo.list()).map((info) => info.id)).toEqual(["session-1"]);
		const fork = await repo.fork(metadata, { entryId: user2, id: "session-2" });
		expect((await fork.getEntries()).map((entry) => entry.id)).toEqual([user1, assistant1]);
		const fullFork = await repo.fork(metadata, { id: "session-3" });
		const throughFork = await repo.fork(metadata, {
			entryId: assistant1,
			position: "at",
			id: "session-4",
		});
		expect((await throughFork.getEntries()).map((entry) => entry.id)).toEqual([user1, assistant1]);
		await expect(repo.fork(metadata, { entryId: assistant1, id: "session-5" })).rejects.toMatchObject({
			code: "invalid_fork_target",
		});
		await expect(repo.fork(metadata, { entryId: "missing", id: "session-6" })).rejects.toMatchObject({
			code: "invalid_fork_target",
		});
		expect((await fullFork.getEntries()).map((entry) => entry.id)).toEqual([user1, assistant1, user2]);
		await repo.delete(metadata);
		await expect(repo.open(metadata)).rejects.toThrow("Session not found: session-1");
	});

	it("fans committed changes out through the consumer callback", async () => {
		const commits: SessionCommit[] = [];
		const repo = createSessionRepository({
			store: createInMemorySessionStore(),
			onCommit: async (commit) => {
				commits.push(commit);
			},
		});
		const session = await repo.create({ id: "session-1" });
		const metadata = await session.getMetadata();
		const entryId = await session.appendMessage(createUserMessage("one"));
		const fork = await repo.fork(metadata, { id: "session-2" });
		await repo.delete(await fork.getMetadata());

		expect(commits.map((commit) => commit.kind)).toEqual([
			"session_created",
			"entry_appended",
			"session_forked",
			"session_deleted",
		]);
		expect(commits[1]).toMatchObject({ kind: "entry_appended", entry: { id: entryId } });
	});

	it("leaves fan-out failure policy to the consumer", async () => {
		const required = await createSessionRepository({
			store: createInMemorySessionStore(),
			onCommit: async (commit) => {
				if (commit.kind === "entry_appended") throw new Error("index unavailable");
			},
		}).create({ id: "required" });
		await expect(required.appendMessage(createUserMessage("required"))).rejects.toThrow("index unavailable");
		await expect(required.getEntries()).resolves.toHaveLength(1);

		const failures: Error[] = [];
		const bestEffort = await createSessionRepository({
			store: createInMemorySessionStore(),
			onCommit: async (commit) => {
				if (commit.kind !== "entry_appended") return;
				try {
					throw new Error("index unavailable");
				} catch (error) {
					if (error instanceof Error) failures.push(error);
					else throw error;
				}
			},
		}).create({ id: "best-effort" });
		await expect(bestEffort.appendMessage(createUserMessage("best effort"))).resolves.toBeTypeOf("string");
		expect(failures).toHaveLength(1);
	});

	it("delegates full-session fork selection without opening the source", async () => {
		const { store, counter } = createCountingInMemorySessionStore();
		const repo = createSessionRepository({ store });
		const source = await repo.create({ id: "session-1" });
		await source.appendMessage(createUserMessage("one"));

		const fork = await repo.fork(await source.getMetadata(), { id: "session-2" });

		expect((await fork.getEntries()).map((entry) => entry.id)).toHaveLength(1);
		expect(counter).toMatchObject({
			loadCount: 0,
			readHeadCount: 2,
			readEntriesCount: 1,
			readPathCount: 0,
			forkSelections: [{ kind: "all" }],
		});
	});

	it("retains the opened aggregate instead of reloading for scoped reads", async () => {
		const { store, counter } = createCountingInMemorySessionStore();
		const repo = createSessionRepository({ store });
		const session = await repo.create({ id: "session-1" });
		const entryId = await session.appendMessage(createUserMessage("one"));

		await session.getMetadata();
		await session.getLeafId();
		await session.getEntry(entryId);
		expect(counter.loadCount).toBe(0);
	});

	it("builds context from the branch reader without loading complete history", async () => {
		const { store, counter } = createCountingInMemorySessionStore();
		const repo = createSessionRepository({ store });
		const created = await repo.create({ id: "session-1" });
		await created.appendMessage(createUserMessage("one"));
		const opened = await repo.open(await created.getMetadata());

		await opened.buildContext();

		expect(counter).toMatchObject({ loadCount: 1, readHeadCount: 2, readEntriesCount: 0, readPathCount: 1 });
	});

	it("rejects repository operations and session writes after store disposal", async () => {
		const store = createInMemorySessionStore();
		const repo = createSessionRepository({ store });
		const session = await repo.create({ id: "session-1" });
		await store[Symbol.asyncDispose]();

		await expect(repo.list()).rejects.toThrow("In-memory session store is disposed");
		await expect(session.appendMessage(createUserMessage("late"))).rejects.toThrow(
			"In-memory session store is disposed",
		);
	});

	it("supports lexical ownership with await using", async () => {
		let listDisposedStore: (() => Promise<SessionMetadata[]>) | undefined;
		{
			await using store = createInMemorySessionStore();
			const repository = createSessionRepository({ store });
			listDisposedStore = () => repository.list();
			await repository.create({ id: "session-1" });
		}

		await expect(listDisposedStore!()).rejects.toThrow("In-memory session store is disposed");
	});
});

describe("JsonlSessionStore", () => {
	it.each(["create", "fork"] as const)(
		"serializes conflicting create and %s destinations",
		async (secondOperation) => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			const root = createTempDir();
			const env = new BlockingCreateEnv({ cwd: root });
			const sourcePath = `${root}/source.jsonl`;
			writeFileSync(
				sourcePath,
				`${JSON.stringify({ type: "session", version: 3, id: "source", timestamp: "2025-01-01T00:00:00.000Z", cwd: "/tmp/source" })}\n`,
			);
			env.writtenPaths.add(sourcePath);
			const store = createJsonlSessionStore({ fs: env, sessionsRoot: root });
			const options = { cwd: "/tmp/target", id: "shared-id" };
			const first = store.sessions.create(options);
			await env.firstWriteStarted.promise;
			const second =
				secondOperation === "create"
					? store.sessions.create(options)
					: store.sessions.fork(
							{
								id: "source",
								createdAt: "2025-01-01T00:00:00.000Z",
								cwd: "/tmp/source",
								path: sourcePath,
							},
							options,
							{ kind: "all" },
						);
			const secondStartedBeforeFirstFinished = await settlesBeforeNextTurn(env.secondWriteStarted.promise);

			env.releaseFirstWrite.resolve();
			const results = await Promise.allSettled([first, second]);

			expect(secondStartedBeforeFirstFinished).toBe(false);
			expect(env.writePaths).toHaveLength(1);
			expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
			expect(results[1]).toMatchObject({
				status: "rejected",
				reason: { code: "invalid_session", message: expect.stringContaining("Session already exists") },
			});
		},
	);

	it("encodes custom session IDs used in filenames", async () => {
		const root = createTempDir();
		const store = createJsonlSessionStore({ fs: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });
		const snapshot = await store.sessions.create({ cwd: root, id: "../unsafe\\id" });

		expect(snapshot.path).toContain("..%2Funsafe%5Cid.jsonl");
		expect(existsSync(snapshot.path)).toBe(true);
	});

	it("allows appends to different sessions to run concurrently", async () => {
		const root = createTempDir();
		const env = new PerPathBlockingAppendEnv({ cwd: root });
		const store = createJsonlSessionStore({ fs: env, sessionsRoot: root });
		const first = await store.sessions.create({ cwd: "/tmp/first", id: "first" });
		const second = await store.sessions.create({ cwd: "/tmp/second", id: "second" });
		const firstBlock = env.blockAppend(first.path);
		const secondBlock = env.blockAppend(second.path);

		const firstAppend = store.entries.append(first, createEntry("first-entry"));
		await firstBlock.started.promise;
		const secondAppend = store.entries.append(second, createEntry("second-entry"));
		const secondStartedBeforeFirstFinished = await settlesBeforeNextTurn(secondBlock.started.promise);

		firstBlock.release.resolve();
		secondBlock.release.resolve();
		await Promise.all([firstAppend, secondAppend]);
		expect(secondStartedBeforeFirstFinished).toBe(true);
	});

	it("caps concurrent operations across JSONL sessions at four by default", async () => {
		const root = createTempDir();
		const env = new PerPathBlockingAppendEnv({ cwd: root });
		const store = createJsonlSessionStore({ fs: env, sessionsRoot: root });
		const snapshots = [];
		for (let index = 0; index < 6; index++) {
			snapshots.push(await store.sessions.create({ cwd: `/tmp/session-${index}`, id: `session-${index}` }));
		}
		const blocks = snapshots.map((snapshot) => env.blockAppend(snapshot.path));
		const appends = snapshots.map((snapshot, index) => store.entries.append(snapshot, createEntry(`entry-${index}`)));
		await Promise.all(blocks.slice(0, 4).map((block) => block.started.promise));
		const fifthStartedWithoutCapacity = await settlesBeforeNextTurn(blocks[4]!.started.promise);
		const sixthStartedWithoutCapacity = await settlesBeforeNextTurn(blocks[5]!.started.promise);

		for (const block of blocks) block.release.resolve();
		await Promise.all(appends);

		expect(fifthStartedWithoutCapacity).toBe(false);
		expect(sixthStartedWithoutCapacity).toBe(false);
	});

	it("allows overriding the JSONL concurrency limit", async () => {
		const root = createTempDir();
		const env = new PerPathBlockingAppendEnv({ cwd: root });
		const store = createJsonlSessionStore({ fs: env, sessionsRoot: root, maxConcurrentOperations: 1 });
		const first = await store.sessions.create({ cwd: "/tmp/first", id: "first" });
		const second = await store.sessions.create({ cwd: "/tmp/second", id: "second" });
		const firstBlock = env.blockAppend(first.path);
		const secondBlock = env.blockAppend(second.path);
		const firstAppend = store.entries.append(first, createEntry("first-entry"));
		await firstBlock.started.promise;
		const secondAppend = store.entries.append(second, createEntry("second-entry"));
		const secondStartedBeforeFirstFinished = await settlesBeforeNextTurn(secondBlock.started.promise);

		firstBlock.release.resolve();
		secondBlock.release.resolve();
		await Promise.all([firstAppend, secondAppend]);
		expect(secondStartedBeforeFirstFinished).toBe(false);
	});

	it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])(
		"rejects invalid JSONL concurrency limit %s",
		(maxConcurrentOperations) => {
			const root = createTempDir();
			expect(() =>
				createJsonlSessionStore({
					fs: new NodeExecutionEnv({ cwd: root }),
					sessionsRoot: root,
					maxConcurrentOperations,
				}),
			).toThrow("maxConcurrentOperations must be a positive integer");
		},
	);

	it("releases JSONL concurrency capacity after an operation fails", async () => {
		const root = createTempDir();
		const store = createJsonlSessionStore({
			fs: new NodeExecutionEnv({ cwd: root }),
			sessionsRoot: root,
			maxConcurrentOperations: 1,
		});
		const first = await store.sessions.create({ cwd: "/tmp/first", id: "first" });
		const second = await store.sessions.create({ cwd: "/tmp/second", id: "second" });
		const duplicate = createEntry("duplicate-entry");
		await store.entries.append(first, duplicate);

		const failure = store.entries.append(first, duplicate);
		const nextSession = store.entries.append(second, createEntry("next-entry"));

		await expect(failure).rejects.toThrow("Entry duplicate-entry already exists");
		await expect(nextSession).resolves.toBeUndefined();
	});

	it("serializes appends to the same session", async () => {
		const root = createTempDir();
		const env = new PerPathBlockingAppendEnv({ cwd: root });
		const store = createJsonlSessionStore({ fs: env, sessionsRoot: root });
		const snapshot = await store.sessions.create({ cwd: root, id: "session" });
		const block = env.blockAppend(snapshot.path);

		const firstAppend = store.entries.append(snapshot, createEntry("first-entry"));
		await block.started.promise;
		const secondAppend = store.entries.append(snapshot, createEntry("second-entry"));
		await new Promise<void>((resolve) => setImmediate(resolve));
		const appendCountWhileFirstWasBlocked = env.appendCounts.get(snapshot.path);

		block.release.resolve();
		await Promise.all([firstAppend, secondAppend]);
		expect(appendCountWhileFirstWasBlocked).toBe(1);
		await store.sessions.open(snapshot);
		expect((await store.entries.readEntries(snapshot)).map((entry) => entry.id)).toEqual([
			"first-entry",
			"second-entry",
		]);
	});

	it("uses listing as a barrier between accepted session operations", async () => {
		const root = createTempDir();
		const env = new PerPathBlockingAppendEnv({ cwd: root });
		const store = createJsonlSessionStore({ fs: env, sessionsRoot: root });
		const first = await store.sessions.create({ cwd: "/tmp/first", id: "first" });
		const second = await store.sessions.create({ cwd: "/tmp/second", id: "second" });
		const firstBlock = env.blockAppend(first.path);
		const secondBlock = env.blockAppend(second.path);
		const listBlock = env.blockNextList();

		const firstAppend = store.entries.append(first, createEntry("first-entry"));
		await firstBlock.started.promise;
		const list = store.sessions.list();
		const secondAppend = store.entries.append(second, createEntry("second-entry"));
		const listStartedBeforeFirstFinished = await settlesBeforeNextTurn(listBlock.started.promise);

		firstBlock.release.resolve();
		await firstAppend;
		await listBlock.started.promise;
		const secondStartedBeforeListFinished = await settlesBeforeNextTurn(secondBlock.started.promise);
		listBlock.release.resolve();
		await list;
		await secondBlock.started.promise;
		secondBlock.release.resolve();
		await secondAppend;

		expect(listStartedBeforeFirstFinished).toBe(false);
		expect(secondStartedBeforeListFinished).toBe(false);
	});

	it("waits for every accepted session operation during disposal", async () => {
		const root = createTempDir();
		const env = new PerPathBlockingAppendEnv({ cwd: root });
		const store = createJsonlSessionStore({ fs: env, sessionsRoot: root });
		const first = await store.sessions.create({ cwd: "/tmp/first", id: "first" });
		const second = await store.sessions.create({ cwd: "/tmp/second", id: "second" });
		const firstBlock = env.blockAppend(first.path);
		const secondBlock = env.blockAppend(second.path);
		const firstAppend = store.entries.append(first, createEntry("first-entry"));
		const secondAppend = store.entries.append(second, createEntry("second-entry"));
		await Promise.all([firstBlock.started.promise, secondBlock.started.promise]);

		let disposed = false;
		const dispose = store[Symbol.asyncDispose]().then(() => {
			disposed = true;
		});
		firstBlock.release.resolve();
		await firstAppend;
		await new Promise<void>((resolve) => setImmediate(resolve));
		const disposedWhileSecondWasBlocked = disposed;
		secondBlock.release.resolve();
		await Promise.all([secondAppend, dispose]);

		expect(disposedWhileSecondWasBlocked).toBe(false);
		expect(disposed).toBe(true);
	});

	it("waits for accepted appends before disposal and rejects later writes", async () => {
		const root = createTempDir();
		const env = new BlockingAppendEnv({ cwd: root });
		const store = createJsonlSessionStore({ fs: env, sessionsRoot: root });
		const repo = createSessionRepository({ store });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const append = session.appendMessage(createUserMessage("accepted"));
		await env.appendStarted.promise;
		let closed = false;
		const dispose = store[Symbol.asyncDispose]().then(() => {
			closed = true;
		});
		await Promise.resolve();
		expect(closed).toBe(false);
		env.releaseAppend.resolve();
		await append;
		await dispose;
		await expect(session.appendMessage(createUserMessage("late"))).rejects.toThrow("JSONL session store is disposed");
	});

	it("parses once when opened and retains state across appends", async () => {
		const root = createTempDir();
		const env = new CountingReadEnv({ cwd: root });
		const repo = createSessionRepository({ store: createJsonlSessionStore({ fs: env, sessionsRoot: root }) });
		const created = await repo.create({ cwd: root, id: "session-1" });
		const metadata = await created.getMetadata();
		await created.appendMessage(createUserMessage("initial"));
		env.readCount = 0;
		const opened = await repo.open(metadata);
		for (let i = 0; i < 10; i++) await opened.appendMessage(createUserMessage(`message ${i}`));
		expect(env.readCount).toBe(1);
	});

	it("stores sessions below encoded cwd directories and lists by cwd", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const cwd = "/tmp/my-project";
		const otherCwd = "/tmp/other-project";
		const repo = createSessionRepository({ store: createJsonlSessionStore({ fs: env, sessionsRoot: root }) });
		const session = await repo.create({ cwd, id: "019de8c2-de29-73e9-ae0c-e134db34c447" });
		const otherSession = await repo.create({ cwd: otherCwd, id: "other-session" });
		const metadata = await session.getMetadata();
		const otherMetadata = await otherSession.getMetadata();
		expect(metadata.path).toContain("--tmp-my-project--");
		expect(otherMetadata.path).toContain("--tmp-other-project--");
		expect(existsSync(metadata.path)).toBe(true);
		expect((await repo.list({ cwd })).map((sessionMetadata) => sessionMetadata.id)).toEqual([metadata.id]);
		expect((await repo.list()).map((sessionMetadata) => sessionMetadata.id).sort()).toEqual(
			[metadata.id, otherMetadata.id].sort(),
		);
	});

	it("fails loudly when listing a malformed session file", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = createSessionRepository({ store: createJsonlSessionStore({ fs: env, sessionsRoot: root }) });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const metadata = await session.getMetadata();
		writeFileSync(metadata.path, "not json\n");

		await expect(repo.list()).rejects.toMatchObject({ code: "invalid_session" });
	});

	it("rejects a missing active leaf when opened", async () => {
		const root = createTempDir();
		const store = createJsonlSessionStore({ fs: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });
		const repo = createSessionRepository({ store });
		const metadata = await store.sessions.create({ cwd: root, id: "session-1" });
		await store.entries.append(metadata, {
			type: "leaf",
			id: "leaf",
			parentId: null,
			targetId: "missing",
			timestamp: "2026-01-01T00:00:00.000Z",
		});

		await expect(repo.open(metadata)).rejects.toMatchObject({
			code: "invalid_session",
			message: "Entry missing not found",
		});
	});

	it("opens, deletes, and forks by metadata", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = createSessionRepository({ store: createJsonlSessionStore({ fs: env, sessionsRoot: root }) });
		const source = await repo.create({ cwd: "/tmp/source", id: "source-session" });
		const sourceMetadata = await source.getMetadata();
		const user1 = await source.appendMessage(createUserMessage("one"));
		const assistant1 = await source.appendMessage(createAssistantMessage("two"));
		const user2 = await source.appendMessage(createUserMessage("three"));
		await expect((await repo.open(sourceMetadata)).getMetadata()).resolves.toEqual(sourceMetadata);
		const fork = await repo.fork(sourceMetadata, { cwd: "/tmp/target", id: "fork-session", entryId: user2 });
		const forkMetadata = await fork.getMetadata();
		expect(forkMetadata.cwd).toBe("/tmp/target");
		expect(forkMetadata.parentSessionPath).toBe(sourceMetadata.path);
		expect((await fork.getEntries()).map((entry) => entry.id)).toEqual([user1, assistant1]);
		const fullFork = await repo.fork(sourceMetadata, { cwd: "/tmp/target", id: "full-fork-session" });
		expect((await fullFork.getEntries()).map((entry) => entry.id)).toEqual([user1, assistant1, user2]);
		await repo.delete(sourceMetadata);
		expect(existsSync(sourceMetadata.path)).toBe(false);
		await expect(repo.open(sourceMetadata)).rejects.toThrow("Session not found");
	});

	it("persists header metadata through create, list, and fork", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = createSessionRepository({ store: createJsonlSessionStore({ fs: env, sessionsRoot: root }) });
		const source = await repo.create({
			cwd: "/tmp/source",
			id: "source-session",
			metadata: { profile: "reviewer" },
		});
		const sourceMetadata = await source.getMetadata();
		expect(sourceMetadata.metadata).toEqual({ profile: "reviewer" });
		expect((await repo.list({ cwd: "/tmp/source" })).map((listed) => listed.metadata)).toEqual([
			{ profile: "reviewer" },
		]);
		const fork = await repo.fork(sourceMetadata, { cwd: "/tmp/target", id: "fork-session" });
		expect((await fork.getMetadata()).metadata).toEqual({ profile: "reviewer" });
		const overridden = await repo.fork(sourceMetadata, {
			cwd: "/tmp/target",
			id: "overridden-session",
			metadata: { profile: "writer" },
		});
		expect((await overridden.getMetadata()).metadata).toEqual({ profile: "writer" });
	});
});
