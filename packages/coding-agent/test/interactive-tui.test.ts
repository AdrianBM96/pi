import type { Component, Terminal } from "@earendil-works/pi-tui";
import { Container, isViewportTUI, Text } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { createInteractiveTui, InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

class RecordingTerminal extends VirtualTerminal implements Terminal {
	readonly writes: string[] = [];
	startCount = 0;
	stopCount = 0;

	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.startCount += 1;
		super.start(onInput, onResize);
	}

	suspendRenderer(): void {}
	resumeRenderer(): void {}

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	override stop(): void {
		this.stopCount += 1;
		super.stop();
	}
}

function createTui(terminal: Terminal, uiMode: "regular" | "fullscreen" = "regular") {
	return createInteractiveTui({ uiMode, showHardwareCursor: false, logDirectory: "/tmp", terminal });
}

describe("createInteractiveTui", () => {
	it("selects the requested renderer", async () => {
		for (const uiMode of ["regular", "fullscreen"] as const) {
			const terminal = new RecordingTerminal();
			const tui = createTui(terminal, uiMode);
			expect(isViewportTUI(tui)).toBe(uiMode === "fullscreen");
			tui.start();
			await terminal.waitForRender();
			expect(terminal.writes.some((write) => write.includes("\x1b[?1049h"))).toBe(uiMode === "fullscreen");
			tui.stop();
		}
	});

	it("switches renderers without restarting the terminal or losing focus", async () => {
		const terminal = new RecordingTerminal();
		const tui = createTui(terminal);
		const inputs: string[] = [];
		const component: Component = {
			render: () => ["content"],
			handleInput: (data) => inputs.push(data),
			invalidate: () => {},
		};
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
		await terminal.waitForRender();

		const overlay = tui.showOverlay(new Text("overlay", 0, 0));
		expect(tui.setMode("alternate")).toBe(false);
		overlay.hide();
		expect(tui.setMode("alternate")).toBe(true);
		expect(isViewportTUI(tui)).toBe(true);
		terminal.sendInput("a");
		expect(tui.setMode("main")).toBe(true);

		expect(isViewportTUI(tui)).toBe(false);
		expect([terminal.startCount, terminal.stopCount]).toEqual([1, 0]);
		expect(inputs).toEqual(["a"]);
		tui.stop();
		expect(terminal.stopCount).toBe(1);
	});
});

type ClearStatusContext = {
	activeStatusIndicator: { kind: "working"; dispose: () => void } | undefined;
	statusContainer: Container;
	uiMode: "regular" | "fullscreen";
	ui: { getClearOnShrink: () => boolean };
	idleStatus: Component;
};

type InteractiveModePrototype = {
	clearStatusIndicator(this: ClearStatusContext, kind?: "working"): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("clear-on-shrink status spacing", () => {
	it("reserves status height only on the main-screen renderer", () => {
		for (const [mode, expectedChildren] of [
			["main", 1],
			["alternate", 0],
		] as const) {
			const dispose = vi.fn();
			const context: ClearStatusContext = {
				activeStatusIndicator: { kind: "working", dispose },
				statusContainer: new Container(),
				uiMode: mode === "main" ? "regular" : "fullscreen",
				ui: { getClearOnShrink: () => true },
				idleStatus: new Text("", 0, 0),
			};

			interactiveModePrototype.clearStatusIndicator.call(context);

			expect(dispose).toHaveBeenCalledOnce();
			expect(context.statusContainer.children).toHaveLength(expectedChildren);
		}
	});
});
