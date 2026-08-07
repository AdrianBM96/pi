import hljs, { type LanguageDefinition } from "highlight.js/lib/core.js";
import { HIGHLIGHT_LANGUAGES, type HighlightLanguage } from "./highlight-languages.ts";
import { decodeHtmlEntityAt } from "./html.ts";

export type HighlightFormatter = (text: string) => string;
export type HighlightTheme = Partial<Record<string, HighlightFormatter>>;

export interface HighlightOptions {
	language?: string;
	ignoreIllegals?: boolean;
	languageSubset?: string[];
	theme?: HighlightTheme;
}

const LANGUAGE_BY_NAME = new Map<string, HighlightLanguage>();
for (const language of HIGHLIGHT_LANGUAGES) {
	LANGUAGE_BY_NAME.set(language.name, language);
	for (const alias of language.aliases ?? []) LANGUAGE_BY_NAME.set(alias.toLowerCase(), language);
}

const LANGUAGE_BY_EXTENSION = new Map(
	HIGHLIGHT_LANGUAGES.flatMap(({ name, extensions = [] }) =>
		extensions.map((extension) => [extension, name] as const),
	),
);

const registeredLanguages = new Set<string>();

function registerLanguage(language: HighlightLanguage, definition: LanguageDefinition): void {
	if (registeredLanguages.has(language.name)) return;
	hljs.registerLanguage(language.name, definition);
	registeredLanguages.add(language.name);
}

for (const language of HIGHLIGHT_LANGUAGES) {
	if (language.definition) registerLanguage(language, language.definition);
}

type HighlightLanguageLoadEvent =
	| { language: string; requiresGlobalRefresh: boolean }
	| { language: string; error: unknown };
type HighlightLanguageLoadListener = (event: HighlightLanguageLoadEvent) => void;

interface LanguageLoadState {
	definition?: LanguageDefinition;
	promise: Promise<LanguageDefinition>;
}

interface LanguageRequestState {
	promise: Promise<boolean>;
	callbacks: Set<() => void>;
	requiresGlobalRefresh: boolean;
	status: "pending" | "ready" | "failed";
}

interface LanguageRegistryState {
	loads: Map<string, LanguageLoadState>;
	listeners: Set<HighlightLanguageLoadListener>;
	requests?: Map<string, LanguageRequestState>;
}

// jiti can evaluate this module more than once. Sharing imported definitions
// and listeners lets extension-triggered loads refresh the host TUI.
const LANGUAGE_REGISTRY_KEY = Symbol.for("@earendil-works/pi-coding-agent:highlight-language-loaders-v3");
const globalRegistry = globalThis as Record<symbol, LanguageRegistryState | undefined>;
const languageRegistry: LanguageRegistryState = globalRegistry[LANGUAGE_REGISTRY_KEY] ?? {
	loads: new Map(),
	listeners: new Set(),
};
globalRegistry[LANGUAGE_REGISTRY_KEY] = languageRegistry;
if (!languageRegistry.requests) languageRegistry.requests = new Map();
const languageRequests = languageRegistry.requests;

function notifyLanguageLoad(event: HighlightLanguageLoadEvent): void {
	if (languageRegistry.listeners.size > 0) {
		for (const listener of languageRegistry.listeners) listener(event);
	} else if ("error" in event) {
		const message = event.error instanceof Error ? event.error.message : String(event.error);
		console.error(`Failed to load syntax highlighting language "${event.language}": ${message}`);
	}
}

function getLanguageClosure(language: HighlightLanguage): HighlightLanguage[] {
	const result: HighlightLanguage[] = [];
	const visited = new Set<string>();
	const visit = (current: HighlightLanguage) => {
		if (visited.has(current.name)) return;
		visited.add(current.name);
		for (const dependencyName of current.dependencies ?? []) {
			const dependency = LANGUAGE_BY_NAME.get(dependencyName);
			if (dependency) visit(dependency);
		}
		result.push(current);
	};
	visit(language);
	return result;
}

function ensureLanguagesRegistered(languages: HighlightLanguage[], requestedName: string): boolean {
	for (const language of languages) {
		const definition = language.definition ?? languageRegistry.loads.get(language.name)?.definition;
		if (definition) registerLanguage(language, definition);
	}
	return (
		languages.every(
			(language) =>
				registeredLanguages.has(language.name) ||
				(!language.definition && !language.load && supportsLanguage(language.name)),
		) && supportsLanguage(requestedName)
	);
}

function loadLanguageDefinition(language: HighlightLanguage): Promise<LanguageDefinition> | undefined {
	if (language.definition) return Promise.resolve(language.definition);
	if (!language.load) return undefined;

	let state = languageRegistry.loads.get(language.name);
	if (!state) {
		const promise = Promise.resolve()
			.then(language.load)
			.then(
				({ default: definition }) => {
					const currentState = languageRegistry.loads.get(language.name);
					if (currentState) currentState.definition = definition;
					return definition;
				},
				(error: unknown) => {
					notifyLanguageLoad({ language: language.name, error });
					throw error;
				},
			);
		state = { promise };
		languageRegistry.loads.set(language.name, state);
	}
	return state.promise;
}

function getLanguageRequest(language: HighlightLanguage, languages: HighlightLanguage[]): LanguageRequestState {
	let request = languageRequests.get(language.name);
	if (request) return request;

	const callbacks = new Set<() => void>();
	const promises: Promise<LanguageDefinition>[] = [];
	for (const current of languages) {
		const promise = loadLanguageDefinition(current);
		if (promise) promises.push(promise);
	}
	const promise = Promise.all(promises).then(() => ensureLanguagesRegistered(languages, language.name));
	request = { promise, callbacks, requiresGlobalRefresh: false, status: "pending" };
	languageRequests.set(language.name, request);
	void promise.then(
		(ready) => {
			request.status = ready ? "ready" : "failed";
			if (ready) {
				for (const callback of callbacks) callback();
				notifyLanguageLoad({ language: language.name, requiresGlobalRefresh: request.requiresGlobalRefresh });
			}
			callbacks.clear();
		},
		() => {
			request.status = "failed";
			callbacks.clear();
		},
	);
	return request;
}

export function onHighlightLanguageLoad(listener: HighlightLanguageLoadListener): () => void {
	languageRegistry.listeners.add(listener);
	return () => languageRegistry.listeners.delete(listener);
}

export async function loadHighlightLanguage(name: string): Promise<boolean> {
	const normalizedName = name.toLowerCase();
	const language = LANGUAGE_BY_NAME.get(normalizedName);
	if (!language) return supportsLanguage(normalizedName);

	const languages = getLanguageClosure(language);
	if (ensureLanguagesRegistered(languages, language.name)) return true;
	const request = getLanguageRequest(language, languages);
	request.requiresGlobalRefresh = true;
	return request.promise;
}

/** Return the canonical grammar when ready, starting a background load when needed. */
export function requestHighlightLanguage(name: string, onReady?: () => void): string | undefined {
	const normalizedName = name.toLowerCase();
	const language = LANGUAGE_BY_NAME.get(normalizedName);
	if (!language) return supportsLanguage(normalizedName) ? normalizedName : undefined;

	const languages = getLanguageClosure(language);
	if (ensureLanguagesRegistered(languages, language.name)) return language.name;
	if (!languages.some((current) => current.load)) return undefined;

	const request = getLanguageRequest(language, languages);
	if (request.status === "pending") {
		if (onReady) request.callbacks.add(onReady);
		else request.requiresGlobalRefresh = true;
	}
	return undefined;
}

export function getLanguageFromPath(filePath: string): string | undefined {
	const extension = filePath.split(".").pop()?.toLowerCase();
	return extension ? LANGUAGE_BY_EXTENSION.get(extension) : undefined;
}

const SPAN_CLOSE = "</span>";
const HIGHLIGHT_CLASS_PREFIX = "hljs-";

function getScopeFromSpanTag(tag: string): string | undefined {
	const match = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
	const classValue = match?.[1] ?? match?.[2];
	if (!classValue) {
		return undefined;
	}

	for (const className of classValue.split(/\s+/)) {
		if (className.startsWith(HIGHLIGHT_CLASS_PREFIX)) {
			return className.slice(HIGHLIGHT_CLASS_PREFIX.length);
		}
	}

	return undefined;
}

function getScopeFormatter(scope: string, theme: HighlightTheme): HighlightFormatter | undefined {
	const exact = theme[scope];
	if (exact) {
		return exact;
	}

	const dotIndex = scope.indexOf(".");
	if (dotIndex !== -1) {
		const prefixFormatter = theme[scope.slice(0, dotIndex)];
		if (prefixFormatter) {
			return prefixFormatter;
		}
	}

	const dashIndex = scope.indexOf("-");
	if (dashIndex !== -1) {
		const prefixFormatter = theme[scope.slice(0, dashIndex)];
		if (prefixFormatter) {
			return prefixFormatter;
		}
	}

	return undefined;
}

function getActiveFormatter(scopes: Array<string | undefined>, theme: HighlightTheme): HighlightFormatter | undefined {
	for (let i = scopes.length - 1; i >= 0; i--) {
		const scope = scopes[i];
		if (!scope) {
			continue;
		}
		const formatter = getScopeFormatter(scope, theme);
		if (formatter) {
			return formatter;
		}
	}
	return theme.default;
}

function isSpanOpenTagStart(html: string, index: number): boolean {
	if (!html.startsWith("<span", index)) {
		return false;
	}
	const nextChar = html[index + "<span".length];
	return nextChar === ">" || nextChar === " " || nextChar === "\t" || nextChar === "\n" || nextChar === "\r";
}

export function renderHighlightedHtml(html: string, theme: HighlightTheme = {}): string {
	let output = "";
	let textBuffer = "";
	const scopes: Array<string | undefined> = [];

	const flushText = () => {
		if (!textBuffer) {
			return;
		}
		const formatter = getActiveFormatter(scopes, theme);
		output += formatter ? formatter(textBuffer) : textBuffer;
		textBuffer = "";
	};

	let index = 0;
	while (index < html.length) {
		if (isSpanOpenTagStart(html, index)) {
			const tagEndIndex = html.indexOf(">", index + 5);
			if (tagEndIndex !== -1) {
				flushText();
				const tag = html.slice(index, tagEndIndex + 1);
				const scope = getScopeFromSpanTag(tag);
				scopes.push(scope);
				index = tagEndIndex + 1;
				continue;
			}
		}

		if (html.startsWith(SPAN_CLOSE, index)) {
			flushText();
			if (scopes.length > 0) {
				scopes.pop();
			}
			index += SPAN_CLOSE.length;
			continue;
		}

		if (html[index] === "&") {
			const decoded = decodeHtmlEntityAt(html, index);
			if (decoded) {
				textBuffer += decoded.text;
				index += decoded.length;
				continue;
			}
		}

		textBuffer += html[index];
		index++;
	}

	flushText();
	return output;
}

export function highlight(code: string, options: HighlightOptions = {}): string {
	const html = options.language
		? hljs.highlight(code, {
				language: options.language,
				ignoreIllegals: options.ignoreIllegals,
			}).value
		: hljs.highlightAuto(code, options.languageSubset).value;
	return renderHighlightedHtml(html, options.theme);
}

export function supportsLanguage(name: string): boolean {
	return hljs.getLanguage(name.toLowerCase()) !== undefined;
}
