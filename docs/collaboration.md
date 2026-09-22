# Collaboration

Enable collaboration from a workspace's command palette or type `/director` in an existing
conversation. `/director <goal>` also supplies the first request. Host settings → Collaboration
selects the lead, implementation and optional review profiles. With no separate reviewer, the lead
performs the final review. Configure native agent profiles first.

Collaboration runs inside the daemon. It uses the existing agent creation, tool injection,
permissions, timeline and parent/child lifecycle. Providers must have Paseo tools enabled.
The main conversation keeps its identity; implementation and separate review sessions appear as
its children. Closing a session does not discard a task. See [agent lifecycle](agent-lifecycle.md).

## Execution and confirmation

Tasks execute serially in dependency order within one workspace. Starting a task creates a
`director/<run-id>` branch while retaining staged, unstaged and untracked changes. Use a separate
Paseo workspace first when you want isolation. A repository must have an initial commit and no
unresolved merge conflicts.

Plan approval is optional. Final user acceptance is required even after the AI approves the
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
