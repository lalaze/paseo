import { useCallback } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ConversationHistory } from "./conversation-history";
import { useCollaboration } from "./use-collaboration";

interface HistoryPageProps {
  serverId: string;
  onBack: () => void;
  showBack: boolean;
}

export function CollaborationHistoryPage(props: HistoryPageProps) {
  return <HistoryPage key={props.serverId} {...props} />;
}

function HistoryPage({ serverId, onBack, showBack }: HistoryPageProps) {
  const { t } = useTranslation();
  const { client, query, command } = useCollaboration(serverId);
  const retry = useCallback(() => {
    void query.refetch();
  }, [query]);
  const error = query.error?.message ?? query.data?.error;
  let content;
  if (!client || query.isPending) {
    content = <HistorySpinner />;
  } else if (error) {
    content = (
      <View style={styles.section}>
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
        <Button onPress={retry}>{t("collaboration.retry")}</Button>
      </View>
    );
  } else if (query.data) {
    content = (
      <>
        {command.error && (
          <Text accessibilityRole="alert" style={styles.error}>
            {command.error.message}
          </Text>
        )}
        <ConversationHistory
          serverId={serverId}
          conversations={query.data.conversations}
          pending={command.isPending}
          command={command.mutate}
        />
      </>
    );
  }
  return (
    <View style={styles.section} testID="collaboration-history-page">
      {showBack && (
        <View style={styles.back}>
          <Button onPress={onBack} variant="ghost" size="sm" testID="collaboration-history-back">
            {t("collaboration.history.back")}
          </Button>
        </View>
      )}
      {content}
    </View>
  );
}

const HistorySpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const styles = StyleSheet.create((theme) => ({
  section: { gap: theme.spacing[4] },
  back: { alignItems: "flex-start" },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
}));
