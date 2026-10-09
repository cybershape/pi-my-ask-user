# Ask User Skill × Extension Interaction Spec

## Purpose

This document defines a minimal decision-gating protocol for using the `ask-user` skill with the `ask_user_question` tool.

Goal: require explicit user decisions at high-impact or ambiguous boundaries before implementation continues.

---

## 1) Trigger Matrix (When to Call `ask_user_question`)

| Scenario | Must Ask? | Why |
|---|---:|---|
| Architecture trade-off (e.g., queue vs cron, SQL vs KV) | Yes | Preference-sensitive, high blast radius |
| Data schema / migration path selection | Yes | Costly to reverse |
| Security/compliance posture trade-off | Yes | Risk ownership is human |
| Requirements conflict or ambiguity | Yes | Need explicit intent |
| Non-trivial scope cut/prioritization | Yes | Product decision, not purely technical |
| Purely local refactor with identical behavior | Usually no | No policy-level decision |
| Formatting-only edits | No | Trivial |
| User already gave explicit choice for exact trade-off | No (unless new ambiguity) | Decision already captured |

---

## 2) Decision Handshake

Use this protocol whenever the trigger matrix says to ask.

1. **Detect boundary**
   - classify as `high_stakes`, `ambiguous`, `both`, or `clear`
2. **Gather evidence**
   - read code/docs/logs first; do not ask blindly
3. **Summarize context in your own message**
   - write concise trade-off context (3–7 bullets or short paragraph) before the call;
     the tool has no `context` field, so it cannot carry the summary for you
4. **Ask one focused question**
   - call `ask_user_question` for one decision at a time; 2-4 independent decisions with settled prerequisites may go together in `questions`
5. **Commit and proceed**
   - restate chosen option and implement accordingly

### Retry/cancel policy

- Max **2** `ask_user_question` attempts for the same decision boundary.
- Attempt 1: normal structured question.
- Attempt 2: narrower question with recommendation and explicit options.
- After attempt 2:
  - `high_stakes` / `both`: stop and report blocked.
  - `ambiguous` only: proceed only if user delegates (e.g., “your call”), using the most reversible default.

---

## 3) Tool contract

The tool accepts only `questions` at the top level. Never include `displayMode`, `singleSelectLayout`, `overlayToggleKey`, or `timeout` in a tool call.

Users configure these preferences through `/ask-user-question-settings`. Settings persist globally in a dedicated `ask-user-settings.json` file in Pi's user directory. Saved settings override existing environment preferences, which override built-in defaults. `displayMode` defaults to `inline`; layout defaults to `auto`, the overlay shortcut to `alt+o`, and timeout to disabled. Respect user preferences; do not change them without an explicit request.

Each `questions` entry (1-4 entries per call):

| Field | Required | Constraint |
|---|---|---|
| `question` | yes | Non-empty; must be unique across the batch |
| `header` | yes | Non-empty short group label shown in the prompt's top border, above the question. Keep it brief; it is ellipsised on narrow terminals |
| `options` | yes | 2-4 entries |
| `multiSelect` | no | `false` by default |

Each option:

| Field | Required | Constraint |
|---|---|---|
| `label` | yes | Unique within the question; never `Other`, `Type something.`, or `Next` |
| `description` | yes | One line on what choosing it means |
| `preview` | no | Longer body shown beside the option on wide terminals |

The prompt always appends its own free-form row, so never add one yourself — which is why those three labels are rejected.

Calls that violate any rule above are rejected before any UI opens, with a message naming the offending field.

---

## 4) Example payloads

### Architecture decision

```json
{
  "questions": [
    {
      "question": "Which implementation path should we use for v1?",
      "header": "Roadmap",
      "options": [
        { "label": "Path A (ship fast)", "description": "Lowest scope, revisit architecture later", "preview": "Ships in 2 weeks: no plugin hooks, single storage backend, and a migration that must be redone when plugin support lands." },
        { "label": "Path B (extensible)", "description": "Higher initial effort, cleaner long-term composition" }
      ]
    }
  ]
}
```

### Requirement-priority decision

```json
{
  "questions": [
    {
      "question": "Which requirement should be prioritized first?",
      "header": "Priority",
      "options": [
        { "label": "Performance first", "description": "Ship the tuning pass, redesign later" },
        { "label": "UI redesign first", "description": "Visible progress, performance debt stays" },
        { "label": "Minimal pass on both", "description": "Slowest overall, no large debt" }
      ]
    }
  ]
}
```

### Independent decisions at one checkpoint

`questions` carries 1-4 entries. With 2-4 entries the user answers on separate pages and submits
from a review page, where unanswered questions can be submitted as dropped.

- Batch only decisions that are independent and whose prerequisites are settled.
- Treat each entry as its own decision boundary for the retry/cancel policy.
- A missing entry comes back as no answer at all; handle it like an unclear answer for that decision.

---

## 5) Result contract

The tool result's `details`:

```typescript
interface AskAnswer {
  question: string;
  kind: "option" | "custom" | "multi";
  answer: string | null;
  selected?: string[];
}

interface AskResultDetails {
  answers: AskAnswer[];
  cancelled: boolean;
  error?: string;
}
```

Reading it:

- `answers` holds one entry per question the user actually answered, in question order.
- `kind: "option"` → `answer` is the chosen label.
- `kind: "multi"` → `answer` is `null` and `selected` lists the chosen labels.
- `kind: "custom"` → the user took the free-form row; `answer` is their typed text.
- A question the user skipped on the review page is **dropped**, so `answers` can be shorter than `questions`. Treat a missing entry as unanswered, not as agreement.
- `cancelled: true` with `answers: []` means the prompt was dismissed, timed out, or aborted.
- The tool emits no answer or cancellation events; read the result instead.
