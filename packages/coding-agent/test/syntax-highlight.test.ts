import { resetCapabilitiesCache, setCapabilities, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsManager } from "../src/core/settings-manager.ts";
import { highlightCode, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { InteractiveThemeController } from "../src/modes/interactive/theme/theme-controller.ts";
import { HIGHLIGHT_LANGUAGES } from "../src/utils/highlight-languages.ts";
import {
	getLanguageFromPath,
	highlight,
	loadHighlightLanguage,
	onHighlightLanguageLoad,
	renderHighlightedHtml,
	requestHighlightLanguage,
	supportsLanguage,
} from "../src/utils/syntax-highlight.ts";

describe("syntax highlight renderer", () => {
	it("renders highlighted spans with the provided theme", () => {
		const rendered = renderHighlightedHtml('<span class="hljs-keyword">const</span> value', {
			keyword: (text) => `[keyword:${text}]`,
		});
		expect(rendered).toBe("[keyword:const] value");
	});

	it("decodes HTML entities emitted by highlight.js", () => {
		const rendered = renderHighlightedHtml("&lt;tag attr=&quot;value&quot;&gt;&amp;#x41;&#65;&lt;/tag&gt;");
		expect(rendered).toBe('<tag attr="value">&#x41;A</tag>');
	});

	it("inherits parent formatting for unmapped nested scopes", () => {
		const interpolation = "$" + "{x}";
		const rendered = renderHighlightedHtml(
			`<span class="hljs-string">a<span class="hljs-subst">${interpolation}</span>b</span>`,
			{
				string: (text) => `[string:${text}]`,
			},
		);
		expect(rendered).toBe(`[string:a][string:${interpolation}][string:b]`);
	});

	it("keeps parent formatting across unscoped nested spans", () => {
		const rendered = renderHighlightedHtml('<span class="hljs-string">a<span class="language-xml">b</span>c</span>', {
			string: (text) => `[string:${text}]`,
		});
		expect(rendered).toBe("[string:a][string:b][string:c]");
	});

	it("highlights code through highlight.js", () => {
		expect(supportsLanguage("typescript")).toBe(true);
		const rendered = highlight("const value = 1", {
			language: "typescript",
			ignoreIllegals: true,
			theme: {
				keyword: (text) => `[keyword:${text}]`,
				number: (text) => `[number:${text}]`,
			},
		});
		expect(rendered).toContain("[keyword:const]");
		expect(rendered).toContain("[number:1]");
	});

	it("maps file extensions and preloads only common languages", () => {
		expect(getLanguageFromPath("src/main.ts")).toBe("typescript");
		expect(getLanguageFromPath("public/index.html")).toBe("html");
		expect(getLanguageFromPath("Dockerfile")).toBe("dockerfile");
		expect(getLanguageFromPath("build.ps1")).toBe("powershell");
		expect(getLanguageFromPath("config.toml")).toBe("toml");
		expect(getLanguageFromPath("shell.fish")).toBe("fish");
		expect(getLanguageFromPath("style.sass")).toBe("sass");
		expect(getLanguageFromPath("schema.graphql")).toBe("graphql");
		expect(getLanguageFromPath("main.tf")).toBe("hcl");
		expect(getLanguageFromPath("config.hcl")).toBe("hcl");
		expect(supportsLanguage(getLanguageFromPath("src/main.ts")!)).toBe(true);
		expect(supportsLanguage(getLanguageFromPath("public/index.html")!)).toBe(true);
		expect(supportsLanguage(getLanguageFromPath("Dockerfile")!)).toBe(false);
		expect(supportsLanguage(getLanguageFromPath("build.ps1")!)).toBe(false);
		const handlebars = HIGHLIGHT_LANGUAGES.find(({ name }) => name === "handlebars");
		expect(handlebars?.definition).toBeUndefined();
		expect(handlebars?.load).toBeTypeOf("function");
		for (const unsupported of ["fish", "graphql", "hcl", "sass"]) {
			expect(requestHighlightLanguage(unsupported)).toBeUndefined();
		}
	});

	it("normalizes names and loads aliases through their canonical grammar", async () => {
		expect(requestHighlightLanguage("ToMl")).toBeUndefined();
		expect(await loadHighlightLanguage("TOML")).toBe(true);
		expect(supportsLanguage("ini")).toBe(true);
		expect(supportsLanguage("toml")).toBe(true);
		expect(requestHighlightLanguage("ToMl")).toBe("toml");

		expect(requestHighlightLanguage("Rust")).toBeUndefined();
		expect(await loadHighlightLanguage("RUST")).toBe(true);
		expect(supportsLanguage("rust")).toBe(true);
		expect(requestHighlightLanguage("Rust")).toBe("rust");

		expect(await loadHighlightLanguage("PowerShell")).toBe(true);
		expect(supportsLanguage("POWERSHELL")).toBe(true);
	});

	it("keeps duplicate aliases bound to their canonical grammar", async () => {
		expect(await loadHighlightLanguage("ls")).toBe(true);
		expect(requestHighlightLanguage("ls")).toBe("livescript");
		expect(await loadHighlightLanguage("lasso")).toBe(true);
		expect(requestHighlightLanguage("ls")).toBe("livescript");

		expect(await loadHighlightLanguage("ml")).toBe(true);
		expect(requestHighlightLanguage("ml")).toBe("sml");
		expect(await loadHighlightLanguage("ocaml")).toBe(true);
		expect(requestHighlightLanguage("ml")).toBe("sml");

		expect(await loadHighlightLanguage("hbs")).toBe(true);
		expect(requestHighlightLanguage("hbs")).toBe("htmlbars");
		expect(await loadHighlightLanguage("handlebars")).toBe(true);
		expect(requestHighlightLanguage("hbs")).toBe("htmlbars");
	});

	it("loads required sublanguage grammars", async () => {
		expect(supportsLanguage("ruby")).toBe(true);
		expect(await loadHighlightLanguage("ERB")).toBe(true);
		expect(
			highlight("<%= User.find(1) %>", {
				language: "erb",
				theme: { number: (text) => `[number:${text}]` },
			}),
		).toContain("[number:1]");

		expect(supportsLanguage("php")).toBe(false);
		expect(await loadHighlightLanguage("php-template")).toBe(true);
		expect(supportsLanguage("php")).toBe(true);
		expect(
			highlight("<?php echo $value; ?>", {
				language: "php-template",
				theme: { keyword: (text) => `[keyword:${text}]` },
			}),
		).toContain("[keyword:echo]");

		expect(await loadHighlightLanguage("mojolicious")).toBe(true);
		expect(supportsLanguage("perl")).toBe(true);
	});

	it("loads only the requested uncommon language", async () => {
		expect(supportsLanguage("brainfuck")).toBe(false);
		expect(supportsLanguage("abnf")).toBe(false);
		let notifications = 0;
		const unsubscribe = onHighlightLanguageLoad(() => notifications++);

		expect(requestHighlightLanguage("bf")).toBeUndefined();
		expect(await loadHighlightLanguage("bf")).toBe(true);
		expect(supportsLanguage("brainfuck")).toBe(true);
		expect(supportsLanguage("bf")).toBe(true);
		expect(supportsLanguage("abnf")).toBe(false);
		expect(notifications).toBe(1);

		expect(await loadHighlightLanguage("abnf")).toBe(true);
		expect(supportsLanguage("abnf")).toBe(true);
		expect(notifications).toBe(2);
		unsubscribe();
	});

	it("reports background load failures once without retrying", async () => {
		const language = HIGHLIGHT_LANGUAGES.find(({ name }) => name === "accesslog");
		if (!language?.load) throw new Error("accesslog test grammar is missing");
		const originalLoad = language.load;
		const loadError = new Error("test grammar load failed");
		let attempts = 0;
		language.load = () => {
			attempts++;
			return Promise.reject(loadError);
		};
		let resolveFailure: (failure: { language: string; error: unknown }) => void = () => {};
		const failure = new Promise<{ language: string; error: unknown }>((resolve) => {
			resolveFailure = resolve;
		});
		const unsubscribe = onHighlightLanguageLoad((event) => {
			if ("error" in event) resolveFailure({ language: event.language, error: event.error });
		});

		try {
			expect(requestHighlightLanguage("AccessLog")).toBeUndefined();
			await expect(failure).resolves.toEqual({ language: "accesslog", error: loadError });
			expect(requestHighlightLanguage("accesslog")).toBeUndefined();
			await Promise.resolve();
			await Promise.resolve();
			expect(attempts).toBe(1);
			await expect(loadHighlightLanguage("accesslog")).rejects.toThrow("test grammar load failed");
		} finally {
			language.load = originalLoad;
			unsubscribe();
		}
	});
});

describe("highlight language load lifecycle", () => {
	it("invalidates only affected targets while retaining a global fallback", async () => {
		const invalidate = vi.fn();
		const requestRender = vi.fn();
		const unsubscribeTerminalTheme = vi.fn();
		const ui = {
			invalidate,
			requestRender,
			onTerminalColorSchemeChange: () => unsubscribeTerminalTheme,
		} as unknown as TUI;
		const settingsManager = { getThemeSetting: () => "dark" } as unknown as SettingsManager;
		const controller = new InteractiveThemeController(ui, settingsManager, vi.fn(), vi.fn());
		const arcade = HIGHLIGHT_LANGUAGES.find(({ name }) => name === "arcade");
		const oneC = HIGHLIGHT_LANGUAGES.find(({ name }) => name === "1c");
		const eager = HIGHLIGHT_LANGUAGES.find(({ name }) => name === "bash");
		if (!arcade?.load || !oneC?.load || !eager?.definition) throw new Error("highlight test grammars are missing");
		const originalArcadeLoad = arcade.load;
		const originalOneCLoad = oneC.load;
		arcade.load = () => Promise.resolve({ default: eager.definition! });
		oneC.load = () => Promise.resolve({ default: eager.definition! });

		try {
			const loaded = new Set<string>();
			let resolveLoads = (): void => {};
			const loadsFinished = new Promise<void>((resolve) => {
				resolveLoads = resolve;
			});
			const unsubscribeLoads = onHighlightLanguageLoad((event) => {
				if ("error" in event) return;
				loaded.add(event.language);
				if (loaded.has("arcade") && loaded.has("1c")) resolveLoads();
			});
			const invalidateArcade = vi.fn();
			const invalidateOneC = vi.fn();

			highlightCode("let value = 1", "arcade", { onLanguageReady: invalidateArcade });
			highlightCode("let value = 1", "1c", { onLanguageReady: invalidateOneC });
			await loadsFinished;
			unsubscribeLoads();

			expect(invalidateArcade).toHaveBeenCalledOnce();
			expect(invalidateOneC).toHaveBeenCalledOnce();
			expect(invalidate).not.toHaveBeenCalled();
			expect(requestRender).not.toHaveBeenCalled();
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(invalidate).not.toHaveBeenCalled();
			expect(requestRender).toHaveBeenCalledOnce();
			requestRender.mockClear();

			highlightCode("package main", "ada");
			await loadHighlightLanguage("ada");
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(invalidate).toHaveBeenCalledOnce();
			expect(requestRender).toHaveBeenCalledOnce();
			invalidate.mockClear();
			requestRender.mockClear();

			controller.dispose();
			await loadHighlightLanguage("apache");
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(unsubscribeTerminalTheme).toHaveBeenCalledOnce();
			expect(invalidate).not.toHaveBeenCalled();
			expect(requestRender).not.toHaveBeenCalled();
		} finally {
			arcade.load = originalArcadeLoad;
			oneC.load = originalOneCLoad;
			controller.dispose();
		}
	});
});

describe("theme syntax highlighting", () => {
	beforeEach(() => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		initTheme("dark");
	});

	afterEach(() => {
		resetCapabilitiesCache();
	});

	it("colors diff additions and deletions in fenced diff blocks", () => {
		const lines = highlightCode("-old\n+new\n", "diff");

		expect(lines[0]).toBe("\x1b[38;2;204;102;102m-old\x1b[39m");
		expect(lines[1]).toBe("\x1b[38;2;181;189;104m+new\x1b[39m");
	});

	it("keeps cli-highlight default styled scopes mapped to theme styles", () => {
		expect(highlightCode("const re = /foo+/gi;", "javascript")[0]).toContain(
			"\x1b[38;2;206;145;120m/foo+/gi\x1b[39m",
		);
		expect(highlightCode("@decorator", "python")[0]).toBe("\x1b[38;2;128;128;128m@decorator\x1b[39m");
		expect(highlightCode("<div></div>", "html")[0]).toContain("\x1b[38;2;86;156;214mdiv\x1b[39m");
	});
});
