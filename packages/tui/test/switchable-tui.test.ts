import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { Image } from "../src/components/image.ts";
import { SwitchableTui } from "../src/switchable-tui.ts";
import type { TerminalCapabilities } from "../src/terminal-image.ts";
import { resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.ts";
import type { Component } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const NO_IMAGES: TerminalCapabilities = { images: null, trueColor: true, hyperlinks: true };

class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];
	startCount = 0;
	stopCount = 0;
	active = false;

	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.startCount += 1;
		this.active = true;
		super.start(onInput, onResize);
	}

	suspendRenderer(): void {}

	resumeRenderer(): void {}

	override stop(): void {
		this.stopCount += 1;
		this.active = false;
		super.stop();
	}

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

afterEach(() => resetCapabilitiesCache());

describe("SwitchableTui", () => {
	it("cleans up the terminal when final main-screen rendering throws", async () => {
		setCapabilities(NO_IMAGES);
		const terminal = new RecordingTerminal(40, 8);
		const tui = new SwitchableTui(terminal, { mode: "main" });
		let throwOnRender = false;
		tui.addChild({
			render: () => {
				if (throwOnRender) throw new Error("extension render failed");
				return ["content"];
			},
			invalidate: () => {},
		});
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(tui.setMode("alternate"), true);
		await terminal.waitForRender();

		throwOnRender = true;
		assert.throws(() => tui.stop(), /extension render failed/);
		assert.strictEqual(terminal.active, false);
		assert.strictEqual(terminal.stopCount, 1);

		tui.stop();
		assert.strictEqual(terminal.stopCount, 1);
	});

	it("recovers the main viewport without clearing scrollback", async () => {
		setCapabilities(NO_IMAGES);
		const terminal = new RecordingTerminal(40, 4);
		for (let index = 1; index <= 12; index++) terminal.write(`history ${index}\r\n`);
		await terminal.flush();

		const tui = new SwitchableTui(terminal, { mode: "main" });
		tui.addChild({ render: () => ["header", "body", "editor"], invalidate: () => {} });
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(tui.setMode("alternate"), true);
		await terminal.waitForRender();
		tui.stop();

		tui.start();
		await terminal.waitForRender();
		terminal.writes.length = 0;
		tui.stop();
		await terminal.flush();

		const output = terminal.writes.join("");
		assert.ok(output.includes("\x1b[2J\x1b[H"), "recovery should clear the visible viewport");
		assert.ok(!output.includes("\x1b[3J"), "recovery must not clear terminal scrollback");
		assert.ok(terminal.getScrollBuffer().some((line) => line.includes("history 1")));
	});

	it("invalidates image placeholders after restoring iTerm2 capabilities", async () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		const terminal = new RecordingTerminal(40, 8);
		const tui = new SwitchableTui(terminal, { mode: "main" });
		const image = new Image(
			"AAAA",
			"image/png",
			{ fallbackColor: (value) => value },
			{ filename: "example.png" },
			{ widthPx: 10, heightPx: 10 },
		);
		tui.addChild(image);
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(tui.setMode("alternate"), true);
		await terminal.waitForRender();

		assert.strictEqual(tui.setMode("main"), true);
		await terminal.waitForRender();
		const renderedImage = image.render(terminal.columns).join("");
		assert.ok(renderedImage.includes("\x1b]1337;File="));
		assert.ok(!renderedImage.includes("[Image:"));
		tui.stop();
	});

	it("repaints Kitty images after returning to the main screen", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const terminal = new RecordingTerminal(20, 6);
		const tui = new SwitchableTui(terminal, { mode: "main" });
		tui.addChild(
			new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 1, maxHeightCells: 2 },
				{ widthPx: 9, heightPx: 36 },
			),
		);
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(tui.setMode("alternate"), true);
		await terminal.waitForRender();

		terminal.writes.length = 0;
		assert.strictEqual(tui.setMode("main"), true);
		await terminal.waitForRender();
		const output = terminal.writes.join("");
		const deleteIndex = output.indexOf("\x1b_Ga=d,d=A");
		const transmitIndex = output.lastIndexOf("\x1b_Ga=T");
		assert.ok(deleteIndex >= 0);
		assert.ok(transmitIndex > deleteIndex, "main-screen image must be retransmitted after Kitty deletes it");
		tui.stop();
	});

	it("does not repaint Kitty images above a preserved main-screen viewport", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const terminal = new RecordingTerminal(20, 3);
		const tui = new SwitchableTui(terminal, { mode: "main" });
		tui.setClearOnShrink(false);
		tui.addChild({ render: () => ["prefix 1", "prefix 2", "prefix 3"], invalidate: () => {} });
		tui.addChild(
			new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 1, maxHeightCells: 2 },
				{ widthPx: 9, heightPx: 36 },
			),
		);
		let tail = ["tail 1", "tail 2", "tail 3"];
		tui.addChild({ render: () => tail, invalidate: () => {} });
		tui.start();
		await terminal.waitForRender();

		tail = ["tail 1"];
		tui.requestRender();
		await terminal.waitForRender();
		assert.strictEqual(tui.setMode("alternate"), true);
		await terminal.waitForRender();

		terminal.writes.length = 0;
		assert.strictEqual(tui.setMode("main"), true);
		await terminal.waitForRender();
		const output = terminal.writes.join("");
		assert.ok(output.includes("\x1b_Ga=d,d=A"));
		assert.ok(!output.includes("\x1b_Ga=T"), "image above the tracked viewport must stay in scrollback");
		tui.stop();
	});

	it("crops a Kitty image crossing the recovered viewport boundary", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const terminal = new RecordingTerminal(20, 3);
		const tui = new SwitchableTui(terminal, { mode: "main" });
		tui.addChild(
			new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 1, maxHeightCells: 3 },
				{ widthPx: 9, heightPx: 54 },
			),
		);
		tui.addChild({ render: () => ["tail 1", "tail 2"], invalidate: () => {} });
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(tui.setMode("alternate"), true);
		await terminal.waitForRender();
		tui.stop();

		tui.start();
		await terminal.waitForRender();
		terminal.writes.length = 0;
		tui.stop();
		const output = terminal.writes.join("");
		assert.ok(output.includes("y=36,h=18,r=1"), "visible image rows should be retransmitted as a crop");
		assert.ok(!output.includes("\x1b[3J"));
	});

	it("invalidates an inactive layout root before activating it", async () => {
		setCapabilities(NO_IMAGES);
		const terminal = new RecordingTerminal(40, 8);
		const tui = new SwitchableTui(terminal, { mode: "alternate" });
		let value = "old fullscreen value";
		let cachedLines: string[] | undefined;
		const fullscreenRoot: Component = {
			render: () => {
				cachedLines ??= [value];
				return cachedLines;
			},
			invalidate: () => {
				cachedLines = undefined;
			},
		};
		tui.setLayoutRoot(fullscreenRoot);
		tui.addChild({ render: () => ["main value"], invalidate: () => {} });
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(tui.setMode("main"), true);
		await terminal.waitForRender();

		value = "new fullscreen value";
		tui.invalidate();
		assert.strictEqual(tui.setMode("alternate"), true);
		await terminal.waitForRender();
		const viewport = terminal.getViewport().join("\n");
		assert.ok(viewport.includes("new fullscreen value"));
		assert.ok(!viewport.includes("old fullscreen value"));
		tui.stop();
	});
});
