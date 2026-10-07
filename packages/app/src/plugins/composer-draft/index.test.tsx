/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useDraftStore } from "@/stores/draft-store";
import { createPluginComposerDraft, usePluginComposerDraft } from "./index";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  },
}));

vi.mock("@/attachments/service", () => ({
  garbageCollectAttachments: async () => undefined,
}));

beforeAll(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    value: true,
    configurable: true,
  });
});

describe("plugin composer draft", () => {
  beforeEach(() => {
    useDraftStore.setState({ drafts: {}, createModalDraft: null });
    document.body.innerHTML = "<div id='root'></div>";
  });

  it("reads and replaces the text of a mounted composer", async () => {
    let text = "你好";
    function Composer() {
      usePluginComposerDraft({
        serverId: "host-1",
        agentId: "agent-1",
        getText: () => text,
        replaceText: (next) => {
          text = next;
        },
      });
      return null;
    }
    const root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(<Composer />));
    const draft = createPluginComposerDraft("host-1");

    expect(draft.getText({ agentId: "agent-1" })).toBe("你好");
    draft.replaceText({ agentId: "agent-1" }, "Hello");
    expect(text).toBe("Hello");
    expect(createPluginComposerDraft("host-2").getText({ agentId: "agent-1" })).toBe("");

    await act(async () => root.unmount());
  });

  it("edits the saved draft when no composer is mounted", () => {
    const draft = createPluginComposerDraft("host-1");

    draft.replaceText({ agentId: "agent-2" }, "Saved for later");

    expect(draft.getText({ agentId: "agent-2" })).toBe("Saved for later");
    expect(useDraftStore.getState().getDraftInput("agent:host-1:agent-2")?.text).toBe(
      "Saved for later",
    );
  });
});
