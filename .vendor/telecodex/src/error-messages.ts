/**
 * Translate raw errors into user-friendly Telegram messages.
 * Raw details are preserved for console logging only.
 */

export interface FriendlyError {
  userMessage: string;
  logMessage: string;
}

const ERROR_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /Telegram file download failed/i,
    message: "Cannot download the file from Telegram. Check the Telegram API route or proxy.",
  },
  {
    pattern: /ECONNREFUSED|ENOTFOUND|ENETUNREACH|fetch failed/i,
    message: "Cannot reach the Codex API. Check your network connection.",
  },
  {
    pattern: /429|rate.?limit|too many requests/i,
    message: "Rate limited by the API. Wait a moment and try again.",
  },
  {
    pattern: /401|unauthorized|authentication|invalid.*api.?key/i,
    message: "Authentication failed. Check the computer's Codex login or API key.",
  },
  {
    pattern: /403|forbidden|permission/i,
    message: "Access denied. Check your API key permissions.",
  },
  {
    pattern: /model requires a newer version of Codex/i,
    message: "This model requires a newer Codex version. Update the bot's Codex, or select another model with /model, then start a /new thread and resend your message.",
  },
  {
    pattern: /404.*model|model.*not.*found|invalid.*model|model.*does not exist/i,
    message: "Model not available. Select another model with /model, then start a /new thread and resend your message.",
  },
  {
    pattern: /timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i,
    message: "Request timed out. Try a shorter prompt or resend the message.",
  },
  {
    pattern: /500|internal.?server.?error/i,
    message: "The API returned a server error. Try again in a moment.",
  },
  {
    pattern: /502|503|504|bad.?gateway|service.?unavailable/i,
    message: "The API is temporarily unavailable. Try again shortly.",
  },
  {
    pattern: /context.?length|token.?limit|too.?long/i,
    message: "The conversation is too long for this model. Start a /new thread.",
  },
  {
    pattern: /^(?:AbortError|The operation was aborted)/i,
    message: "⏹ Aborted",
  },
];

export function translateError(error: unknown): FriendlyError {
  const raw = extractRawMessage(error);
  const logMessage = raw;

  for (const { pattern, message } of ERROR_PATTERNS) {
    if (pattern.test(raw)) {
      return { userMessage: message, logMessage };
    }
  }

  const cleaned = stripStackTrace(raw);
  return { userMessage: cleaned, logMessage };
}

export function friendlyErrorText(error: unknown): string {
  return translateError(error).userMessage;
}

function extractRawMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: Error }).cause;
    const base = error.message || String(error);
    return cause?.message ? `${base}: ${cause.message}` : base;
  }

  return String(error);
}

function stripStackTrace(message: string): string {
  // Remove stack frame lines (lines starting with "at ")
  const lines = message.split("\n").filter((line) => !line.trim().startsWith("at "));
  return lines.join("\n").trim() || message.trim();
}
