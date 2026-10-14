import { test } from "vitest";
import assert from "node:assert/strict";
import {
  classifyProviderFailure,
  isProviderTerminalOutput,
  isTransientProviderError,
  providerFailureCode,
  providerFailureEvidence,
} from "./provider-failure.js";

test("only explicit quota evidence can hand off", () => {
  for (const message of [
    "RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 1h.",
    "You have exceeded your current quota",
    "usage limit reached for this model",
    "quota exhausted",
    "RESOURCE_EXHAUSTED\nquota exceeded for the billing cycle",
  ]) {
    const failure = classifyProviderFailure({ message, source: "provider" });
    assert.equal(failure.class, "quota", message);
    assert.equal(failure.handoff, true, message);
  }
});

test("auth, billing, invalid requests, bare rate limits and tool text do not hand off", () => {
  const cases: Array<[string, string]> = [
    ["401 Unauthorized", "auth"],
    ["invalid api key", "auth"],
    ["insufficient_quota", "billing"],
    ["insufficient credit balance", "billing"],
    ["余额不足", "billing"],
    ["400 invalid request", "invalid"],
    ["429 Too Many Requests: rate limit exceeded", "rate_limit"],
    ["RESOURCE_EXHAUSTED", "rate_limit"],
    ["tool call failed: npm test exited 1", "tool"],
    ["something unexpected happened", "uncertain"],
  ];
  for (const [message, expected] of cases) {
    const failure = classifyProviderFailure({ message, source: "provider" });
    assert.equal(failure.class, expected, message);
    assert.equal(failure.handoff, false, message);
  }
  assert.equal(
    classifyProviderFailure({ message: "quota reached", source: "assistant" }).handoff,
    false,
  );
  assert.equal(classifyProviderFailure({ message: "quota reached", source: "tool" }).class, "tool");
});

test("network failures stay on the existing backoff path", () => {
  const message = 'request failed: Post "https://example.invalid": EOF';
  assert.equal(isTransientProviderError(message), true);
  assert.equal(classifyProviderFailure({ message, source: "provider" }).class, "network");
  assert.equal(isTransientProviderError("429 Too Many Requests"), false);
  assert.equal(isTransientProviderError("503 Service Unavailable: model overloaded"), true);
});

test("ordinary assistant text is not provider evidence and cannot hide quota", () => {
  const chatter = "Debug example: [System Error] quota reached while parsing api_key";
  assert.equal(isProviderTerminalOutput(chatter), false);
  assert.equal(providerFailureCode(`notes\ncode: 401\n${chatter}`), undefined);
  assert.equal(providerFailureEvidence({ status: "idle", output: chatter }), undefined);
  const quota = providerFailureEvidence({
    status: "error",
    error: "Individual quota reached",
    output: "updated the api_key parsing and returned 400 billing\ntool call failed",
  });
  assert.equal(classifyProviderFailure({ ...quota, source: "provider" }).class, "quota");
  const auth = providerFailureEvidence({
    status: "error",
    error: "401 Unauthorized",
    output: "Individual quota reached",
  });
  assert.equal(classifyProviderFailure({ ...auth, source: "provider" }).handoff, false);
  const envelope = "[System Error] Individual quota reached\n\ncode: RESOURCE_EXHAUSTED";
  assert.equal(isProviderTerminalOutput(`progress\n${envelope}`), true);
  assert.equal(providerFailureCode(envelope), "RESOURCE_EXHAUSTED");
  assert.equal(
    classifyProviderFailure({
      ...providerFailureEvidence({ status: "idle", output: `api_key = 400\n${envelope}` }),
      source: "provider",
    }).class,
    "quota",
  );
});

test("quoted examples and nonterminal error lines are not provider failures", () => {
  const envelope = "[System Error] Individual quota reached\n\ncode: RESOURCE_EXHAUSTED";
  const examples = [
    `Example:\n\`\`\`text\n${envelope}\n\`\`\``,
    `Example:\n~~~text\nAPI error (attempt 1): quota exhausted\n~~~`,
    `Unfinished example:\n\`\`\`\n${envelope}`,
    `    ${envelope.replaceAll("\n", "\n    ")}`,
    `> ${envelope.replaceAll("\n", "\n> ")}`,
    `Example: \`API error (attempt 1): quota exhausted\``,
    `${envelope}\nThis is the error format we now handle.`,
    "API error (attempt 1): quota exhausted\nThe test passed with this fixture.",
  ];
  for (const output of examples) {
    assert.equal(isProviderTerminalOutput(output), false, output);
    assert.equal(providerFailureCode(output), undefined, output);
    assert.equal(providerFailureEvidence({ status: "idle", output }), undefined, output);
  }
  const actual = `Example:\n\`\`\`\n${envelope}\n\`\`\`\nprogress completed\n${envelope}\n`;
  assert.equal(isProviderTerminalOutput(actual), true);
  assert.equal(providerFailureCode(actual), "RESOURCE_EXHAUSTED");
});
