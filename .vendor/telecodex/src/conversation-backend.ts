export type ConversationPromptProvenance = {
  transport: "telegram";
  botKey?: string;
  senderTrust: "allowed-user-id";
  senderUserId?: number;
  chatId: string;
  messageId?: number;
  messageThreadId?: number;
  messageKind: "text" | "photo" | "document";
  forwarded: boolean;
};

export type ConversationPromptInput =
  | string
  | {
      text?: string;
      imagePaths?: string[];
      stagedFileInstructions?: string;
      skill?: { name: string; path: string };
      provenance?: ConversationPromptProvenance;
    };

export type ConversationThreadPhase = "cold" | "idle" | "active";

export interface ConversationThreadState {
  threadId: string | null;
  phase: ConversationThreadPhase;
  activeTurnId?: string;
  steerable: boolean;
}

export type AcceptedConversationInput =
  | { kind: "started"; threadId: string; turnId: string }
  | { kind: "steered"; threadId: string; turnId: string }
  | { kind: "queued"; threadId: string; afterTurnId: string };

export type ConversationItem = Record<string, unknown> & { type?: string; id?: string };

export type ConversationEvent =
  | { type: "turnStarted"; threadId: string; turnId: string }
  | { type: "agentMessageDelta"; threadId: string; turnId: string; itemId: string; delta: string }
  | { type: "itemStarted"; threadId: string; turnId: string; item: ConversationItem }
  | { type: "itemCompleted"; threadId: string; turnId: string; item: ConversationItem }
  | {
      type: "turnCompleted";
      threadId: string;
      turnId: string;
      status: "completed" | "interrupted" | "failed" | string;
      error?: string;
      lastItemId?: string;
    }
  | { type: "threadClosed"; threadId: string };

export interface ConversationBackend {
  getState(): ConversationThreadState;
  bindThread(threadId: string): ConversationThreadState;
  newThread(): Promise<ConversationThreadState>;
  attach(threadId: string): Promise<ConversationThreadState>;
  submit(input: ConversationPromptInput): Promise<AcceptedConversationInput>;
  subscribe(handler: (event: ConversationEvent) => void): () => void;
  waitForTurn(turnId: string): Promise<void>;
  interrupt(turnId: string): Promise<void>;
  compact(): Promise<void>;
  readThread(includeTurns?: boolean): Promise<unknown>;
  release(): Promise<boolean>;
  handback(): Promise<{ threadId: string | null; workspace: string }>;
  dispose(): void;
}
