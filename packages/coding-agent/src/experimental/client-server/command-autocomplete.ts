import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	CombinedAutocompleteProvider,
	type SlashCommand,
} from "@earendil-works/pi-tui";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.ts";

export const EXPERIMENTAL_SLASH_COMMANDS: readonly SlashCommand[] = [
	...BUILTIN_SLASH_COMMANDS,
	{ name: "reconnect", description: "Reconnect to the server" },
];

const EXPERIMENTAL_SLASH_COMMAND_NAMES = new Set(EXPERIMENTAL_SLASH_COMMANDS.map((command) => command.name));

export function isKnownExperimentalSlashCommand(name: string): boolean {
	return EXPERIMENTAL_SLASH_COMMAND_NAMES.has(name);
}

export class SlashCommandAutocompleteProvider implements AutocompleteProvider {
	private readonly delegate: CombinedAutocompleteProvider;

	constructor(commands: readonly SlashCommand[]) {
		this.delegate = new CombinedAutocompleteProvider([...commands], process.cwd());
	}

	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const textBeforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
		if (cursorLine !== 0 || !textBeforeCursor.startsWith("/")) return Promise.resolve(null);
		return this.delegate.getSuggestions(lines, cursorLine, cursorCol, { ...options, force: false });
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		return this.delegate.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
	}

	shouldTriggerFileCompletion(): boolean {
		return false;
	}
}
