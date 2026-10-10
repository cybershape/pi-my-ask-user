---
name: ask-before-acting
description: "You MUST use this before high-stakes architectural decisions, irreversible changes, or when requirements are ambiguous. Runs a decision handshake with the ask_user_question tool: summarize context, present structured options, collect explicit user choice, then proceed."
metadata:
  short-description: Decision gate for ambiguity and high-stakes choices
---

# Ask Before Acting

Use this skill to force explicit user alignment before consequential decisions.

This skill is about **decision control**, not general chit-chat. The tool schema and prompt guidelines already define the payload. Follow them. This skill only says when to stop, what to put in your own message, and how to read the result.

## When to ask

Invoke `ask_user_question` before proceeding when **any** of the following is true:

1. The next step changes architecture, schema, API contracts, deployment strategy, or security posture.
2. The work is costly to undo (large refactor, migration, destructive edit, production-facing behavior change).
3. Requirements, constraints, or success criteria are unclear, conflicting, or missing.
4. Multiple valid options exist and the trade-off is preference-dependent.
5. You are about to assume something that can materially change implementation.

Do **not** ask when the user has already given a clear decision for this exact trade-off, or when the choice is trivial (formatting, or a local refactor that does not change behavior).

## Before the call

Gather evidence with the tools you already have. Do not ask the user to decide blind.

Then write a short neutral summary in your own message, before the tool call:

- current state
- key constraints
- trade-offs
- recommendation, if any

The tool has no `context` field. The prompt shows only the `header`, the `question`, and the option labels and descriptions. Do not put that summary in an option description.

Ask one focused question. Two to four questions may share one call only when they are independent and their prerequisites are already settled. Never batch a decision whose options depend on another answer.

## Reading the answer

`details.answers` is the source of truth. The text content is lossy: multi-select values are comma-joined, and skipped questions disappear.

Each entry:

- `question`: the question text it answers
- `kind`: `option` (one label), `multi` (several labels), or `custom` (free-form row)
- `answer`: the chosen label, the typed text for `custom`, or `null` for `multi`
- `selected`: present only for `multi`. Free text typed on the ticked free-form row is the final entry

Unanswered questions are omitted, so `answers` can be shorter than `questions`. Match on `question` text. A missing entry is unanswered, not agreement. `cancelled: true` means the whole prompt produced no decision, including when it was dismissed, timed out, or aborted.

Restate the decision in plain language, say what you will do next, and proceed.

## Stop asking

One call per decision boundary. If the answer is unclear or cancelled, at most one narrower follow-up. Do not ask the same trade-off again without new evidence.

After that follow-up:

- If the decision is costly to undo, or changes architecture, contracts, or security: stop and say what is blocked. Do not keep asking, and do not implement.
- If the only problem is ambiguity and the user delegates ("your call" or equivalent): proceed with the most reversible default and state the assumptions.

Ask again only when materially new uncertainty appears.
