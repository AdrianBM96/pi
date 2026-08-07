import { describe, expect, it } from "vitest";
import {
	type HandlerErrorEvent,
	type HarnessEvent,
	HarnessEventBus,
	type RunEndEvent,
	type RunStartEvent,
} from "../../src/harness/events.ts";

const runStartEvent: RunStartEvent = {
	type: "run_start",
	lane: "main",
	runId: "run-1",
};

const runEndEvent: RunEndEvent = {
	type: "run_end",
	lane: "main",
	runId: "run-1",
	outcome: "completed",
	leafId: "entry-1",
};

describe("HarnessEventBus", () => {
	it("delivers matching events to direct listeners and watchers", () => {
		const events = new HarnessEventBus();
		const direct: RunStartEvent[] = [];
		const watchEvents: HarnessEvent[] = [];
		const off = events.on("run_start", (event) => {
			direct.push(event);
		});
		const watch = events.watch(() => null);
		watch.start((event) => {
			watchEvents.push(event);
		});

		events.emit(runStartEvent);
		events.emit(runEndEvent);
		off();
		events.emit(runStartEvent);

		expect(direct).toEqual([runStartEvent]);
		expect(watchEvents).toEqual([runStartEvent, runEndEvent, runStartEvent]);
	});

	it("reports ordinary listener failures as handler_error events", () => {
		const events = new HarnessEventBus();
		const reported: HandlerErrorEvent[] = [];
		events.on("handler_error", (event) => {
			reported.push(event);
		});
		events.on("run_start", () => {
			throw new Error("listener failure");
		});

		events.emit(runStartEvent);

		expect(reported).toEqual([
			expect.objectContaining({
				type: "handler_error",
				kind: "event",
				event: "run_start",
				error: "listener failure",
			}),
		]);
	});

	it("does not recursively report handler_error listener failures", () => {
		const events = new HarnessEventBus();
		const reported: HandlerErrorEvent[] = [];
		events.on("handler_error", () => {
			throw new Error("handler error listener failure");
		});
		events.on("handler_error", (event) => {
			reported.push(event);
		});
		events.on("run_start", () => {
			throw new Error("listener failure");
		});

		events.emit(runStartEvent);

		expect(reported).toHaveLength(1);
		expect(reported[0]).toMatchObject({ type: "handler_error", event: "run_start" });
	});

	it("isolates synchronous listener failures during direct, buffered, and live delivery", () => {
		const events = new HarnessEventBus();
		const delivered: string[] = [];
		events.on("run_start", () => {
			throw new Error("direct failure");
		});
		events.on("run_start", () => {
			delivered.push("direct");
		});

		const failingWatch = events.watch(() => null);
		events.emit(runStartEvent);
		events.emit(runStartEvent);
		let bufferedAttempts = 0;
		expect(() => {
			failingWatch.start((event) => {
				if (event.type !== "run_start") return;
				bufferedAttempts++;
				throw new Error("watch failure");
			});
		}).not.toThrow();

		const continuingWatch = events.watch(() => null);
		continuingWatch.start((event) => {
			if (event.type === "run_start") delivered.push("watch");
		});
		expect(() => events.emit(runStartEvent)).not.toThrow();

		expect(bufferedAttempts).toBe(3);
		expect(delivered).toEqual(["direct", "direct", "direct", "watch"]);
	});

	it("isolates asynchronous listener rejections", async () => {
		const events = new HarnessEventBus();
		const delivered: string[] = [];
		const reported: HandlerErrorEvent[] = [];
		events.on("handler_error", (event) => {
			reported.push(event);
		});
		events.on("run_start", async () => {
			throw new Error("direct rejection");
		});
		events.on("run_start", () => {
			delivered.push("direct");
		});
		const failingWatch = events.watch(() => null);
		failingWatch.start(async (event) => {
			if (event.type === "run_start") throw new Error("watch rejection");
		});
		const continuingWatch = events.watch(() => null);
		continuingWatch.start((event) => {
			if (event.type === "run_start") delivered.push("watch");
		});

		events.emit(runStartEvent);
		await Promise.resolve();

		expect(delivered).toEqual(["direct", "watch"]);
		expect(reported).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "handler_error", event: "run_start", error: "direct rejection" }),
			]),
		);
	});

	it("captures a snapshot without an event gap, then flushes and delivers live events", () => {
		const events = new HarnessEventBus();
		const expectedSnapshot = { leafId: null };
		const watch = events.watch(() => {
			const snapshot = expectedSnapshot;
			events.emit(runStartEvent);
			return snapshot;
		});
		const received: HarnessEvent[] = [];

		expect(watch.snapshot).toBe(expectedSnapshot);
		expect(received).toEqual([]);

		watch.start((event) => {
			received.push(event);
		});
		expect(received).toEqual([runStartEvent]);

		events.emit(runEndEvent);
		expect(received).toEqual([runStartEvent, runEndEvent]);

		watch.unsubscribe();
		events.emit(runStartEvent);
		expect(received).toEqual([runStartEvent, runEndEvent]);
	});
});
