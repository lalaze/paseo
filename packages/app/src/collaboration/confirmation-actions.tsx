import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { dispatchComposerAgentMessage } from "@/composer/actions";
import { createMessageSubmissionWriter } from "@/composer/submission/writer";
import { confirmDialog } from "@/utils/confirm-dialog";
import { useCollaboration } from "./use-collaboration";

// The host accepts an approval only as a whole user message with one of these exact phrases, so
// the buttons send the phrase itself; the main Agent then confirms it like a typed reply.
const REPLIES = {
  approvePlan: "批准方案",
  accept: "验收通过",
  reject: "不采纳成果",
} as const;

/** Approve or accept from the pending confirmation card instead of typing the exact reply. */
export function CollaborationConfirmationActions({
  serverId,
  agentId,
  noticeId,
}: {
  serverId: string;
  agentId: string;
  noticeId: string;
}) {
  const { t } = useTranslation();
  const { client, query } = useCollaboration(serverId);
  const [sent, setSent] = useState<keyof typeof REPLIES | null>(null);
  const [error, setError] = useState<string | null>(null);
  const confirmation = query.data?.conversations.find(
    (conversation) => conversation.agentId === agentId && !conversation.disabledAt,
  )?.confirmation;
  const send = useCallback(
    async (reply: keyof typeof REPLIES) => {
      if (!client) return;
      if (
        reply === "reject" &&
        !(await confirmDialog({
          title: t("collaboration.confirmation.rejectTitle"),
          message: t("collaboration.confirmation.rejectMessage"),
          confirmLabel: t("collaboration.confirmation.reject"),
          destructive: true,
        }))
      )
        return;
      setSent(reply);
      setError(null);
      try {
        await dispatchComposerAgentMessage({
          client,
          agentId,
          text: REPLIES[reply],
          attachments: [],
          encodeImages: async () => undefined,
          submission: createMessageSubmissionWriter(serverId),
        });
      } catch (cause) {
        setSent(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [agentId, client, serverId, t],
  );
  const approvePlan = useCallback(() => void send("approvePlan"), [send]);
  const accept = useCallback(() => void send("accept"), [send]);
  const reject = useCallback(() => void send("reject"), [send]);
  if (confirmation?.noticeId !== noticeId) return null;
  const busy = sent !== null || !client;
  return (
    <View style={styles.container} testID="collaboration-confirmation-actions">
      <View style={styles.buttons}>
        {confirmation.kind === "plan" ? (
          <Button size="sm" variant="default" disabled={busy} onPress={approvePlan}>
            {t("collaboration.confirmation.approvePlan")}
          </Button>
        ) : (
          <>
            <Button size="sm" variant="default" disabled={busy} onPress={accept}>
              {t("collaboration.confirmation.accept")}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onPress={reject}>
              {t("collaboration.confirmation.reject")}
            </Button>
          </>
        )}
      </View>
      <Text style={styles.hint}>
        {confirmation.kind === "plan"
          ? t("collaboration.confirmation.planHint")
          : t("collaboration.confirmation.changesHint")}
      </Text>
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    marginTop: theme.spacing[2],
    gap: theme.spacing[2],
  },
  buttons: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
}));
