import { ENABLE_COLLABORATION_MESSAGE } from "@getpaseo/protocol/collaboration/conversation";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { readCollaborationPrompt } from "@getpaseo/protocol/collaboration/presentation";
import type { UserMessageItem } from "@/types/stream";
import { Button } from "@/components/ui/button";

export function collaborationMessageSummary(item: UserMessageItem) {
  const id = item.clientMessageId ?? item.messageId;
  if (!id) return;
  const prompt = readCollaborationPrompt(item.text);
  if (prompt && prompt.operationId === id)
    return { kind: prompt.stage, text: prompt.task ?? prompt.goal };
  if (id.startsWith("chat-notice:") && item.text.startsWith(`[paseo-director-chat:${id}]\n`)) {
    const start = item.text.indexOf("\n{");
    if (start < 0) return;
    try {
      const value: unknown = JSON.parse(item.text.slice(start + 1));
      if (
        value &&
        typeof value === "object" &&
        "message" in value &&
        typeof value.message === "string"
      )
        return { kind: "progress", text: value.message };
    } catch {
      return;
    }
  }
  const boundary = item.text.indexOf("\n\n[paseo-director-takeover]\n");
  if (id.startsWith("chat-command:") && boundary > 0) {
    const text = item.text.slice(0, boundary);
    return {
      kind: "enabled",
      text:
        text === ENABLE_COLLABORATION_MESSAGE || id.startsWith("chat-command:native:") ? "" : text,
    };
  }
}
export function CollaborationMessage({ item }: { item: UserMessageItem }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const summary = useMemo(() => collaborationMessageSummary(item), [item]);
  const toggle = useCallback(() => setExpanded((previous) => !previous), []);
  if (!summary) return null;
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{t(`collaboration.message.${summary.kind}`)}</Text>
      {summary.text && (
        <Text style={styles.text} selectable>
          {summary.text}
        </Text>
      )}
      <Button variant="ghost" onPress={toggle}>
        {t(expanded ? "collaboration.hideDetails" : "collaboration.showDetails")}
      </Button>
      {expanded && (
        <Text style={styles.text} selectable>
          {item.text}
        </Text>
      )}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  card: {
    marginVertical: theme.spacing[2],
    padding: theme.spacing[3],
    gap: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
  },
  title: { color: theme.colors.foreground, fontWeight: "600" },
  text: { color: theme.colors.foregroundMuted },
}));
