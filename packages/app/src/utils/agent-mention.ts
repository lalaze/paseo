import type { FileMentionRange } from "@/utils/file-mention-autocomplete";

// Matches the daemon's delegate_to_agent convention: the link target names the provider.
export const AGENT_MENTION_URL_PREFIX = "paseo://agent/";

export interface MentionableAgent {
  provider: string;
  label: string;
}

export type AgentMentionSegment =
  | { kind: "text"; text: string }
  | { kind: "agent"; label: string; provider: string; start: number };

const AGENT_MENTION_PATTERN =
  /\[@((?:\\.|[^\]\\\r\n])+)\]\(paseo:\/\/agent\/([A-Za-z0-9][A-Za-z0-9._:-]*)\)/g;

function escapeLabel(label: string): string {
  return label.replace(/[\\\]]/g, (char) => `\\${char}`);
}

function unescapeLabel(label: string): string {
  return label.replace(/\\(.)/g, "$1");
}

export function formatAgentMention(agent: MentionableAgent): string {
  return `[@${escapeLabel(agent.label)}](${AGENT_MENTION_URL_PREFIX}${agent.provider})`;
}

export function applyAgentMentionReplacement(input: {
  text: string;
  mention: FileMentionRange;
  agent: MentionableAgent;
}): string {
  const before = input.text.slice(0, input.mention.start);
  const after = input.text.slice(input.mention.end);
  const separator = after.startsWith(" ") ? "" : " ";
  return `${before}${formatAgentMention(input.agent)}${separator}${after}`;
}

export function filterMentionableAgents(
  agents: readonly MentionableAgent[],
  query: string,
): MentionableAgent[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...agents];
  return agents.filter(
    (agent) =>
      agent.provider.toLowerCase().includes(normalized) ||
      agent.label.toLowerCase().replace(/\s+/g, "").includes(normalized),
  );
}

export function splitAgentMentions(text: string): AgentMentionSegment[] {
  const segments: AgentMentionSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(AGENT_MENTION_PATTERN)) {
    const start = match.index ?? 0;
    if (start > cursor) segments.push({ kind: "text", text: text.slice(cursor, start) });
    segments.push({
      kind: "agent",
      label: unescapeLabel(match[1] ?? ""),
      provider: match[2] ?? "",
      start,
    });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments;
}
