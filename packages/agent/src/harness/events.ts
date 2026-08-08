export interface RunStartEvent {
	type: "run_start";
	lane: string;
	runId: string;
}

export interface RunEndEvent {
	type: "run_end";
	lane: string;
	runId: string;
	outcome: "completed" | "aborted" | "failed";
	leafId: string;
}

/** Reports a passive event listener failure without affecting harness execution. */
export interface HandlerErrorEvent {
	type: "handler_error";
	kind: "event";
	event: string;
	error: string;
	stack?: string;
}

export type HarnessEvent = RunStartEvent | RunEndEvent | HandlerErrorEvent;
export type HarnessEventType = HarnessEvent["type"];
export type HarnessEventOfType<TType extends HarnessEventType> = Extract<HarnessEvent, { type: TType }>;
export type HarnessEventListener<TEvent extends HarnessEvent = HarnessEvent> = (event: TEvent) => void | Promise<void>;

export interface Events {
	/**
	 * Register a passive listener for future events and return its unsubscribe function.
	 * Earlier events are not replayed and no current-state snapshot is provided; use a lane or session watch for both.
	 */
	on<TType extends HarnessEventType>(
		type: TType,
		listener: HarnessEventListener<HarnessEventOfType<TType>>,
	): () => void;
}

export interface WatchHandle<TSnapshot> {
	snapshot: TSnapshot;
	start(listener: HarnessEventListener): void;
	unsubscribe(): void;
}

export class HarnessEventBus implements Events {
	private readonly listeners = new Map<HarnessEventType, Set<HarnessEventListener>>();
	private readonly watchListeners = new Set<(event: HarnessEvent) => void>();

	/** Invoke one passive listener without allowing synchronous throws or asynchronous rejections to escape. */
	private deliver(listener: HarnessEventListener, event: HarnessEvent): void {
		try {
			// Invoke the registered callback; it may return a promise.
			const result = listener(event);
			if (result) void result.catch((error: unknown) => this.reportListenerError(event, error));
		} catch (error) {
			this.reportListenerError(event, error);
		}
	}

	/** Emit handler_error for listener failures, except failures while handling handler_error itself. */
	private reportListenerError(event: HarnessEvent, error: unknown): void {
		if (event.type === "handler_error") return;
		const handlerError: HandlerErrorEvent = {
			type: "handler_error",
			kind: "event",
			event: event.type,
			error: error instanceof Error ? error.message : String(error),
			...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
		};
		this.emit(handlerError);
	}

	/**
	 * Register a listener for future events of one type and return its unsubscribe function.
	 * Earlier events are not replayed, and no snapshot or event buffer is provided.
	 */
	on<TType extends HarnessEventType>(
		type: TType,
		listener: HarnessEventListener<HarnessEventOfType<TType>>,
	): () => void {
		// Reuse this event type's listener set, or create its first set.
		const listeners = this.listeners.get(type) ?? new Set<HarnessEventListener>();
		this.listeners.set(type, listeners);

		// Wrap this event-specific callback so it can be stored as a general HarnessEvent listener.
		// Keep the wrapper reference so unsubscribe can remove that exact function from the set.
		const receive: HarnessEventListener = (event) => {
			if (event.type === type) return listener(event as HarnessEventOfType<TType>);
		};
		listeners.add(receive);
		return () => {
			listeners.delete(receive);
			if (listeners.size === 0) this.listeners.delete(type);
		};
	}

	/** Publish an event to current event subscriptions and watch subscriptions. */
	emit(event: HarnessEvent): void {
		// Deliver only to direct listeners registered for this event type.
		// Async results are not awaited because emit() is synchronous.
		for (const listener of this.listeners.get(event.type) ?? []) this.deliver(listener, event);

		// Deliver every event to each watcher; watch() handles buffering until start().
		for (const listener of this.watchListeners) listener(event);
	}

	watch<TSnapshot>(captureSnapshot: () => TSnapshot): WatchHandle<TSnapshot> {
		let listener: HarnessEventListener | undefined;
		let buffered: HarnessEvent[] = [];
		let started = false;
		const receive = (event: HarnessEvent): void => {
			if (listener) this.deliver(listener, event);
			else buffered.push(event);
		};
		this.watchListeners.add(receive);
		const snapshot = captureSnapshot();

		return {
			snapshot,
			start: (nextListener) => {
				// A second start() would otherwise silently replace the active listener.
				if (started) throw new Error("Watch has already started");
				// Mark the handle started before flushing so a reentrant start() also fails.
				started = true;
				// Stay in buffering mode while flushing so reentrant emissions preserve order.
				while (buffered.length > 0) {
					const pending = buffered;
					buffered = [];
					for (const event of pending) this.deliver(nextListener, event);
				}
				listener = nextListener;
			},
			unsubscribe: () => {
				this.watchListeners.delete(receive);
				buffered = [];
			},
		};
	}
}
