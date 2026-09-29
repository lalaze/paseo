# Delegation

Mention another agent in a message and your agent delegates that part of the work to it. The
design follows [codeg](https://github.com/xintaofei/codeg)'s `@` delegation: no scheduler, no
modes, no approval gates. The agent you are talking to decides how to split the work, and each
delegated agent runs as its [subagent](agent-lifecycle.md#the-subagents-track).

Delegation is independent of [collaboration](collaboration.md). It shares no state, settings or
tools with it, and both can be on at once.

## Mentioning an agent

Type `@` in the composer. Enabled providers are listed above workspace files, filtered by what you
type. Picking one inserts `[@Codex](paseo://agent/codex)`; the sent message shows it as `@Codex`.
Mention two agents and they get one delegation each and run side by side.

The mention is plain text the agent reads. Nothing out of band tells the daemon to delegate: the
agent sees the link, and both the `delegate_to_agent` description and the MCP server
`instructions` tell it that a mention is an explicit instruction to delegate. The instructions
matter because Claude Code defers MCP tool schemas, so it may not have read the tool description
when the message arrives. Providers that take the in-process tool catalog get only the tool
description.

The app offers agents only on hosts that report `server_info.features.delegation`.

## Tools

`packages/server/src/server/agent/tools/delegation-tools.ts` registers three agent-scoped tools:

| Tool                    | What it does                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `delegate_to_agent`     | Creates a subagent in the caller's workspace with the task as its first prompt. Returns at once with a `taskId`. |
| `get_delegation_status` | Snapshot of several tasks, or a wait that returns when any task ends or newly needs permission.                  |
| `cancel_delegation`     | Stops a running task. A finished task is left alone and its result is returned.                                  |

A `taskId` is the child agent id, so a follow-up in the same session is `send_agent_prompt` with
that id. The child starts cold: it cannot see the parent's conversation, so the task has to carry
everything. The caller is also notified when a child finishes, errors or asks for permission,
through the normal `notifyOnFinish` path.

A wait wakes once per permission prompt. Without that, a caller that waits again while a child is
still blocked would return immediately in a loop.

## Settings

Host settings → **Delegation** holds three settings, persisted in `config.json`
under `agents.delegation`:

- **Allow delegation** — on by default.
- **Delegation depth** — how many levels may delegate. The default, 1, lets only root agents
  delegate; their children do not get the tools.
- **Agent defaults** — the model and mode a delegated agent of each provider starts with. Without
  them the provider's default model applies and the mode is resolved against the parent, as for
  `create_agent`.

Agent MCP sessions are stateless and build a fresh tool catalog per request, so a settings change
applies to the next tool call. The tools are registered only while delegation is on and the caller
is under the depth limit. The provider also needs Paseo tools enabled.

## Gotchas

- **Canceled is a label.** Cancel stamps `paseo.delegation.canceled-at` and stops the run. A task
  reads as canceled only while no prompt arrived after that time, so a follow-up turn after a
  cancel reports normally.
- **Patch schemas carry no defaults.** Zod applies `.default()` inside `.partial()`, so a patch
  built from the full delegation schema would reset every field it leaves out.
  `MutableDelegationConfigPatchSchema` has none for that reason, and the store replaces
  `agentDefaults` wholesale so clearing one removes it.
