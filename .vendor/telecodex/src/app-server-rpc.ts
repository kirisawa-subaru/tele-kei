import { createConnection, type Socket } from "node:net";
import WebSocket, { type RawData } from "ws";

export type AppServerRequestId = number | string;

export interface AppServerNotification {
  method: string;
  params?: unknown;
}

export interface AppServerServerRequest {
  id: AppServerRequestId;
  method: string;
  params?: unknown;
}

export interface AppServerRpcClientOptions {
  clientName?: string;
  clientTitle?: string;
  clientVersion?: string;
  experimentalApi?: boolean;
  requestTimeoutMs?: number;
  /** Test-only JSONL socket transport. Production Unix listeners use WebSocket framing. */
  rawUnixJsonl?: boolean;
  onServerRequest?: (request: AppServerServerRequest) => Promise<unknown>;
}

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type NotificationListener = (notification: AppServerNotification) => void;

export interface AppServerRpc {
  connect(): Promise<void>;
  isConnected(): boolean;
  onNotification(listener: NotificationListener): () => void;
  request<TResult>(method: string, params?: unknown): Promise<TResult>;
  notify(method: string, params?: unknown): void;
}

type RpcResponse = {
  id: AppServerRequestId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type WireMessage = RpcResponse | AppServerNotification | AppServerServerRequest;

export class AppServerRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AppServerRpcError";
  }
}

export class AppServerRpcClient implements AppServerRpc {
  private socket: Socket | null = null;
  private websocket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private buffer = "";
  private nextRequestId = 1;
  private readonly pending = new Map<AppServerRequestId, PendingRequest>();
  private readonly notificationListeners = new Set<NotificationListener>();
  private closed = false;

  constructor(
    readonly socketPath: string,
    private readonly options: AppServerRpcClientOptions = {},
  ) {}

  async connect(): Promise<void> {
    if (this.isConnected()) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.closed = false;
    this.connectPromise = this.connectAndInitialize();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  isConnected(): boolean {
    return Boolean(
      this.websocket?.readyState === WebSocket.OPEN ||
      (this.socket && !this.socket.destroyed && this.socket.writable),
    );
  }

  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  async request<TResult>(method: string, params?: unknown): Promise<TResult> {
    if (!this.isConnected()) {
      throw new Error("Codex app-server is not connected");
    }

    const id = this.nextRequestId++;
    const timeoutMs = this.options.requestTimeoutMs ?? 30_000;
    const result = new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();

      this.pending.set(id, {
        resolve: (value) => resolve(value as TResult),
        reject,
        timer,
      });
    });

    try {
      this.writeMessage({ id, method, ...(params === undefined ? {} : { params }) });
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
      }
      throw error;
    }

    return result;
  }

  notify(method: string, params?: unknown): void {
    if (!this.isConnected()) {
      throw new Error("Codex app-server is not connected");
    }
    this.writeMessage({ method, ...(params === undefined ? {} : { params }) });
  }

  close(): void {
    this.closed = true;
    const socket = this.socket;
    this.socket = null;
    const websocket = this.websocket;
    this.websocket = null;
    if (socket && !socket.destroyed) {
      socket.destroy();
    }
    websocket?.terminate();
    this.rejectPending(new Error("Codex app-server connection closed"));
  }

  private async connectAndInitialize(): Promise<void> {
    if (this.options.rawUnixJsonl) {
      await this.connectRawJsonlSocket();
    } else {
      await this.connectWebSocket();
    }
    await this.initialize();
  }

  private async connectRawJsonlSocket(): Promise<void> {
    const socket = createConnection({ path: this.socketPath });
    this.socket = socket;
    this.buffer = "";

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.handleData(chunk));
    socket.on("error", (error) => this.handleSocketFailure(socket, error));
    socket.on("close", () => this.handleSocketFailure(socket, new Error("Codex app-server disconnected")));

    await new Promise<void>((resolve, reject) => {
      const onConnect = (): void => {
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const cleanup = (): void => {
        socket.off("connect", onConnect);
        socket.off("error", onError);
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });

  }

  private async connectWebSocket(): Promise<void> {
    const websocket = new WebSocket("ws://localhost/", {
      perMessageDeflate: false,
      createConnection: () => createConnection({ path: this.socketPath }),
    });
    this.websocket = websocket;
    websocket.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        this.handleProtocolFailure(new Error("Unexpected binary frame from Codex app-server"));
        return;
      }
      this.handleFrame(data.toString());
    });
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const cleanup = (): void => {
        websocket.off("open", onOpen);
        websocket.off("error", onError);
      };
      websocket.once("open", onOpen);
      websocket.once("error", onError);
    });
    websocket.on("error", (error) => this.handleWebSocketFailure(websocket, error));
    websocket.on("close", (code, reason) =>
      this.handleWebSocketFailure(
        websocket,
        new Error(`Codex app-server WebSocket closed (${code})${reason.length ? `: ${reason.toString()}` : ""}`),
      ),
    );
  }

  private async initialize(): Promise<void> {
    try {
      await this.request("initialize", {
        clientInfo: {
          name: this.options.clientName ?? "telecodex_app_server",
          title: this.options.clientTitle ?? "TeleCodex App Server Bridge",
          version: this.options.clientVersion ?? "0.1.0",
        },
        capabilities: {
          experimentalApi: this.options.experimentalApi ?? false,
          requestAttestation: false,
        },
      });
      this.notify("initialized");
    } catch (error) {
      this.closeTransport();
      throw error;
    }
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line.trim()) {
        continue;
      }

      let message: WireMessage;
      try {
        message = JSON.parse(line) as WireMessage;
      } catch (error) {
        this.handleProtocolFailure(
          new Error(`Invalid JSON from Codex app-server: ${error instanceof Error ? error.message : String(error)}`),
        );
        return;
      }
      this.handleMessage(message);
    }
  }

  private handleFrame(frame: string): void {
    let message: WireMessage;
    try {
      message = JSON.parse(frame) as WireMessage;
    } catch (error) {
      this.handleProtocolFailure(
        new Error(`Invalid JSON frame from Codex app-server: ${error instanceof Error ? error.message : String(error)}`),
      );
      return;
    }
    this.handleMessage(message);
  }

  private handleMessage(message: WireMessage): void {
    if ("id" in message && "method" in message) {
      void this.handleServerRequest(message);
      return;
    }

    if ("id" in message) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(new AppServerRpcError(message.error.message, message.error.code, message.error.data));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if ("method" in message) {
      for (const listener of this.notificationListeners) {
        try {
          listener(message);
        } catch (error) {
          console.error("Codex app-server notification listener failed:", error);
        }
      }
    }
  }

  private async handleServerRequest(request: AppServerServerRequest): Promise<void> {
    try {
      if (!this.options.onServerRequest) {
        this.writeMessage({
          id: request.id,
          error: { code: -32601, message: `Unsupported app-server request: ${request.method}` },
        });
        return;
      }
      const result = await this.options.onServerRequest(request);
      this.writeMessage({ id: request.id, result });
    } catch (error) {
      this.writeMessage({
        id: request.id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private writeMessage(message: object): void {
    if (this.websocket?.readyState === WebSocket.OPEN) {
      this.websocket.send(JSON.stringify(message));
      return;
    }
    const socket = this.socket;
    if (socket && !socket.destroyed && socket.writable) {
      socket.write(`${JSON.stringify(message)}\n`);
      return;
    }
    throw new Error("Codex app-server transport is not writable");
  }

  private handleSocketFailure(socket: Socket, error: Error): void {
    if (this.socket !== socket) {
      return;
    }
    this.socket = null;
    if (!this.closed) {
      this.rejectPending(error);
    }
  }

  private handleWebSocketFailure(websocket: WebSocket, error: Error): void {
    if (this.websocket !== websocket) return;
    this.websocket = null;
    if (!this.closed) this.rejectPending(error);
  }

  private handleProtocolFailure(error: Error): void {
    this.closeTransport();
    this.rejectPending(error);
  }

  private closeTransport(): void {
    const socket = this.socket;
    const websocket = this.websocket;
    this.socket = null;
    this.websocket = null;
    socket?.destroy();
    websocket?.terminate();
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
