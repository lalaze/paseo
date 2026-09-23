# Collaboration

Use **Collaboration** beside the Agent conversation's input, the workspace command palette, or
type `/director`. All three open the same mode dialog over the current workspace (a bottom sheet
on phones). Choose a mode before continuing; canceling preserves the conversation and draft.
`/director <goal>` also supplies the first request. Host settings → Collaboration
selects the lead, implementation and optional review profiles. With no separate reviewer, the lead
performs the final review. Configure native agent profiles first.

Open **Conversation history** from the top of host collaboration settings to see each task's
status, mode and progress on a separate page. Its Back action returns to that host's collaboration
settings, including when you open the history link directly. Open a conversation's menu to expand
the full goal, resync, or control the task. Stopped conversations retain their workspace and results.

Collaboration runs inside the daemon. It uses the existing agent creation, tool injection,
permissions, timeline and parent/child lifecycle. Providers must have Paseo tools enabled.
The main conversation keeps its identity; implementation and separate review sessions appear as
its children. Closing a session does not discard a task. See [agent lifecycle](agent-lifecycle.md).

## Modes

Choose **Full workflow** for planned, multi-task work, or **Execution + review** for a focused
change that benefits from an independent check. The selection belongs to this task, not the host
defaults. A conversation holds one task; start another conversation to use a different mode once
execution has started.

Execution + review sends the complete goal to one implementer without a design or plan approval
step. Configure a review agent before continuing. Review always uses a separate session, even
when implementation and review use the same profile. Category and task assignments do not apply.
Rework and user-requested changes return to the implementer and then independent review; final
user acceptance is still required. The main conversation handles communication and dispatch.

The mode picker shows the implementation and review profiles. **Configure agents** opens host
settings and preserves your goal and selection. Save or return from settings to reopen the picker
over the original conversation. Saving settings does not start a task: continue in the picker
afterward. With no goal, enabling collaboration
waits for your next implementation request. Update older hosts to use Execution + review; existing
tasks and requests without a mode retain Full workflow.

## Execution and confirmation

Tasks execute serially in dependency order within one workspace. Starting a task creates a
`director/<run-id>` branch while retaining staged, unstaged and untracked changes. Use a separate
Paseo workspace first when you want isolation. A repository must have an initial commit and no
unresolved merge conflicts.

In Full workflow, plan approval is optional. Final user acceptance is required even after the AI approves the
result. Approval tools verify the latest real user message and the version of the confirmation
shown in that conversation. Background notices and worker output cannot approve a plan or result.
The assistant explains the required confirmation replies in chat.

Pause stops subsequent dispatch; the current turn can finish. Cancel stops the active worker and
retains the branch and files. Uncertain creation or delivery waits for inspection and explicit retry.
Verification commands run as executable plus literal arguments, without shell expansion. Quotes
are supported; add separate lines instead of pipelines or `&&`.

## Moving from the Director plugin

Disable `paseo-director` before using the built-in feature. The two schedulers must not share a
live database. The built-in service also blocks restarting that plugin while it owns the database.

Keep `$PASEO_HOME/director`, including its SQLite database, artifacts and worktrees. A configured
`PASEO_DIRECTOR_DATA_DIR` continues to select the same directory. The first native start retains
settings, task checkpoints and conversation identities, pauses active dispatch, and queues a
native-tool handoff. Inspect the task before resuming; uncertain sends require retry. Legacy
loopback Director MCP configuration is removed when the corresponding idle session is resumed.
No separate Director listener or file bridge is started.

Settings changes apply to future conversations. Existing conversations and tasks retain their
saved configuration so a profile edit cannot change an operation midway through execution.
