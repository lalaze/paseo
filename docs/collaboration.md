# Collaboration

Use **Collaboration** beside the Agent conversation's input, the workspace command palette, or
type `/director`. The composer control is a split button. The label toggles collaboration: off, it
enables with the last setup remembered on this host and device in one tap — enabling only prepares
the conversation, so the next message you send is what starts a task; on, it exits. It never starts
a task on its own and never treats earlier chat as the request. A conversation with no task started
exits at once; a running task asks you to confirm first, then stops the role sessions while keeping
the branch, files and history, and the main chat returns to normal chat that can enable collaboration
again. The chevron beside the label opens the setup dialog to change the setup, and never fires the
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

The form shows **Plan first**, the isolation choice and the execution and review agents.
Under the execution model you can add up to eight backup models, reorder them, and remove them.
Leave that list empty to keep quota handoff manual. A saved list is remembered per host with the
last setup and is sent with a new task. An older host that does not advertise
`collaborationExecutionHandoff` keeps the list visible, explains that it needs an update, and will
not start a new task that still contains backups, so the list is not silently dropped. An existing
conversation keeps its saved backups and locks edits. Quick enable uses the same check and opens
the form instead of starting when the host cannot hand off.
Planning is off for a first task. Turning it on also exposes **Require plan approval**, off by default. Rework limit,
time budget and the role-instructions entry sit under **Advanced settings**, collapsed by default;
the collapsed row shows the chosen rework limit and time budget, so folding it never hides them.
A model's thinking level expands with the model. Select each role's provider and model directly in
the dialog; you do not need saved Agent profiles. The first task's execution model inherits the
conversation's current provider, model and thinking level; review is chosen explicitly. The dialog
remembers, per host and on this device, planning, plan approval, isolation, models, thinking levels,
backup models, rework limit and time budget of the last task you started. The review agent leads the conversation and performs
the final review; when planning is on, it also prepares the plan. Implementation always runs in a
separate session. Enabling in an existing chat retains its identity when its model and thinking
level match the review selection. Otherwise, a new main conversation receives the original chat’s
curated history as context; the original chat remains available. Historical requests never start a
task automatically.

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
Implementation sessions appear as children of the main conversation. Existing tasks retain their
saved lead and any separate review session. Closing a session does not discard a task. See [agent lifecycle](agent-lifecycle.md).

## Planning

Collaboration uses one execution, review and acceptance loop. **Plan first** adds a planning step
before implementation. Use it when scope, interfaces or acceptance criteria need deciding first.
Without planning, the complete goal goes to one implementer. The review agent handles the main
conversation, dispatch and final review in both cases, independently of the implementation session.
Final user acceptance is required after review.

Planning belongs to the task. Once execution starts, use a new conversation to change it. Existing
tasks retain their saved configuration. The persisted and wire mode values remain `full` for
planning and `execute_review` for direct execution so older clients and checkpoints still parse.
Reviewer-led collaboration requires a host advertising `collaborationUnified`; an older host shows
an update prompt. Legacy tasks without `reviewerAsLead` keep their original session ownership.

The **Instructions** action under **Advanced settings** opens host settings and preserves the goal,
planning and model selections. Save or return from settings to reopen the picker over the original conversation.
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

When planning is on, plan approval is optional. Final user acceptance is required even after the AI approves the
result. When a task has used every rework and the final review still requests changes, the run
goes to acceptance with that review instead of stopping: the main Agent lists the findings and you
accept, reject, or request changes, which starts a new round with a fresh rework budget. Approval tools verify the latest real user message and the version of the confirmation
shown in that conversation. Background notices and worker output cannot approve a plan or result.
The plan approval card shows the saved plan expanded above its approval button: summary,
architecture, acceptance criteria and each implementation task's description, files, criteria
and dependencies. You can collapse and reopen it; it remains in the conversation after approval.
Read this snapshot before approving, rather than relying on the main Agent's brief reply.
The buttons on the pending approval or acceptance card send the same exact reply as a user
message, so they pass the same check; the host reports which notice is pending
(`confirmation.noticeId` in collaboration status) so only that card shows them.

Choose **Accept and merge** on the final card, or reply `验收并合并`, to accept the result,
commit the reviewed changes and merge into the exact local branch you started from. The host
performs delivery, so you stay in the same conversation and do not copy worktree paths or branch
names. It never pushes or deploys. The final card offers **Accept and merge** and **Reject**;
merging requires a host supporting delivery and a recorded target branch. Replying `验收通过` only accepts the result; afterward you
can reply `合并成果` in the same conversation to deliver it. Delivery includes the whole reviewed
snapshot, including pre-existing changes reviewed in Local mode. Inspect that diff before accepting.
For older tasks or detached HEAD without a recorded launch branch, reply `合并成果到 <branch>` once
after accepting to select the local target. Changed code, a dirty target checkout or a merge
conflict stops delivery and preserves the result. The main Agent takes over the failed merge in
the same conversation, using the host's recovery context to locate both workspaces and branches.
Your delivery authorization covers this repair. It may resolve conflicts in the result branch,
isolate and restore your pending changes, or fix a Git/environment blocker. It must preserve your
work and cannot push, deploy, or implement extra features. Pause or cancel stops the repair.
If the accepted snapshot is unchanged, finishing repair retries delivery. Changed source goes
through implementation verification, review and your acceptance again before it reaches the
target branch. The repair owns both checkouts until it finishes or is canceled; other
collaboration tasks cannot claim them while it is repairing or paused.

Acceptance and merging keep the main conversation open. You can ask questions about the result
without starting another round. To fix an omission or change the result, describe it in that same
conversation. The main Agent requests changes on the existing task, retaining its goal, workspace,
branch and role sessions. The next round goes through execution, review and your acceptance again;
the previous acceptance does not authorize merging the new changes.

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

The time budget bounds how long a run keeps going without you. It counts only running time:
paused, blocked (needs attention), waiting for permission and awaiting acceptance time is free; the
engine meters this at each control change (`runningSince`, `budgetUsedMs`). When the budget is used
up the run stops and waits for you. Approving the plan, resuming, retrying, **Switch model and
continue**, revising and requesting changes each start it over, because a run continued near the
limit would otherwise stop again within minutes. Automatic backup-model handoffs do not. Runs saved
before metering start with an empty budget.

The step limit (30 minutes) catches a stuck step, so it counts from the session's last activity. A
step that keeps working runs until it finishes or the time budget runs out; a silent one is stopped
and waits for retry.

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
themselves after 30 seconds, 2 minutes and 5 minutes before the run needs attention. They do not
change the model. Authentication failures, unpaid balance, invalid requests, a bare 429 or
`RESOURCE_EXHAUSTED`, an ordinary rate limit, assistant text, and tool errors stop for attention
and do not switch models. A clear quota exhaustion on an implementation step keeps the task,
branch, workspace, and completed work. With no backups, or when every backup is unavailable or
also out of quota, the run needs attention and the current stage offers **Switch model and
continue**. The same action is in that conversation's history menu. Older stage rows do not keep
the button. Choosing a model and thinking level sends one `run.switch_executor` request. Repeating
the same provider, model, and thinking level reuses that request id, including after a network or
stop error. Choosing a different provider, model, or thinking level starts a new request id and
still uses the current operation token. A request id cannot be reused for a different target. The
previous execution session must stop before the replacement starts. If it does not stop, nothing
new is started and the progress remains. With backups saved
for that execution profile, the host tries them in order, skipping a provider it already tried in
this chain and any model the host cannot run. Later implementation steps and rework use the model
that took over. The original role instructions stay with the logical execution profile. Pause and
cancel still win over a switch. Planning and review do not hand off on quota.

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

Role-instruction changes apply to future conversations. Existing conversations and tasks retain
their saved configuration so editing instructions cannot change an operation midway through execution.
The host refreshes its built-in workflow rules when a saved main chat resumes, preserving your
added instructions. It does not reload an active chat to replace those rules.
