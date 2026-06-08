# Plan

## Question tree: current IDE selection in model context

- [x] 1. Trigger: when should selection be sent?
  - Decision: selection is ambient context per user-submitted turn when a non-empty IDE selection exists; snapshot at submit, not live mid-turn.
- [x] 2. Persistence: should selection enter session history?
  - Decision: store a hidden details-only `lovely-ide.selection` custom marker; extension projects it into model context and removes marker from LLM-visible messages.
- [x] 3. Shape: reference-only vs selected text payload?
  - Decision: send path + line range; include selected text only when selection spans fewer than 3 lines.
- [x] 4. Placement: where in model input?
  - Decision: inject via Pi `context` hook by appending selection context onto the preceding user message content; avoid system prompt and provider-payload mutation.
- [x] 5. Freshness: snapshot time and stale behavior?
  - Decision: snapshot at user submit; reuse same snapshot across provider calls in that user turn; omit if IDE reports empty selection.
- [x] 6. Size limits and privacy controls?
  - Decision: ambient selection context defaults on; add `/ide` toggle to disable.
- [x] 7. Provider cache impact?
  - Decision: skip prototype now; path/range suffix is small enough, inspect cache later if needed.
- [x] 8. Implementation hook in Pi?
  - Decision: use `input` snapshot, `before_agent_start` hidden custom marker, and `context` projection into the previous user message.
- [x] 9. Small-selection text cap?
  - Decision: include selected text only when line count is 1-2 and UTF-8 size is <=2KB; otherwise omit text.
- [x] 10. Line numbering/range semantics?
  - Decision: model-facing ranges are 1-based lines; if IDE `end.character` is 0, final selected line is `end.line - 1`.
- [x] 11. Snapshot wording?
  - Decision: keep wording compact; `<ide>` tag conveys ambient IDE context; do not mention tools.
- [x] 12. Streaming queued prompts?
  - Decision: only initial idle interactive/RPC prompts get selection snapshots; steering/follow-up queued while streaming do not.
- [x] 13. At-mention line numbering?
  - Decision: normalize at-mention refs to 1-based lines too.
- [x] 14. Footer/status when selection context disabled?
  - Decision: hide selection in footer when ambient selection context is disabled.
- [x] 15. Exact selection context format?
  - Decision: compact XML-ish `<ide file="..." lines="...">`; use `<selected>` child when text included; no Markdown fence.
- [x] 16. Selected text language/fencing?
  - Decision: no code fence/language hint; raw selected text inside `<selected>` tag.
- [x] 17. Escaping?
  - Decision: do not XML-escape selected text; this is LLM input, not strict XML.
- [x] 18. Omission marker?
  - Decision: omit `<selected>` entirely when selected text is not included; no omission marker.

## Next implementation sketch

- [x] Add selection-context config toggle in `/ide`, default on.
- [x] Snapshot latest non-empty selection for initial idle interactive/RPC prompts only.
- [x] Store hidden details-only selection marker, then project latest marker into user prompt in `context`.
- [x] Format compact XML-ish `<ide file="..." lines="...">`; include raw `<selected>` only for 1-2 lines and <=2KB; no omission marker.
- [x] Keep ambient hint via compact `<ide>` tag only; no tool mention.
- [x] Normalize at-mention refs to 1-based lines.
- [x] Hide footer selection when selection context disabled.
- [x] Typecheck.

## Debug raw IDE notifications

- [x] Add persisted `/ide` toggle for raw IDE notification debug, default off.
- [x] Surface raw incoming JSON-RPC notifications as display-only custom messages, capped at 4KB.
- [x] Pretty-print and syntax-highlight debug JSON with Pi JSON highlighter.
- [x] Strip debug messages from model context.
- [x] Typecheck.

## Next cleanup/refactor

- [x] Add direct `typebox` dependency for runtime validation.
- [x] Use TypeBox at JSON boundaries: config file, lockfile, WebSocket JSON-RPC params.
- [x] Split config parsing/persistence into `ConfigState`.
- [x] Split IDE Selection + turn snapshot lifecycle into `SelectionState`.
- [x] Move `/ide` command UI into its own module.
- [x] Keep WebSocket discovery/connect/reconnect in extension entrypoint.
