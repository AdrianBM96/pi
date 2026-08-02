import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerMessageDecoder } from "@earendil-works/pi-protocol";
import { afterEach, expect, test, vi } from "vitest";
import type { ByteConnection } from "../src/connection.ts";
import { PiServerCore } from "../src/core.ts";
import { PiServer, type PiSessionBackend } from "../src/index.ts";

const TOKEN = "transport-smoke-token";

const backend: PiSessionBackend = {
	async listSessions() {
		return [];
	},
	async listModels() {
		return [];
	},
	async createSession() {
		throw new Error("not used");
	},
	async openSession() {
		throw new Error("not used");
	},
};

let server: PiServer | undefined;
let tempDirectory: string | undefined;

async function makeSocketPath(): Promise<string> {
	tempDirectory = await mkdtemp(join(tmpdir(), "pi-server-smoke-"));
	return join(tempDirectory, "server.sock");
}

afterEach(async () => {
	await server?.close();
	if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
	server = undefined;
	tempDirectory = undefined;
});

test("requires an explicit Unix socket listener", () => {
	expect(() => Reflect.construct(PiServer, [backend, { token: TOKEN }])).toThrow(/Unix socket/);
});

test("rejects Unix socket paths that cannot fit in sockaddr_un", () => {
	expect(() => new PiServer(backend, { token: TOKEN, unix: { path: `/tmp/${"x".repeat(512)}` } })).toThrow(/too long/);
});

test("rejects an overlong derived private Unix bind path", async () => {
	const maxLength = process.platform === "linux" ? 107 : 103;
	const suffixLength = Buffer.byteLength("/tmp//s");
	const path = `/tmp/${"x".repeat(maxLength - suffixLength)}/s`;
	server = new PiServer(backend, { token: TOKEN, unix: { path } });

	await expect(server.start()).rejects.toThrow(/private Unix bind path.*too long/);
});

test("rejects concurrent start calls without leaking the Unix listener", async () => {
	const path = await makeSocketPath();
	server = new PiServer(backend, { token: TOKEN, unix: { path } });
	const starting = server.start();
	await expect(server.start()).rejects.toThrow(/starting/);
	await starting;
	await server.close();
	expect(server.unixSocketPath).toBeUndefined();
	await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
});

test("handshake timeout cleanup does not wait for a blocked output queue", async () => {
	class BlockedConnection implements ByteConnection {
		closed = false;
		finalChunk?: Uint8Array;

		send(): Promise<void> {
			return new Promise(() => {});
		}

		close(finalChunk?: Uint8Array): void {
			this.finalChunk = finalChunk;
			this.closed = true;
		}
	}
	const core = new PiServerCore(backend, {
		token: TOKEN,
		maxFrameLength: 1024,
		handshakeTimeoutMs: 10,
	});
	const connection = new BlockedConnection();
	core.accept(connection);

	await vi.waitFor(() => expect(connection.closed).toBe(true));
	expect(connection.finalChunk).toBeInstanceOf(Uint8Array);
	const messages = new ServerMessageDecoder().push(connection.finalChunk!);
	expect(messages).toMatchObject([{ type: "hello_error", error: { code: "invalid_request" } }]);
	await core.close();
});

test("rejects timeout values above Node's maximum timer delay", () => {
	const unix = { path: "/tmp/pi-server-timeout-test.sock" };
	expect(() => new PiServer(backend, { token: TOKEN, unix, handshakeTimeoutMs: 2_147_483_648 })).toThrow(
		/handshakeTimeoutMs/,
	);
	expect(() => new PiServer(backend, { token: TOKEN, unix, gracefulCloseTimeoutMs: 2_147_483_648 })).toThrow(
		/gracefulCloseTimeoutMs/,
	);
});

test("rejects pending-byte limits smaller than one maximum frame", async () => {
	const path = await makeSocketPath();
	expect(
		() => new PiServer(backend, { token: TOKEN, unix: { path }, maxFrameLength: 128, maxPendingBytes: 131 }),
	).toThrow(/maxPendingBytes/);
});
