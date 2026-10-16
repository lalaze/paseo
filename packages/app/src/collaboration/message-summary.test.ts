import { test, expect } from "vitest";
import { ENABLE_COLLABORATION_MESSAGE } from "@getpaseo/protocol/collaboration/conversation";
import { collaborationMessageSummary } from "./message-summary";
import { collaborationPlanMarkdown } from "./plan-markdown";
import { collaborationPermissionPlan } from "./permission-plan";

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

const plan = {
  summary: "修复输入校验",
  architecture: "在接口边界校验，保留已有请求格式。",
  acceptance: ["空输入报错且有效请求正常处理"],
  tasks: [task, { ...task, id: "task-2", title: "验证接口", dependsOn: [task.id] }],
};

test.each(["snapshot", "persisted key"])(
  "plan approval exposes the full plan from its %s",
  (source) => {
    const id = "chat-notice:chat-1:plan:0";
    const summary = collaborationMessageSummary({
      clientMessageId: id,
      text: notice(id, "方案等待用户批准。", {
        message: "总纲已生成，等待查看并批准",
        ...(source === "snapshot" ? { plan } : {}),
        confirmation: { kind: "plan", key: `plan:2:${JSON.stringify(plan)}` },
      }),
    });
    expect(summary?.stage).toBe("approval");
    expect(summary?.plan).toEqual(plan);
    expect(
      collaborationPlanMarkdown(summary!.plan!, {
        architecture: "实现方案",
        acceptanceCriteria: "验收标准",
        tasks: "实施任务",
        files: "涉及文件",
        dependsOn: "前置任务",
      }),
    ).toBe(
      "修复输入校验\n\n## 实现方案\n\n在接口边界校验，保留已有请求格式。\n\n" +
        "## 验收标准\n\n- 空输入报错且有效请求正常处理\n\n## 实施任务\n\n" +
        "### 校验输入\n\n拒绝空输入\n\n**涉及文件**\n\n- src/input.ts\n\n**验收标准**\n\n- 空输入报错\n\n" +
        "### 验证接口\n\n拒绝空输入\n\n**涉及文件**\n\n- src/input.ts\n\n**验收标准**\n\n- 空输入报错\n\n" +
        "**前置任务**\n\n- 校验输入",
    );
  },
);

test("malformed persisted plan keys keep the approval notice readable", () => {
  const id = "chat-notice:chat-1:plan:0";
  const summary = collaborationMessageSummary({
    clientMessageId: id,
    text: notice(id, "方案等待用户批准。", {
      message: "等待批准方案",
      confirmation: { kind: "plan", key: "plan:1:{" },
    }),
  });
  expect(summary).toEqual({
    stage: "approval",
    text: "等待批准方案",
    instructions: "方案等待用户批准。",
    acceptance: [],
  });
});

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

test.each(["主 Agent", "总 AI", "设计 AI"])(
  "%s planning prompts summarize with the goal",
  (role) => {
    const summary = collaborationMessageSummary({
      clientMessageId: operationId,
      text: prompt(`你是${role}。阅读项目并输出设计总纲。`, {
        goal: "新增导出功能",
        cwd: "/repo",
        bindings: { director: "lead", worker: "worker" },
      }),
    });
    expect(summary?.stage).toBe("plan");
    expect(summary?.text).toBe("新增导出功能");
    expect(summary?.instructions).not.toContain("{");
  },
);

test.each([
  {
    stage: "plan",
    instruction: "You are the planning AI.",
    context: { bindings: { director: "lead", worker: "worker" } },
    text: "修复输入校验",
    acceptance: [],
  },
  {
    stage: "execute",
    instruction: "You are the implementation AI.",
    context: { task },
    text: task.title,
    acceptance: task.acceptance,
  },
  {
    stage: "review",
    instruction: "You are the original lead AI, responsible for review.",
    context: { plan, task },
    text: task.title,
    acceptance: task.acceptance,
  },
  {
    stage: "final",
    instruction: "You are the review AI, responsible for review.",
    context: { plan, taskResults: [], acceptance: plan.acceptance },
    text: "修复输入校验",
    acceptance: plan.acceptance,
  },
])(
  "English $stage prompts render as stage cards",
  ({ stage, instruction, context, text, acceptance }) => {
    const message = `[paseo-director:${operationId}]\n${instruction}\n\n${JSON.stringify({ goal: "修复输入校验", cwd: "/repo", ...context }, null, 2)}\n\nCurrent operationId=${operationId}. Submit the result.\n{}`;
    expect(collaborationMessageSummary({ clientMessageId: operationId, text: message })).toEqual({
      stage,
      text,
      instructions: instruction,
      acceptance,
    });
    expect(
      collaborationMessageSummary({
        clientMessageId: operationId,
        text: message.replace(
          `Current operationId=${operationId}`,
          "Current operationId=another-operation",
        ),
      }),
    ).toBeUndefined();
  },
);

test("plan submission permission previews the actual plan, without treating a review as a plan", () => {
  for (const name of ["submit_plan", "mcp__paseo__submit_operation", "paseo.submit_plan"]) {
    expect(collaborationPermissionPlan({ kind: "tool", name, input: { payload: plan } })).toEqual(
      plan,
    );
  }
  for (const request of [
    { kind: "tool", name: "mcp__other__submit_plan", input: { payload: plan } },
    {
      kind: "tool",
      name: "mcp__paseo__submit_operation",
      input: { payload: { decision: "approved" } },
    },
    { kind: "plan", name: "submit_plan", input: { payload: plan } },
  ] as const) {
    expect(collaborationPermissionPlan(request)).toBeUndefined();
  }
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

test("a quota notice exposes execution, and a malformed one stays readable", () => {
  const id = "chat-notice:chat-1:quota:4";
  const execution = {
    profileId: "worker",
    model: { provider: "mock/ten-second-stream" },
    relay: {
      status: "blocked",
      source: "none",
      operationId: "op-1",
      token: 3,
      manual: true,
      message: "usage limit reached",
    },
  };
  const summary = collaborationMessageSummary({
    clientMessageId: id,
    text: notice(id, "额度已用尽。", {
      message: "额度已用尽",
      phase: "executing",
      control: "needs_attention",
      execution,
    }),
  });
  expect(summary?.stage).toBe("progress");
  expect(summary?.execution).toEqual(execution);
  expect(summary?.text).toBe("额度已用尽");
  const plain = collaborationMessageSummary({
    clientMessageId: id,
    text: notice(id, "继续执行。", { message: "执行任务 task-1", phase: "executing" }),
  });
  expect(plain).toEqual({
    stage: "progress",
    text: "执行任务 task-1",
    instructions: "继续执行。",
    acceptance: [],
  });
  expect(plain).not.toHaveProperty("execution");
  const broken = collaborationMessageSummary({
    clientMessageId: id,
    text: notice(id, "额度已用尽。", {
      message: "额度已用尽",
      execution: { relay: { status: "nope" } },
    }),
  });
  expect(broken?.text).toBe("额度已用尽");
  expect(broken).not.toHaveProperty("execution");
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
