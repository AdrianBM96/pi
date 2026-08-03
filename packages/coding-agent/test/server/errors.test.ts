import { AgentHarnessError, SessionError } from "@earendil-works/pi-agent-core";
import { PiServerError } from "@earendil-works/pi-server";
import { describe, expect, test } from "vitest";
import { createInternalServerError, mapKnownServerError } from "../../src/server/errors.ts";

describe("coding-agent server error mapping", () => {
	test("maps known domain errors to stable protocol errors", () => {
		const existing = new PiServerError("session_locked", "already mapped");
		expect(mapKnownServerError(existing)).toBe(existing);
		expect(mapKnownServerError(new AgentHarnessError("busy", "harness busy"))).toMatchObject({
			code: "busy",
			message: "harness busy",
		});
		expect(mapKnownServerError(new AgentHarnessError("invalid_argument", "bad argument"))).toMatchObject({
			code: "invalid_request",
			message: "bad argument",
		});
		const missing = new SessionError("not_found", "missing session");
		expect(mapKnownServerError(missing)).toMatchObject({ code: "not_found", message: "missing session" });
		expect(mapKnownServerError(new AgentHarnessError("session", "wrapped missing session", missing))).toMatchObject({
			code: "not_found",
			message: "wrapped missing session",
		});
	});

	test("does not classify unexpected failures as protocol-safe", () => {
		expect(mapKnownServerError(new Error("private detail"))).toBeUndefined();
		expect(mapKnownServerError(new AgentHarnessError("unknown", "unexpected"))).toBeUndefined();
		expect(mapKnownServerError("non-error throw")).toBeUndefined();

		const internal = createInternalServerError("private detail");
		expect(internal).toMatchObject({ code: "internal_error", message: "Internal server error" });
		expect(internal.cause).toMatchObject({ message: "private detail" });
	});
});
