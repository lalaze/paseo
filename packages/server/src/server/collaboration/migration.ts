import type { Store } from "./store.js";
import { CHAT_PROMPT } from "./prompts.js";

/** Switch transport once; never replay an uncertain delivery during an upgrade. */
export function migrateNativeCollaboration(store: Store) {
  if (store.meta("nativeCollaborationVersion") === 1) return;
  store.transaction(() => migrateRecords(store));
}
function migrateRecords(store: Store) {
  for (const run of store.all()) {
    if (run.phase === "completed" || run.control === "canceled") continue;
    if (["running", "waiting_permission"].includes(run.control)) {
      const op = run.operations.find((operation) => operation.id === run.activeOperationId);
      run.control = op && ["sending", "creating"].includes(op.state) ? "needs_attention" : "paused";
      run.message = "已迁入 Paseo 内置协作，原任务和成果已保留；请检查当前状态后继续。";
      store.save(run);
    }
  }
  for (const conversation of store.conversations()) {
    if (!conversation.agentId) continue;
    const run = conversation.runId ? store.get(conversation.runId) : undefined;
    if (run && (run.phase === "completed" || run.control === "canceled")) continue;
    conversation.takeover ??= { messages: [] };
    conversation.takeover.instruction = CHAT_PROMPT;
    conversation.linksReady = false;
    conversation.toolsConnectedAt = undefined;
    const id = `chat-command:native:${conversation.id}`;
    if (!conversation.takeover.messages.some((message) => message.id === id)) {
      conversation.takeover.messages.push({
        id,
        text: "Collaboration has moved into Paseo. Use the built-in get_conversation_status, start_task, submit_operation and control_task tools in this session. Stop using the old plugin file bridge or standalone Director MCP. Read status and briefly inform the user; this notice does not approve a plan or start or resume a task.",
        automatic: true,
        state: "pending",
        createdAt: Date.now(),
      });
    }
    store.saveConversation(conversation);
  }
  store.setMeta("nativeCollaborationVersion", 1);
}
