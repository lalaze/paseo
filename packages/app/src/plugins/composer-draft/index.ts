import { useEffect, useRef } from "react";
import type { PluginComposerDraft } from "@getpaseo/plugin/client";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";

interface MountedComposer {
  getText(): string;
  replaceText(text: string): void;
}

const mounted = new Map<string, MountedComposer[]>();
const composerKey = (serverId: string, agentId: string) => `${serverId}\u0000${agentId}`;

/** Lets plugins reach the composer the user is looking at for this agent. */
export function usePluginComposerDraft(input: {
  serverId: string;
  agentId: string;
  getText(): string;
  replaceText(text: string): void;
}): void {
  const latest = useRef(input);
  latest.current = input;
  const { serverId, agentId } = input;
  useEffect(() => {
    const key = composerKey(serverId, agentId);
    const composer: MountedComposer = {
      getText: () => latest.current.getText(),
      replaceText: (text) => latest.current.replaceText(text),
    };
    mounted.set(key, [...(mounted.get(key) ?? []), composer]);
    return () => {
      const rest = (mounted.get(key) ?? []).filter((entry) => entry !== composer);
      if (rest.length) mounted.set(key, rest);
      else mounted.delete(key);
    };
  }, [serverId, agentId]);
}

/** Mounted composers update on screen; otherwise the saved draft changes for next time. */
export function createPluginComposerDraft(serverId: string): PluginComposerDraft {
  return {
    getText({ agentId }) {
      const composers = mounted.get(composerKey(serverId, agentId));
      if (composers?.length) return composers[composers.length - 1].getText();
      const draftKey = buildDraftStoreKey({ serverId, agentId });
      return useDraftStore.getState().getDraftInput(draftKey)?.text ?? "";
    },
    replaceText({ agentId }, text) {
      const composers = mounted.get(composerKey(serverId, agentId));
      if (composers?.length) {
        for (const composer of composers) composer.replaceText(text);
        return;
      }
      const draftKey = buildDraftStoreKey({ serverId, agentId });
      useDraftStore.getState().editDraftText({ draftKey, text });
    },
  };
}
