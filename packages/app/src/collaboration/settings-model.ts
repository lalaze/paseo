import { RolePromptsSchema, type RolePrompts } from "@getpaseo/protocol/collaboration/schema";

export function openCollaborationSettings(initial: RolePrompts) {
  let base = initial;
  let state = { prompts: initial, saving: false, saved: false, error: "" };
  const listeners = new Set<() => void>();
  function publish() {
    for (const listener of listeners) listener();
  }
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setPrompt(role: keyof RolePrompts, value: string) {
      if (state.saving) return;
      state = { ...state, prompts: { ...state.prompts, [role]: value }, saved: false, error: "" };
      publish();
    },
    async save(
      write: (prompts: RolePrompts, base: RolePrompts) => Promise<void>,
      afterSave?: () => Promise<void>,
    ) {
      if (state.saving) return;
      state = { ...state, saving: true, saved: false, error: "" };
      publish();
      try {
        const prompts = RolePromptsSchema.parse(state.prompts);
        await write(prompts, base);
        base = prompts;
        state = { ...state, saved: true };
        await afterSave?.();
      } catch (error) {
        state = { ...state, error: error instanceof Error ? error.message : String(error) };
      } finally {
        state = { ...state, saving: false };
        publish();
      }
    },
    close() {
      listeners.clear();
    },
  };
}
