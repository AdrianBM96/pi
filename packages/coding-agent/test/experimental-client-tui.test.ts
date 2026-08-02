import { describe, expect, test } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import {
	EXPERIMENTAL_SLASH_COMMANDS,
	isKnownExperimentalSlashCommand,
	SlashCommandAutocompleteProvider,
} from "../src/experimental/client-server/command-autocomplete.ts";
import { DoubleClearAction } from "../src/experimental/client-server/tui.ts";

describe("experimental client TUI", () => {
	test("exits only when app.clear is triggered twice within 500 ms", () => {
		const action = new DoubleClearAction();

		expect(action.trigger(1_000)).toBe("clear");
		expect(action.trigger(1_499)).toBe("exit");
		expect(action.trigger(1_500)).toBe("clear");
	});

	test("starts a new double-clear window after the timeout", () => {
		const action = new DoubleClearAction();

		expect(action.trigger(1_000)).toBe("clear");
		expect(action.trigger(1_500)).toBe("clear");
		expect(action.trigger(1_999)).toBe("exit");
	});
});

describe("experimental client command autocomplete", () => {
	test("shows every legacy and experimental command when slash is typed", async () => {
		const provider = new SlashCommandAutocompleteProvider(EXPERIMENTAL_SLASH_COMMANDS);
		const suggestions = await provider.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal });

		expect(suggestions?.prefix).toBe("/");
		expect(suggestions?.items.map((item) => item.value)).toEqual([
			...BUILTIN_SLASH_COMMANDS.map((command) => command.name),
			"reconnect",
		]);
		expect(suggestions?.items.map((item) => item.value)).not.toContain("exit");
		expect(isKnownExperimentalSlashCommand("tree")).toBe(true);
		expect(isKnownExperimentalSlashCommand("made-up")).toBe(false);
	});

	test("filters commands without enabling filesystem completion", async () => {
		const provider = new SlashCommandAutocompleteProvider(EXPERIMENTAL_SLASH_COMMANDS);
		const signal = new AbortController().signal;

		expect((await provider.getSuggestions(["/rec"], 0, 4, { signal }))?.items.map((item) => item.value)).toEqual([
			"reconnect",
		]);
		expect(
			(await provider.getSuggestions(["/rec"], 0, 4, { signal, force: true }))?.items.map((item) => item.value),
		).toEqual(["reconnect"]);
		expect(await provider.getSuggestions(["README"], 0, 6, { signal, force: true })).toBeNull();
		expect(provider.shouldTriggerFileCompletion()).toBe(false);
	});
});
