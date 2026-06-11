# Lovely IDE Context

Terminology for how pi-lovely-ide exposes IDE state to the coding agent.

## Language

**IDE Selection**:
The active file reference reported by the connected IDE, including file path plus optional text range and optional notebook cell address; may include selected text.
_Avoid_: editor state, selection update

**Selection Snapshot**:
The file path, optional Notebook Cell Address, and optional 1-based line range captured from the IDE Selection at user submit, with optional selected text excerpt containing first/last edges and total counts.
_Avoid_: live selection, character-counted selection, current selection during turn

**Selection Context**:
Transient model context built from a Selection Snapshot for an initial idle user prompt.
_Avoid_: message history, at mention, live IDE state

**At Mention**:
An explicit IDE-originated file/range/cell reference inserted into the user's editor message; wire payload uses zero-based line/character range and may include referenced text, while inserted editor text is 1-based.
_Avoid_: selection context, ambient context

**Pi IDE Protocol**:
The pi-native local IDE protocol for editor-originated context events such as selection and mentions. It is not Claude MCP compatibility.
_Avoid_: Claude IDE protocol, MCP protocol

**Claude Code Protocol Reference**:
Historical documentation of Claude Code-compatible MCP lockfiles/messages kept for reference while implementation moves to the Pi IDE Protocol.
_Avoid_: native protocol, active adapter

**Pi Instance**:
One Pi process/session in a workspace, identified to the IDE by process PID plus session id/name from Pi's session manager. A Pi Instance may have multiple IDE connections.
_Avoid_: workspace, IDE server

**IDE Connection Subscription**:
The event types a specific Pi IDE WebSocket connection asks the IDE to send, currently `selection` and `mention`.
_Avoid_: capability, tool permission, purpose

**IDE Span**:
One selected or mentioned span in a Pi IDE Protocol event. It may be a text range in a file, a whole notebook cell, or a text range inside a notebook cell; whole-file references use empty `spans` with a non-null file.
_Avoid_: event, connection, serialized notebook range

**Notebook Cell Address**:
Optional cell identity on an IDE Span for notebook files, using zero-based cell index and/or IDE-provided cell id. Ranges inside a notebook cell are relative to cell text, not serialized `.ipynb` JSON.
_Avoid_: file line in notebook JSON

## Relationships

- A **Selection Snapshot** is captured from at most one **IDE Selection** per user-submitted turn and may include a text excerpt supplied by the IDE.
- **Selection Context** is transient and is not stored in message history.
- An **At Mention** is user-authored message text; **Selection Context** is ambient model context.

## Example dialogue

> **Dev:** "If I move my cursor while the agent is running, should the model see the new IDE Selection?"
> **Domain expert:** "No — Selection Context only uses the Selection Snapshot from the initial idle prompt."

## Flagged ambiguities

- "current selection" can mean live IDE state or turn-scoped **Selection Snapshot** — resolved: model context uses **Selection Snapshot**.
- Character range looked precise but is rejected for model-facing context because models count characters poorly.
