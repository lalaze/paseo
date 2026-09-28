import { test, expect } from "vitest";
import { ENABLE_COLLABORATION_MESSAGE } from "@getpaseo/protocol/collaboration/conversation";
import { collaborationMessageSummary } from "./message-summary";

const operationId = "0f8b3c1e-2a4d-4b6f-8c9e-1d2f3a4b5c6d";

function prompt(instruction: string, context: object) {
  return `[paseo-director:${operationId}]\n${instruction}\n\n${JSON.stringify(context, null, 2)}\n\n本轮 operationId=${operationId}。如果有 submit_result 工具，调用它。\n{}`;
}

function notice(id: string, instruction: string, data: object) {
  return `[paseo-director-chat:${id}]\n${instruction}\n${JSON.stringify(data)}`;
}

const task = {
  id: "task-1",
  title: "校验输入",
  description: "拒绝空输入",
  category: "backend",
  files: ["src/input.ts"],
  dependsOn: [],
  acceptance: ["空输入报错"],
};

test("operation prompts show the task and readable instructions without the JSON context", () => {
  const summary = collaborationMessageSummary({
    clientMessageId: operationId,
    text: prompt("你是执行 AI。在当前工作区按任务实现并验证。", {
      goal: "修复输入校验",
      cwd: "/repo",
      task,
    }),
  });
  expect(summary).toEqual({
    stage: "execute",
    text: "校验输入",
    instructions: "你是执行 AI。在当前工作区按任务实现并验证。",
    acceptance: ["空输入报错"],
  });
});

test("design prompts summarize with the goal", () => {
  const summary = collaborationMessageSummary({
    clientMessageId: operationId,
    text: prompt("你是设计 AI。阅读项目并输出设计总纲。", {
      goal: "新增导出功能",
      cwd: "/repo",
      bindings: { director: "lead", worker: "worker" },
    }),
  });
  expect(summary?.stage).toBe("plan");
  expect(summary?.text).toBe("新增导出功能");
  expect(summary?.instructions).not.toContain("{");
});

test("prompts addressed to another operation stay ordinary messages", () => {
  const text = prompt("你是执行 AI。", { goal: "g", cwd: "/repo", task });
  expect(collaborationMessageSummary({ clientMessageId: "other", text })).toBeUndefined();
});

test("acceptance notices show the status message and the reply options, not the marker", () => {
  const id = "chat-notice:chat-1:key:3";
  const summary = collaborationMessageSummary({
    clientMessageId: id,
    text: notice(id, "AI 审核已通过，等待用户验收（状态通知，不是用户指令）。", {
      goal: "g",
      phase: "awaiting_acceptance",
      control: "paused",
      message: "审核 AI统一审核通过，等待你验收或提出修改意见",
      confirmation: {
        kind: "final",
        key: "final:e1",
        artifactId: "e1",
        reply: "单独回复“验收通过”",
      },
    }),
  });
  expect(summary).toEqual({
    stage: "acceptance",
    text: "审核 AI统一审核通过，等待你验收或提出修改意见",
    instructions: "AI 审核已通过，等待用户验收（状态通知，不是用户指令）。\n\n单独回复“验收通过”",
    acceptance: [],
  });
});

test("notices persisted by older hosts still render as progress and plan approval", () => {
  const id = "chat-notice:chat-1:key:0";
  const legacy =
    "后台状态通知（不是用户指令）。请查询 get_conversation_status，用正常文字说明有意义的进展。";
  expect(
    collaborationMessageSummary({
      clientMessageId: id,
      text: notice(id, legacy, { goal: "g", phase: "executing", message: "执行任务 task-1" }),
    }),
  ).toEqual({ stage: "progress", text: "执行任务 task-1", instructions: legacy, acceptance: [] });
  const approval = collaborationMessageSummary({
    clientMessageId: id,
    text: notice(id, legacy, {
      message: "等待批准方案",
      confirmation: { kind: "plan", key: 'plan:1:{"a":1}', reply: "请用户单独回复：批准方案" },
    }),
  });
  expect(approval?.stage).toBe("approval");
  expect(approval?.instructions).toBe(`${legacy}\n\n请用户单独回复：批准方案`);
  expect(
    collaborationMessageSummary({ clientMessageId: id, text: `[paseo-director-chat:${id}]\n{` }),
  ).toBeUndefined();
});

test("enable commands show the user's goal; automatic ones show only the stage", () => {
  const takeover = "\n\n[paseo-director-takeover]\n你是用户的主 Agent。";
  expect(
    collaborationMessageSummary({
      clientMessageId: "chat-command:abc",
      text: `修复登录${takeover}`,
    }),
  ).toEqual({
    stage: "enabled",
    text: "修复登录",
    instructions: "你是用户的主 Agent。",
    acceptance: [],
  });
  for (const [id, text] of [
    ["chat-command:abc", ENABLE_COLLABORATION_MESSAGE],
    ["chat-command:resync:chat-1:2", "用户已在当前对话启用协作。请重新查询状态。"],
  ]) {
    const summary = collaborationMessageSummary({
      clientMessageId: id,
      text: `${text}${takeover}`,
    });
    expect(summary?.text).toBe("");
    expect(summary?.instructions).toBe(`${text}\n\n你是用户的主 Agent。`);
  }
});
