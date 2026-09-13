import {
  DesktopAppToolsClient,
  type DesktopRelayCommandRequest,
  type DesktopRelayCommandResult,
} from "./desktop-relay.js";

const encoded = process.argv[2];
if (!encoded) {
  emit({ ok: false, error: "Desktop relay helper requires an encoded request" });
  process.exit(64);
}

let request: DesktopRelayCommandRequest;
try {
  request = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as DesktopRelayCommandRequest;
} catch {
  emit({ ok: false, error: "Desktop relay helper received malformed input" });
  process.exit(64);
}

const client = new DesktopAppToolsClient(
  request.descriptor.pipePath,
  request.descriptor.callerThreadId,
  {
    nodePath: request.descriptor.nodePath,
    serverPath: request.descriptor.serverPath,
  },
);

try {
  let result: unknown;
  switch (request.operation) {
    case "probe":
      await client.probe();
      break;
    case "snapshot":
      result = await client.snapshot(request.threadId, request.afterCursor);
      break;
    case "sendMessage":
      result = await client.sendMessage(request.threadId, request.prompt);
      break;
    case "readLatestTurn":
      result = await client.readLatestTurn(request.threadId);
      break;
  }
  emit({ ok: true, ...(result === undefined ? {} : { result }) });
} catch (error) {
  emit({ ok: false, error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  client.close();
}

function emit(result: DesktopRelayCommandResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
