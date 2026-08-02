import type { Terminal } from "./terminal.ts";
import type { TuiAltScreenOptions } from "./tui-alt-screen.ts";
import { TuiAltScreen } from "./tui-alt-screen.ts";

export type TuiScreenMode = "main" | "alternate";

export interface SwitchableTuiOptions {
	mode: TuiScreenMode;
	showHardwareCursor?: boolean;
	logDirectory?: string;
	altScreen?: TuiAltScreenOptions;
}

/** TUI that can switch between main-screen and alternate-screen rendering. */
export class SwitchableTui extends TuiAltScreen {
	private currentMode: TuiScreenMode;
	private started = false;
	private renderedMainScreen: boolean;
	private mainViewportDirty = false;

	constructor(terminal: Terminal, options: SwitchableTuiOptions) {
		super(terminal, options.showHardwareCursor, options.logDirectory, options.altScreen);
		this.currentMode = options.mode;
		this.renderedMainScreen = options.mode === "main";
	}

	protected override get alternateScreenEnabled(): boolean {
		return this.currentMode === "alternate";
	}

	get mode(): TuiScreenMode {
		return this.currentMode;
	}

	private renderMainScreen(): void {
		this.renderedMainScreen = true;
		this.renderMainScreenImmediately(this.mainViewportDirty);
		this.mainViewportDirty = false;
	}

	setMode(mode: TuiScreenMode): boolean {
		if (mode === this.currentMode) return true;
		if (this.hasOverlayEntries) return false;
		if (!this.started) {
			this.currentMode = mode;
			if (mode === "main") this.renderedMainScreen = true;
			this.invalidate();
			return true;
		}

		this.switchRenderer(() => {
			this.currentMode = mode;
		});
		this.invalidate();
		if (mode === "main") this.renderMainScreen();
		return true;
	}

	override start(): void {
		if (this.started) return;
		super.start();
		this.started = true;
		if (this.currentMode === "main" && this.mainViewportDirty) this.renderMainScreen();
	}

	override stop(): void {
		if (!this.started) return;
		const mode = this.currentMode;
		try {
			if (mode === "alternate" && this.renderedMainScreen) {
				this.switchRenderer(() => {
					this.currentMode = "main";
				}, false);
				this.invalidate();
				this.renderMainScreen();
			}
		} finally {
			try {
				super.stop();
			} finally {
				this.currentMode = mode;
				if (mode === "alternate" && this.renderedMainScreen) this.mainViewportDirty = true;
				this.started = false;
			}
		}
	}
}
