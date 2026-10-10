import { beforeEach, describe, expect, it } from "vitest";
import {
  beginCollaborationEnable,
  clearCollaborationError,
  collaborationEnableKey,
  isCollaborationEnablePending,
  selectCollaborationEnabling,
  selectCollaborationError,
  selectCollaborationRequest,
  settleCollaborationEnable,
  useCollaborationEnableStore,
} from "./enable-store";

describe("collaboration enable store", () => {
  beforeEach(() => useCollaborationEnableStore.setState({ pending: {}, errors: {}, requests: {} }));

  it("keys the in-flight enable per agent", () => {
    const first = collaborationEnableKey("s1", "agent-1");
    const second = collaborationEnableKey("s1", "agent-2");
    beginCollaborationEnable(first);
    const state = useCollaborationEnableStore.getState();
    expect(selectCollaborationEnabling(state, first)).toBe(true);
    expect(selectCollaborationEnabling(state, second)).toBe(false);
  });

  it("clears pending and the error on success", () => {
    const key = collaborationEnableKey("s1", "agent-1");
    beginCollaborationEnable(key);
    settleCollaborationEnable(key);
    const state = useCollaborationEnableStore.getState();
    expect(selectCollaborationEnabling(state, key)).toBe(false);
    expect(selectCollaborationError(state, key)).toBeNull();
  });

  it("keeps a failure visible and stops reporting pending", () => {
    const key = collaborationEnableKey("s1", "agent-1");
    beginCollaborationEnable(key);
    settleCollaborationEnable(key, "host is busy");
    const state = useCollaborationEnableStore.getState();
    expect(selectCollaborationEnabling(state, key)).toBe(false);
    expect(selectCollaborationError(state, key)).toBe("host is busy");
  });

  it("clears a previous error when a retry starts", () => {
    const key = collaborationEnableKey("s1", "agent-1");
    settleCollaborationEnable(key, "host is busy");
    beginCollaborationEnable(key);
    expect(selectCollaborationError(useCollaborationEnableStore.getState(), key)).toBeNull();
  });

  it("reads pending synchronously for send paths that race the enable", () => {
    expect(isCollaborationEnablePending("s1", "agent-1")).toBe(false);
    beginCollaborationEnable(collaborationEnableKey("s1", "agent-1"));
    expect(isCollaborationEnablePending("s1", "agent-1")).toBe(true);
    expect(isCollaborationEnablePending("s1", "agent-2")).toBe(false);
    settleCollaborationEnable(collaborationEnableKey("s1", "agent-1"));
    expect(isCollaborationEnablePending("s1", "agent-1")).toBe(false);
  });

  it("dismisses a failure without touching other agents", () => {
    const first = collaborationEnableKey("s1", "agent-1");
    const second = collaborationEnableKey("s1", "agent-2");
    settleCollaborationEnable(first, "host is busy");
    settleCollaborationEnable(second, "other failure");
    clearCollaborationError(first);
    const state = useCollaborationEnableStore.getState();
    expect(selectCollaborationError(state, first)).toBeNull();
    expect(selectCollaborationError(state, second)).toBe("other failure");
  });

  it("remembers the request id across a failure so a retry resumes the same conversation", () => {
    const key = collaborationEnableKey("s1", "agent-1");
    beginCollaborationEnable(key, "req-1");
    expect(selectCollaborationRequest(useCollaborationEnableStore.getState(), key)).toBe("req-1");
    settleCollaborationEnable(key, "Working directory does not exist");
    expect(selectCollaborationRequest(useCollaborationEnableStore.getState(), key)).toBe("req-1");
  });

  it("drops the request id once the enable succeeds", () => {
    const key = collaborationEnableKey("s1", "agent-1");
    beginCollaborationEnable(key, "req-1");
    settleCollaborationEnable(key);
    expect(selectCollaborationRequest(useCollaborationEnableStore.getState(), key)).toBeNull();
  });
});
