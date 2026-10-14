import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { dispatchComposerAgentMessage } from "@/composer/actions";
import { createMessageSubmissionWriter } from "@/composer/submission/writer";
import { confirmDialog } from "@/utils/confirm-dialog";
import { generateMessageId } from "@/types/stream";
import { useHostFeature } from "@/runtime/host-features";
import { useCollaboration } from "./use-collaboration";

// The host accepts an approval only as a whole user message with one of these exact phrases, so
// the buttons send the phrase itself; the main Agent then confirms it like a typed reply.
const REPLIES = {
  approvePlan: "批准方案",
  acceptAndMerge: "验收并合并",
  reject: "不采纳成果",
} as const;

interface ConfirmationActionsProps {
  serverId: string;
  agentId: string;
  noticeId: string;
}

function useConfirmationActions({ serverId, agentId, noticeId }: ConfirmationActionsProps) {
  const { t } = useTranslation();
  const { client, query } = useCollaboration(serverId);
  const supportsMerge = useHostFeature(serverId, "collaborationMerge");
  const [sent, setSent] = useState<keyof typeof REPLIES | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deliveryRequest, setDeliveryRequest] = useState<{
    id: string;
    sourceMessageId: string;
    noticeId: string;
    targetBranch: string;
  } | null>(null);
  const conversation = query.data?.conversations.find(
    (candidate) => candidate.agentId === agentId && !candidate.disabledAt,
  );
  const confirmation = conversation?.confirmation;
  const deliver = useCallback(async () => {
    if (!client) return;
    if (!supportsMerge)
      throw new Error("Update the host to accept and merge collaboration results.");
    const request =
      deliveryRequest ??
      (conversation && confirmation?.mergeTargetBranch
        ? {
            id: conversation.id,
            sourceMessageId: generateMessageId(),
            noticeId,
            targetBranch: confirmation.mergeTargetBranch,
          }
        : null);
    if (!request) throw new Error("The collaboration result has no recorded merge target.");
    // Keep the message id across a failed delivery: retry the accepted result after its card closes.
    if (!deliveryRequest) {
      await dispatchComposerAgentMessage({
        client,
        agentId,
        text: REPLIES.acceptAndMerge,
        messageId: request.sourceMessageId,
        attachments: [],
        encodeImages: async () => undefined,
        submission: createMessageSubmissionWriter(serverId),
      });
      setDeliveryRequest(request);
    }
    await client.collaborationCommand("conversation.confirm", request);
    await query.refetch();
    setDeliveryRequest(null);
    setSent(null);
  }, [
    client,
    supportsMerge,
    deliveryRequest,
    conversation,
    confirmation,
    noticeId,
    agentId,
    serverId,
    query,
  ]);
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
        if (reply === "acceptAndMerge") {
          await deliver();
        } else {
          await dispatchComposerAgentMessage({
            client,
            agentId,
            text: REPLIES[reply],
            attachments: [],
            encodeImages: async () => undefined,
            submission: createMessageSubmissionWriter(serverId),
          });
        }
      } catch (cause) {
        setSent(null);
        setError(
          cause instanceof Error
            ? cause.message.replace(/ requestType=\S+(?: code=\S+)?$/, "")
            : String(cause),
        );
        if (reply === "acceptAndMerge") await query.refetch();
      }
    },
    [agentId, client, serverId, t, deliver, query],
  );
  const run = conversation?.run;
  const failedDelivery = run?.phase === "completed" && run.deliveryStatus !== "merged";
  const pendingDelivery =
    sent === "acceptAndMerge" || (deliveryRequest !== null && error !== null && failedDelivery);
  return {
    client,
    supportsMerge,
    sent,
    error,
    deliveryRequest,
    confirmation,
    send,
    pendingDelivery,
  };
}

/** Approve or accept from the pending confirmation card instead of typing the exact reply. */
export function CollaborationConfirmationActions(props: ConfirmationActionsProps) {
  const { t } = useTranslation();
  const {
    client,
    supportsMerge,
    sent,
    error,
    deliveryRequest,
    confirmation,
    send,
    pendingDelivery,
  } = useConfirmationActions(props);
  const { noticeId } = props;
  const approvePlan = useCallback(() => void send("approvePlan"), [send]);
  const acceptAndMerge = useCallback(() => void send("acceptAndMerge"), [send]);
  const reject = useCallback(() => void send("reject"), [send]);
  const activeCard = confirmation?.noticeId === noticeId;
  if (!activeCard && !pendingDelivery) return null;
  const plan = confirmation?.kind === "plan";
  const targetBranch = deliveryRequest?.targetBranch ?? confirmation?.mergeTargetBranch;
  const canMerge = supportsMerge && !!targetBranch;
  const busy = sent !== null || !client;
  return (
    <View style={styles.container} testID="collaboration-confirmation-actions">
      <View style={styles.buttons}>
        {plan ? (
          <Button size="sm" variant="default" disabled={busy} onPress={approvePlan}>
            {t("collaboration.confirmation.approvePlan")}
          </Button>
        ) : (
          <FinalConfirmationButtons
            canMerge={canMerge}
            retry={deliveryRequest !== null && error !== null}
            activeCard={activeCard}
            busy={busy}
            merging={sent === "acceptAndMerge"}
            onMerge={acceptAndMerge}
            onReject={reject}
          />
        )}
      </View>
      <Text style={styles.hint}>
        {plan
          ? t("collaboration.confirmation.planHint")
          : t("collaboration.confirmation.changesHint")}
      </Text>
      {!plan && canMerge ? (
        <Text style={styles.hint}>
          {t("collaboration.confirmation.mergeHint", { branch: targetBranch })}
        </Text>
      ) : null}
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function FinalConfirmationButtons({
  canMerge,
  retry,
  activeCard,
  busy,
  merging,
  onMerge,
  onReject,
}: {
  canMerge: boolean;
  retry: boolean;
  activeCard: boolean;
  busy: boolean;
  merging: boolean;
  onMerge(): void;
  onReject(): void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Button
        size="sm"
        variant="default"
        disabled={busy || !canMerge}
        onPress={onMerge}
        loading={merging}
        testID="collaboration-accept-and-merge"
      >
        {t(
          retry
            ? "collaboration.confirmation.retryMerge"
            : "collaboration.confirmation.acceptAndMerge",
        )}
      </Button>
      {activeCard ? (
        <Button size="sm" variant="outline" disabled={busy} onPress={onReject}>
          {t("collaboration.confirmation.reject")}
        </Button>
      ) : null}
    </>
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
