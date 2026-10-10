# Collaboration

Use **Collaboration** beside the Agent conversation's input, the workspace command palette, or
type `/director`. The composer control is a split button. The label toggles collaboration: off, it
enables with the last setup remembered on this host and device in one tap — enabling only prepares
the conversation, so the next message you send is what starts a task; on, it exits. It never starts
a task on its own and never treats earlier chat as the request. A conversation with no task started
exits at once; a running task asks you to confirm first, then stops the role sessions while keeping
the branch, files and history, and the main chat returns to normal chat that can enable collaboration
again. The chevron beside the label opens the mode dialog to change the setup, and never fires the
label or exits. When the setup cannot be reused — nothing remembered yet, or a remembered model or
thinking level is no longer available on this host — the dialog opens on the full form so you finish
it. While an enable or exit request is in flight the control shows it and the composer refuses to
send, so the two cannot race. A failure stays in the composer as a dismissible error and is never
shown as the opposite state; pressing the control retries the same operation on the same
conversation. Exiting needs a host that supports it; an older host shows an update prompt instead of
pretending to close.

The dialog opens over the current workspace (a bottom sheet on phones). `/director <goal>` also
supplies the first request, and **Change** on the last-setup summary opens the full form. Canceling
preserves the conversation and draft.

The form shows the mode, the isolation choice and the execution and review agents. Rework limit,
time budget and the role-instructions entry sit under **Advanced settings**, collapsed by default;
the collapsed row shows the chosen rework limit and time budget, so folding it never hides them.
A model's thinking level expands with the model. Select each role's provider and model directly in
the dialog; you do not need saved Agent profiles. The first task's execution model inherits the
conversation's current provider, model and thinking level; review is chosen explicitly. The dialog
remembers, per host and on this device, the mode, isolation, models, thinking levels, rework limit
and time budget of the last task you started. New Full workflow conversations also select a lead.
Enabling collaboration in an existing chat retains that chat’s lead. With no separate reviewer in
Full workflow, the lead performs the final review.

Host settings → Collaboration contains role instructions and conversation history. Instructions
can be saved before choosing any models. New tasks use the built-in limits and verification
defaults, except the rework limit (default 2) and the time budget per round (default 4
hours), which you choose in the dialog; legacy advanced
settings are retained for existing conversations.

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
step. Select a review provider and model in the dialog before continuing. Review always uses a separate session, even
when implementation and review use the same profile. Category and task assignments do not apply.
Rework and user-requested changes return to the implementer and then independent review; final
user acceptance is still required. The main conversation handles communication and dispatch.

The **Instructions** action under **Advanced settings** opens host settings and preserves the goal,
mode and model selections. Save or return from settings to reopen the picker over the original conversation.
Saving instructions does not start a task. Continue in the picker afterward. With no goal, enabling
collaboration waits for your next implementation request. Update older hosts to select models in
the dialog. Existing conversations keep their saved models and instructions, even before a task
starts; create another conversation to change them.

## Execution and confirmation

Tasks execute serially in dependency order within one workspace. Each worker profile keeps one
session for the whole run: the next task, a retry and a revised requirement continue in it, so the
environment, scripts and data it built carry over. A session that has been archived or has failed
is replaced with a fresh one at the next step. Every worker also receives the results of the tasks
completed before it. A turn that ends without submitting a result is asked to report in the same
session, up to twice, before the run needs attention. The launch dialog's
[Isolation](glossary.md) choice decides where the task runs. Local creates a `director/<run-id>`
branch in the source checkout while retaining staged, unstaged and untracked changes, so it must
start from the project root. New worktree creates a Paseo worktree workspace on `director/<run-id>`
at the repository root, even when started from a subdirectory, because evidence captures the whole
worktree. The sidebar hides that workspace; its sessions open from the main conversation.
Uncommitted changes stay in the source checkout. Setup hooks run to completion before
workers start, unlike `create_workspace`, which runs them in the background; an untrusted change
request checkout refuses until you run its setup. A retry reuses that worktree when its branch is
still `director/<run-id>`, and checks a leftover branch out again, keeping its tip as the review
base, when the worktree is gone. Worktrees already stored under the collaboration data directory
are reused. A repository must have an initial commit and no unresolved merge conflicts.

In Full workflow, plan approval is optional. Final user acceptance is required even after the AI approves the
result. When a task has used every rework and the final review still requests changes, the run
goes to acceptance with that review instead of stopping: the main Agent lists the findings and you
accept, reject, or request changes, which starts a new round with a fresh rework budget. Approval tools verify the latest real user message and the version of the confirmation
shown in that conversation. Background notices and worker output cannot approve a plan or result.
The buttons on the pending approval or acceptance card send the same exact reply as a user
message, so they pass the same check; the host reports which notice is pending
(`confirmation.noticeId` in collaboration status) so only that card shows them.

## Conversation timeline

Operation prompts and background notices reach the main Agent as user-role messages. The app
renders each one as a compact stage row (`Collaboration · review`, `Collaboration · awaiting
acceptance`, and so on) with a one-line summary; expanding the row shows the instructions the
Agent received, never the marker or JSON context. The row carries the status, so the Agent's reply
must not restate it or narrate the scheduler: it says what changed, what is next, and what the user
has to do. At acceptance the Agent gives one report — actual changes, verification run and results,
known limitations — and ends with the exact replies: `验收通过` alone to accept, `不采纳成果`
alone to reject, or a description of the changes to request rework.

The rows are parsed from message text (`packages/app/src/collaboration/message-summary.ts`), and
messages persisted by older hosts must keep parsing. Keep a notice's instruction on the single line
between its marker and its JSON, and keep new JSON fields optional.

The time budget counts only time the run is running. Paused, blocked (needs attention), waiting
for permission and awaiting acceptance time is free; the engine meters this at each control change
(`runningSince`, `budgetUsedMs`). A round stops once its budget is used up. Retry still picks up a
result that arrived in time, since that needs no new AI turn; anything that would dispatch again is
refused. Requesting changes starts a new round with a fresh budget. Runs saved before metering
start with an empty budget.

To add a detail without changing the goal ("don't commit the measurements"), tell the main Agent.
It records a note with `control_task` `note`; every later execution and review step receives the
notes, and a step already queued gets them when it is sent. No re-plan happens. Revise is for a
changed goal and re-plans from scratch.

New implementation and independent review sessions run with the provider's unattended permissions,
including when the model picker saved its normal default mode or the main conversation asks for
approval. The main conversation retains its selected mode. Providers without an unattended mode
use their automatic permission acceptance feature. A permission request that still needs an answer
also appears in the main conversation, labeled with the session it came from, so you can answer it
there. Existing role sessions retain their permissions until replaced.

Network and server-side provider failures (`EOF`, connection resets, 5xx, overloaded) retry by
themselves after 30 seconds, 2 minutes and 5 minutes before the run needs attention. Quota,
billing and auth failures do not clear by retrying soon, so they stop at once.

Pause stops subsequent dispatch; the current turn can finish. Cancel ends the run immediately from
any unfinished state and retains the branch and files. It then interrupts the active role session
as a follow-up, never the main conversation. An interrupt that fails is recorded on the run and does
not undo the cancel, because a session the daemon cannot reach, such as an archived one, would
otherwise hold the run and its workspace. A timeout or a requirement change, unlike cancel, waits
until the AI has stopped, so the next turn cannot overlap the old one.
Uncertain creation or delivery waits for inspection and explicit retry.
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

Instructions changes apply to future conversations. Existing conversations and tasks retain their
saved configuration so editing instructions cannot change an operation midway through execution.
