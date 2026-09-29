import { describe, expect, it } from "vitest";
import {
  applyAgentMentionReplacement,
  filterMentionableAgents,
  formatAgentMention,
  splitAgentMentions,
} from "./agent-mention";

const agents = [
  { provider: "claude", label: "Claude Code" },
  { provider: "codex", label: "Codex" },
];

describe("agent mentions", () => {
  it("replaces the typed @query with a mention link", () => {
    expect(
      applyAgentMentionReplacement({
        text: "ask @cod to review",
        mention: { start: 4, end: 8, query: "cod" },
        agent: agents[1]!,
      }),
    ).toBe("ask [@Codex](paseo://agent/codex) to review");
  });

  it("filters by provider id or label ignoring spaces", () => {
    expect(filterMentionableAgents(agents, "claudec").map((a) => a.provider)).toEqual(["claude"]);
    expect(filterMentionableAgents(agents, "CO").map((a) => a.provider)).toEqual([
      "claude",
      "codex",
    ]);
    expect(filterMentionableAgents(agents, "")).toHaveLength(2);
  });

  it("round-trips labels with brackets through the display split", () => {
    const text = `Hi ${formatAgentMention({ provider: "acp:x", label: "A]B" })}!`;
    expect(splitAgentMentions(text)).toEqual([
      { kind: "text", text: "Hi " },
      { kind: "agent", label: "A]B", provider: "acp:x", start: 3 },
      { kind: "text", text: "!" },
    ]);
  });

  it("leaves ordinary links and file mentions as text", () => {
    const text = 'see [docs](https://paseo.sh) and @"src/a.ts"';
    expect(splitAgentMentions(text)).toEqual([{ kind: "text", text }]);
  });
});
