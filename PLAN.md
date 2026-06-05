# Plan

## Question tree: current IDE selection in model context

- [x] 1. Trigger: when should selection be sent?
  - Decision: selection is ambient context per user-submitted turn when a non-empty IDE selection exists; snapshot at submit, not live mid-turn.
- [x] 2. Persistence: should selection enter session history?
  - Decision: no; selection snapshot is transient model context only, never appended to session history.
- [x] 3. Shape: reference-only vs selected text payload?
  - Decision: send path + line range; include selected text only when selection spans fewer than 3 lines.
- [x] 4. Placement: where in model input?
  - Decision: inject via Pi `context` hook as transient custom/user message after latest user prompt; avoid system prompt and provider-payload mutation.
- [x] 5. Freshness: snapshot time and stale behavior?
  - Decision: snapshot at user submit; reuse same snapshot across provider calls in that user turn; omit if IDE reports empty selection.
- [x] 6. Size limits and privacy controls?
  - Decision: ambient selection context defaults on; add `/ide` toggle to disable.
- [x] 7. Provider cache impact?
  - Decision: skip prototype now; path/range suffix is small enough, inspect cache later if needed.
- [x] 8. Implementation hook in Pi?
  - Decision: use `before_agent_start`/input-time snapshot state plus `context` event transient injection.
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
- [x] Inject transient selection context in `context` hook without appending session entries.
- [x] Format compact XML-ish `<ide file="..." lines="...">`; include raw `<selected>` only for 1-2 lines and <=2KB; no omission marker.
- [x] Keep ambient hint via compact `<ide>` tag only; no tool mention.
- [x] Normalize at-mention refs to 1-based lines.
- [x] Hide footer selection when selection context disabled.
- [x] Typecheck.
