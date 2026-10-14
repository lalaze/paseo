/**
 * Provider failures that can change the executor. Kept in the collaboration
 * module so unrelated provider adapters stay unchanged.
 */
const LASTING_PROVIDER_ERROR =
  /quota|usage limit|RESOURCE_EXHAUSTED|\b429\b|rate.?limit|billing|credit|insufficient|unauthori[sz]ed|\b40[13]\b|forbidden|api key|invalid.?(request|argument)/i;
const TRANSIENT_PROVIDER_ERROR =
  /\bEOF\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network|connection (reset|closed|lost|error)|stream (closed|disconnected|ended)|\b50[0234]\b|internal server error|bad gateway|service unavailable|gateway timeout|overloaded|temporarily unavailable/i;

export function isTransientProviderError(message: string) {
  return !LASTING_PROVIDER_ERROR.test(message) && TRANSIENT_PROVIDER_ERROR.test(message);
}

export type ProviderFailureClass =
  | "quota"
  | "auth"
  | "billing"
  | "invalid"
  | "rate_limit"
  | "network"
  | "tool"
  | "assistant"
  | "uncertain";

export interface ClassifiedProviderFailure {
  class: ProviderFailureClass;
  /** Explicit quota on an execution turn may switch models. Nothing else may. */
  handoff: boolean;
}

const AUTH =
  /unauthori[sz]ed|unauthenticated|invalid[_ ]api[_ ]?key|invalid_api_key|\b401\b|\b403\b|forbidden|api[_ ]?key|authentication (failed|required)|not authenticated|permission denied|invalid_grant/i;
const BILLING =
  /insufficient[_ ]quota|billing(?!\s+cycle)|insufficient (credit|balance|funds)|payment required|\b402\b|out of credit|余额不足|欠费|账单/i;
const INVALID =
  /invalid[_ ]request|invalid[_ ]argument|invalid_argument|\b400\b|malformed request/i;
const QUOTA =
  /usage limit|quota (has been )?(reached|exceeded|exhausted)|exceeded your (current )?quota|out of quota|individual quota (reached|exceeded|exhausted)/i;
const QUOTA_WITH_EXHAUSTED =
  /(quota|usage limit)[\s\S]{0,200}RESOURCE_EXHAUSTED|RESOURCE_EXHAUSTED[\s\S]{0,200}(quota|usage limit)/i;
const RATE = /\b429\b|rate[_ ]?limit|too many requests|RESOURCE_EXHAUSTED/i;
const TOOL = /tool[_ ](call|error)|工具(调用)?(失败|错误)/i;

const TERMINAL_ENVELOPE =
  /(?:^|\n)((?:API error \(attempt \d+\):[^\n]*|\[System Error\] [^\n]*)(?:\n+code:[ \t]*\S+)?)[ \t\n]*$/;

function insideCodeFence(text: string): boolean {
  let fence: string | undefined;
  for (const line of text.split("\n")) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!marker) continue;
    if (!fence) {
      fence = marker[1];
      continue;
    }
    const closes =
      marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim();
    if (closes) fence = undefined;
  }
  return fence !== undefined;
}

/** Only an unquoted terminal envelope can stand in for a provider failure event. */
export function isProviderTerminalOutput(text: string): boolean {
  return terminalProviderEnvelope(text) !== undefined;
}

/** Progress may precede the envelope; fenced examples and following prose are not evidence. */
export function terminalProviderEnvelope(text: string): string | undefined {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = normalized.match(TERMINAL_ENVELOPE);
  if (!match || insideCodeFence(normalized.slice(0, match.index))) return undefined;
  return match[1];
}

/** A `code:` line counts only when it belongs to the terminal envelope. */
export function providerFailureCode(output: string): string | undefined {
  return terminalProviderEnvelope(output)?.match(/(?:^|\n)code:\s*(\S+)/)?.[1];
}

/**
 * Provider message, code, and diagnostic only. Assistant and tool text stay out
 * so a progress note cannot create or hide a quota failure.
 */
export function providerFailureEvidence(state: {
  status: string;
  error?: string;
  output: string;
  failure?: { code?: string; diagnostic?: string };
}): { message: string; code?: string; diagnostic?: string } | undefined {
  const message = [state.error, state.failure?.diagnostic]
    .filter((part) => part?.trim())
    .join("\n");
  if (state.status === "error" && (message.trim() || state.failure?.code)) {
    return { message, code: state.failure?.code, diagnostic: state.failure?.diagnostic };
  }
  const envelope = terminalProviderEnvelope(state.output);
  if (!envelope) return undefined;
  const code = providerFailureCode(state.output);
  return { message: envelope, ...(code ? { code } : {}) };
}

export function classifyProviderFailure(input: {
  message?: string;
  code?: string;
  diagnostic?: string;
  source?: "provider" | "assistant" | "tool";
}): ClassifiedProviderFailure {
  if (input.source === "tool") return { class: "tool", handoff: false };
  if (input.source === "assistant") return { class: "assistant", handoff: false };
  const text = [input.message, input.code, input.diagnostic].filter(Boolean).join("\n");
  if (!text.trim()) return { class: "uncertain", handoff: false };
  if (AUTH.test(text)) return { class: "auth", handoff: false };
  if (BILLING.test(text)) return { class: "billing", handoff: false };
  if (INVALID.test(text)) return { class: "invalid", handoff: false };
  if (QUOTA.test(text) || QUOTA_WITH_EXHAUSTED.test(text)) return { class: "quota", handoff: true };
  if (RATE.test(text)) return { class: "rate_limit", handoff: false };
  if (isTransientProviderError(text)) return { class: "network", handoff: false };
  if (TOOL.test(text)) return { class: "tool", handoff: false };
  return { class: "uncertain", handoff: false };
}
