import type { StreamItem, UserMessageItem } from "@/types/stream";
import { collaborationMessageSummary, type CollaborationMessageSummary } from "./message-summary";

export interface CollaborationProgressEntry {
  item: UserMessageItem;
  conversationId: string;
  summary: CollaborationMessageSummary;
}

export interface CollaborationProgressGroup {
  id: string;
  entries: readonly CollaborationProgressEntry[];
}

interface ProgressState {
  groups: Map<string, CollaborationProgressGroup>;
  hosts: Map<string, string>;
}

const entryCache = new WeakMap<UserMessageItem, CollaborationProgressEntry | null>();
const hostCache = new WeakMap<CollaborationProgressGroup, UserMessageItem>();

function progressEntry(item: StreamItem): CollaborationProgressEntry | null {
  if (item.kind !== "user_message") return null;
  if (entryCache.has(item)) return entryCache.get(item)!;
  const summary = collaborationMessageSummary(item);
  const id = item.clientMessageId ?? item.messageId;
  const conversation = /^chat-notice:(.+):[^:]+:\d+$/u.exec(id ?? "")?.[1];
  const entry = summary && conversation ? { item, summary, conversationId: conversation } : null;
  entryCache.set(item, entry);
  return entry;
}

function collectEntries(items: StreamItem[], state: ProgressState, previous: ProgressState) {
  const entriesByHost = new Map<string, CollaborationProgressEntry[]>();
  for (const item of items) {
    const entry = progressEntry(item);
    if (!entry) continue;
    const conversation = entry.conversationId;
    const hostId = state.hosts.get(conversation) ?? item.id;
    state.hosts.set(conversation, hostId);
    let entries = entriesByHost.get(hostId);
    if (!entries) {
      entries = [...(state.groups.get(hostId)?.entries ?? [])];
      entriesByHost.set(hostId, entries);
    }
    entries.push(entry);
  }
  for (const [hostId, entries] of entriesByHost) {
    const existing = previous.groups.get(hostId);
    const unchanged =
      existing?.entries.length === entries.length &&
      existing.entries.every((entry, index) => entry === entries[index]);
    state.groups.set(hostId, unchanged ? existing : { id: hostId, entries });
  }
}

function visibleItems(items: StreamItem[], state: ProgressState): StreamItem[] {
  const visible: StreamItem[] = [];
  for (const item of items) {
    const entry = progressEntry(item);
    if (!entry) {
      visible.push(item);
      continue;
    }
    const hostId = state.hosts.get(entry.conversationId)!;
    const group = state.groups.get(hostId)!;
    const latest = group.entries[group.entries.length - 1]!;
    // A projected host carries the latest notice but has the first notice's stable row id.
    const latestId = latest.item.clientMessageId ?? latest.item.messageId;
    const itemId = entry.item.clientMessageId ?? entry.item.messageId;
    if (latestId !== itemId) continue;
    let host = hostCache.get(group);
    if (!host) {
      host = { ...latest.item, id: group.id };
      hostCache.set(group, host);
    }
    visible.push(host);
  }
  return items.length === visible.length && items.every((item, index) => item === visible[index])
    ? items
    : visible;
}

/** One task per conversation, with a stable card id placed at its latest notice. */
export function createCollaborationProgressProjection() {
  let source: StreamItem[] | undefined;
  let history: ProgressState = { groups: new Map(), hosts: new Map() };
  let tail: StreamItem[] = [];
  let previous = history;
  let visibleTail = tail;
  return (input: { tail: StreamItem[]; head: StreamItem[] }) => {
    if (source !== input.tail) {
      history = { groups: new Map(), hosts: new Map() };
      collectEntries(input.tail, history, previous);
      tail = visibleItems(input.tail, history);
      source = input.tail;
    }
    const hasProgress = input.head.some((item) => progressEntry(item) !== null);
    if (!hasProgress) {
      previous = history;
      visibleTail = tail;
      return { tail, head: input.head, groupsByHostId: history.groups };
    }
    const state = { groups: new Map(history.groups), hosts: new Map(history.hosts) };
    collectEntries(input.head, state, previous);
    // Keep cards in history while a notice is live, so their approval and model-switch
    // state survives both updates and head-to-history promotion.
    const nextTail = [...visibleItems(tail, state)];
    const headRows = visibleItems(input.head, state);
    const head = headRows.filter((item) => {
      if (!state.groups.has(item.id)) return true;
      nextTail.push(item);
      return false;
    });
    if (
      visibleTail.length !== nextTail.length ||
      visibleTail.some((item, index) => item !== nextTail[index])
    ) {
      visibleTail = nextTail;
    }
    previous = state;
    return {
      tail: visibleTail,
      head,
      groupsByHostId: state.groups,
    };
  };
}
