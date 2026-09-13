import type { CoreStateStore } from "./state-store.js";

export class DurableTurnJournal {
  private readonly active = new Map<string, Promise<void>>();

  constructor(private readonly store: CoreStateStore) {}

  async run(
    requestKey: string,
    metadata: { botKey: string; contextKey: string; threadId?: string },
    emit: (event: string, payload?: unknown) => void,
    execute: (emitDurable: (event: string, payload?: unknown) => void) => Promise<void>,
  ): Promise<void> {
    const existing = this.store.getTurnRequest(requestKey);
    if (existing?.state === "completed") {
      this.replay(requestKey, emit);
      return;
    }
    if (existing?.state === "failed") {
      this.replay(requestKey, emit);
      throw new Error(existing.error ?? "The durable Core turn failed");
    }

    const running = this.active.get(requestKey);
    if (running) {
      await running.catch(() => {});
      const terminal = this.store.getTurnRequest(requestKey);
      this.replay(requestKey, emit);
      if (terminal?.state === "failed") throw new Error(terminal.error ?? "The durable Core turn failed");
      return;
    }

    if (existing?.state === "running") {
      throw new Error(
        "This Telegram update reached Core before a restart, but its live turn can no longer be observed; use /past to recover the completed Desktop output",
      );
    }

    this.store.beginTurnRequest(
      requestKey,
      metadata.botKey,
      metadata.contextKey,
      metadata.threadId,
    );
    const promise = execute((event, payload) => {
      this.store.appendTurnEvent(requestKey, event, payload);
      emit(event, payload);
    }).then(
      () => this.store.finishTurnRequest(requestKey),
      (error) => {
        this.store.failTurnRequest(requestKey, error);
        throw error;
      },
    );
    this.active.set(requestKey, promise);
    try {
      await promise;
    } finally {
      if (this.active.get(requestKey) === promise) this.active.delete(requestKey);
    }
  }

  private replay(requestKey: string, emit: (event: string, payload?: unknown) => void): void {
    for (const event of this.store.listTurnEvents(requestKey)) emit(event.event, event.payload);
  }
}
