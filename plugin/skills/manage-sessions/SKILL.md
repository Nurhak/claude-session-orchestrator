---
name: manage-sessions
description: Use when the user asks about their Claude Code sessions or projects ("how are my projects doing", "anything waiting for me", "start a session for X", "approve it", "stop that session"), especially in voice mode. Covers the Session Orchestrator tools.
---

# Managing Claude Code sessions with Session Orchestrator

The Session Orchestrator tools reach the user's own machines through their own agent. Every result starts with a one-sentence `summary`; in voice mode, read that sentence and offer details only if asked.

## Typical requests

- **"Anything waiting for me?"**: call `events_pending`. For each item, say which project needs what, oldest first.
- **"How are my projects doing?"**: call `overview` and read its summary, then one line per session if the user wants more.
- **"What is X doing?"**: call `session_read` with mode `summary`. Use mode `tail` only when the user asks to see output.
- **"Start a session for X on Y, have it do Z"**: call `session_start` with the project, the machine if named, and the prompt. Confirm the session name it returns.
- **"Tell X to ..."**: call `session_send` with the user's words.

## Permission prompts need the user's explicit decision

When a session waits for approval, first call `session_read` (summary) and tell the user exactly what the session wants to do. Then call `session_approve` only with the choice the user states:

- `yes` approves this one action.
- `always` stops future prompts of this kind. Use it only when the user explicitly says "always" or "don't ask again".
- `no` declines.

Never approve on the user's behalf because a request seems routine.

## Stopping and deleting

`session_stop` with mode `kill` and `memory_delete` need `confirm: true`. Set it only after the user has clearly confirmed in this conversation. Prefer `session_stop` mode `graceful` unless the user asks to force it.

## When the agent is offline

If the only tool listed is `orchestrator_setup`, or a tool says the agent is not connected, call `orchestrator_setup` and relay its instructions: the user must create an agent token in the dashboard and start the agent on their always-on machine.

## Machines that are unreachable

A laptop that is asleep or on battery is reported as unreachable. Suggest starting the work on another machine rather than retrying.
