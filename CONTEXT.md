# Lovely IDE Context

Terminology for how pi-lovely-ide exposes IDE state to the coding agent.

## Language

**IDE Selection**:
The active non-empty text range reported by the connected IDE, including file path and range; may include selected text.
_Avoid_: cursor, editor state, selection update

**Selection Snapshot**:
The file path and 1-based line range captured from the IDE Selection at user submit, with selected text included only for one- or two-line selections up to 2KB.
_Avoid_: live selection, character-counted selection, current selection during turn

**Selection Context**:
Transient model context built from a Selection Snapshot for an initial idle user prompt.
_Avoid_: message history, at mention, live IDE state

**At Mention**:
An explicit IDE-originated 1-based file/range reference inserted into the user's editor message.
_Avoid_: selection context, ambient context

## Relationships

- A **Selection Snapshot** is captured from at most one **IDE Selection** per user-submitted turn and includes selected text only when the selection spans fewer than three lines and is no larger than 2KB.
- **Selection Context** is transient and is not stored in message history.
- An **At Mention** is user-authored message text; **Selection Context** is ambient model context.

## Example dialogue

> **Dev:** "If I move my cursor while the agent is running, should the model see the new IDE Selection?"
> **Domain expert:** "No — Selection Context only uses the Selection Snapshot from the initial idle prompt."

## Flagged ambiguities

- "current selection" can mean live IDE state or turn-scoped **Selection Snapshot** — resolved: model context uses **Selection Snapshot**.
- Character range looked precise but is rejected for model-facing context because models count characters poorly.
