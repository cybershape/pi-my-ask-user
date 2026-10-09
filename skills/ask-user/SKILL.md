---
name: ask-user
description: "You MUST use this before high-stakes architectural decisions, irreversible changes, or when requirements are ambiguous. Runs a decision handshake with the ask_user_question tool: summarize context, present structured options, collect explicit user choice, then proceed."
metadata:
  short-description: Decision gate for ambiguity and high-stakes choices
---

# Ask User Decision Gate

Use this skill to force explicit user alignment before consequential decisions.

This skill is about **decision control**, not general chit-chat.

## Non-negotiable rule

Invoke `ask_user_question` before proceeding when **any** of the following is true:

1. The next step changes architecture, schema, API contracts, deployment strategy, or security posture.
2. The work is costly to undo (large refactor, migration, destructive edit, production-facing behavior change).
3. Requirements, constraints, or success criteria are unclear, conflicting, or missing.
4. Multiple valid options exist and the trade-off is preference-dependent.
5. You are about to assume something that can materially change implementation.

Do **not** skip this gate unless the user has already provided a clear, explicit decision for the exact trade-off.

## Agent Protocol Handshake (required)

Follow this handshake in order.

### 1) Detect boundary
Classify the current step as:
- `high_stakes`
- `ambiguous`
- `both`
- `clear` (no gate needed)

If classification is not `clear`, continue.

### 2) Gather evidence first
Before asking, gather context from available tools (`read`, `bash`, `exa`, `ref`, etc.).
Do not ask the user to decide blind.

### 3) Synthesize context
Write a short neutral summary (3-7 bullets or short paragraph) covering:
- current state
- key constraints
- trade-offs
- recommendation (if any)

The tool has no `context` field, so put this summary in your own message **before** the call.
The prompt shows only the `header`, the `question`, and the option labels and descriptions.

### 4) Ask one focused question
Call `ask_user_question` with a required `questions` array. Use one entry for one decision:

- `question`: concrete decision prompt
- `header`: short group label shown in the prompt's top border, above the question, e.g. `Storage`, `Deploy target`. Keep it brief; a long header is ellipsised on narrow terminals
- `options`: **2-4** entries, each with a required `label` and a required `description`
  - `label` is the value returned when the user picks it, and must be unique within the question
  - `label` may not be `Other`, `Type something.`, or `Next` — the prompt adds its own free-form row
  - `description` explains the trade-off in one line
  - `preview` *(optional)* is a longer body shown beside the option on wide terminals
- `multiSelect` *(optional)*: `true` only when independent selections are genuinely needed

Display, layout, shortcuts and timeout are user preferences configured through
`/ask-user-question-settings`, never tool parameters. Do not send them in a call.

When 2-4 decisions at the same boundary are independent of each other and their prerequisites
are settled, you may ask them together as 2-4 entries of `questions`. Never batch a decision
whose options depend on another answer; ask it in a later call once that answer is known.

### 5) Commit the decision
After response:
- restate the decision in plain language
- state what will be done next
- proceed with implementation

### 6) Re-open only on new ambiguity
Ask again only if materially new uncertainty appears.
Avoid repetitive confirmation loops.

## Reading the answer

`details.answers` holds one entry per question the user actually answered, each with:

- `question`: the question text it answers
- `kind`: `option` (one label picked), `multi` (several labels picked), or `custom` (free-form row used)
- `answer`: the chosen label, or the typed text for `custom`, or `null` for `multi`
- `selected`: the chosen labels, present only for `multi`; when the user also wrote free text on the ticked free-form row it is appended as the final entry

Questions the user left unanswered on the review page are dropped, so `answers` can be shorter
than the questions you sent. Treat a missing answer as unanswered rather than as agreement.
`cancelled: true` means the whole prompt was dismissed.

## Anti-overasking guardrails (required)

Apply a strict question budget per decision boundary:

- **Max 1** `ask_user_question` call per decision boundary in normal cases.
- **Max 2** `ask_user_question` calls for the same boundary when first response is unclear/cancelled.
- Never ask the same trade-off again without new evidence.

Escalation ladder:

1. **Attempt 1:** structured options + a concise summary in your own message.
2. **Attempt 2 (only if needed):** narrower question with agent recommendation and explicit choices:
   - `Proceed with recommended option`
   - `Choose another option`
   - `Stop for now`

After attempt 2:

- If boundary is `high_stakes` or `both`: **stop and mark blocked**. Do not keep asking.
- If boundary is `ambiguous` only and user says “your call” or equivalent: proceed with the most reversible default and state assumptions explicitly.

## `ask_user_question` payload quality standard

### Question quality
Use:
- “Which option should we adopt for X?”
- “Do you want A (fast) or B (safer) for Y?”

Avoid:
- broad/open prompts with no decision boundary
- multiple unrelated decisions in one question
- questions that should be answered by reading code/docs first

### Option quality
Options must be:
- mutually understandable
- short and outcome-oriented
- explicit on trade-offs

Every option needs a description that states what choosing it means. Use `preview` when the
user genuinely needs to read a longer body before deciding.

## Recommended patterns

### Single-select architecture decision

```json
{
  "questions": [
    {
      "question": "Which caching strategy should we use for the first release?",
      "header": "Caching",
      "options": [
        { "label": "In-memory cache", "description": "Simpler rollout, weaker horizontal consistency" },
        { "label": "Redis cache", "description": "Better consistency and scalability, more ops overhead" }
      ]
    }
  ]
}
```

### Multi-select when decisions are independent

```json
{
  "questions": [
    {
      "question": "Select the first-wave hardening items to implement now.",
      "header": "Hardening",
      "options": [
        { "label": "Rate limiting", "description": "Blocks abuse before it reaches the app" },
        { "label": "Audit logging", "description": "Traces who changed what, for compliance" },
        { "label": "Input schema validation", "description": "Rejects malformed payloads at the edge" },
        { "label": "Secrets rotation", "description": "Limits blast radius of a leaked credential" }
      ],
      "multiSelect": true
    }
  ]
}
```

### Independent decisions at one checkpoint

```json
{
  "questions": [
    {
      "question": "Which logging backend should the service use?",
      "header": "Logging",
      "options": [
        { "label": "Self-hosted Loki", "description": "No new vendor, more ops work" },
        { "label": "Hosted Datadog", "description": "Fastest setup, recurring cost" }
      ]
    },
    {
      "question": "Should the first release include the admin dashboard?",
      "header": "Scope",
      "options": [
        { "label": "Include it", "description": "Support can self-serve from day one" },
        { "label": "Defer it", "description": "Ships sooner, support escalates to engineering" }
      ]
    }
  ]
}
```

## Anti-patterns

- Asking `ask_user_question` without first gathering context
- Putting the context summary in an option description instead of your own message
- Using it for trivial formatting choices
- Sending 1 option, or 5+ options, or options without descriptions
- Using a reserved label (`Other`, `Type something.`, `Next`) as an option
- Asking the same question repeatedly without new information
- Batching dependent decisions in `questions`, or using a batch to dodge the one-decision-per-question rule
- Passing `displayMode`, `singleSelectLayout`, `overlayToggleKey`, or `timeout` in a call
- Proceeding with high-stakes implementation after unclear/cancelled answer
- Treating a question dropped from `answers` as if the user agreed

## If user cancels or answer is unclear

Pause execution and explain what is blocked.
Use at most one narrower follow-up `ask_user_question` question (attempt 2).
After that, do not continue asking in a loop:
- for high-stakes decisions: remain blocked until explicit decision
- for ambiguity-only decisions: proceed only if user delegated the choice ("your call")

## Additional reference

For full trigger matrix, UX conventions, and extension interaction details, read:
- `references/ask-user-skill-extension-spec.md`
