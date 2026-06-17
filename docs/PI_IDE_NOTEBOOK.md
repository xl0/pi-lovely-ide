Need split 2 concerns:

 1. execution transport in IDE protocol
 2. actual notebook control in VS Code ext

 My take: keep execution IDE-owned, not file-json-owned. Notebook repo stays source/output mutation tools. VS Code ext becomes runtime bridge to live notebook kernel/UI.

 Core shape

 Add IDE tool calls over current WebSocket.
 Current protocol only has:

 - Pi -> hello, ping
 - IDE -> event

 For notebook exec, need reverse direction too:

 - Pi -> IDE: toolCall request
 - IDE -> Pi: toolResult response
 - optional IDE -> Pi: toolUpdate notification for progress/streaming

 Minimal. No generic RPC framework beyond JSON-RPC you already use.

 Why this shape

 Notebook execution is not file edit. It depends on:

 - open notebook editor
 - selected kernel
 - live VS Code notebook controller
 - cell execution lifecycle
 - output objects in memory/UI

 Trying to fake this from .ipynb JSON repo side bad.
 Execution belongs in VS Code ext.

 First-pass scope

 Keep v1 small. Do one tool first:

 - notebook_execute_cell

 Maybe second if cheap:

 - notebook_execute_cells with array of selectors

 Skip restart kernel / interrupt / run all / create kernel abstractions first pass.

 Proposed tool contract

 ### notebook_execute_cell

 Params:

 ```ts
   {
     path: string
     cellId?: string
     index?: number
     mode?: "run" | "runAndWait" // default runAndWait
     timeoutMs?: number
   }
 ```

 Result:

 ```ts
   {
     path: string
     cellId?: string
     index: number
     executionState: "success" | "error" | "cancelled" | "timeout"
     kernel?: { id?: string; label?: string }
     outputsChanged: boolean
     executionOrder?: number | null
     summary?: string
   }
 ```

 Maybe include lightweight output summary if cheap.
 Do not stream full outputs through protocol first pass. Pi can read saved notebook via notebook tools after run.

 Required protocol changes

 Add to shared protocol package:

 - new request kind from Pi to IDE: toolCall
 - new response schema/result union
 - maybe optional capabilities in hello response:
     - tools?: ["notebook_execute_cell"]

 Why capabilities:
 - Pi ext can discover whether connected IDE supports exec
 - future-proof for more IDE tools

 I’d add capabilities now. Cheap.

 VS Code extension plan

 ### 1. Track notebook documents/editors better

 Current ext only maps notebook cell doc via activeNotebookEditor. Too weak for execution.

 Need registry helpers:

 - find notebook doc by .ipynb path
 - find/open notebook editor for path
 - resolve cell by cellId or index
 - map VS Code notebook cells -> stable selector
 - maybe read cell metadata.id when present, else index only

 Need listen to:

 - window.onDidChangeActiveNotebookEditor
 - maybe workspace.onDidOpenNotebookDocument
 - maybe workspace.onDidCloseNotebookDocument

 Can keep registry lazy if simpler: search workspace.notebookDocuments each call.

 ### 2. Open notebook if needed

 Execution req on closed notebook should still work.

 Plan:

 - vscode.workspace.openNotebookDocument(pathUri)
 - vscode.window.showNotebookDocument(doc, { preserveFocus: true, preview: false })

 Need editor because execution commands usually target visible/open notebook better than raw doc-only APIs.

 ### 3. Reuse VS Code built-ins first

 Best first pass: drive built-in notebook commands, not custom kernel abstraction.

 Likely commands:

 - notebook.cell.execute
 - maybe notebook.execute
 - maybe cell-range variant depending API/command availability

 Approach:

 - focus target notebook editor
 - set notebook selection to target cell
 - invoke built-in execute command
 - wait for cell state/output completion

 This is less elegant than controller APIs, but much smaller and aligned with VS Code/Jupyter behavior.

 ### 4. Wait for completion by observing notebook events

 Need execution completion watcher.

 Listen to notebook doc/editor changes:

 - outputs changed
 - execution summary/order changed
 - maybe cell metadata changes

 Completion heuristic first pass:

 - snapshot target cell before run
 - start execute command
 - wait until cell leaves pending/running state and outputs/execution summary settle
 - classify:
     - success -> execution completed, no error output marker
     - error -> output contains error output
     - cancelled -> command aborted / state ends weird
     - timeout -> local timer

 Need one in-flight execution tracker per notebook/cell.

 ### 5. Return result, not outputs

 Keep protocol/result tiny:

 - selector resolved
 - final status
 - output count changed?
 - execution order
 - short summary line

 Then Pi side can say:
 - execution done
 - if needed use notebook_summary / notebook_read_cell_output

 This avoids duplicating notebook output serialization in protocol first pass.

 ### 6. Save notebook after execution

 Important. If execution mutates outputs in memory only, notebook tools reading file may miss them.

 After completion:

 - call notebook.save or save specific notebook doc
 - maybe only if dirty

 Need this in first pass. Else whole thing useless for Pi toolchain.

 ### 7. Handle kernel absence explicitly

 If no kernel/controller selected:

 - fail clear
 - message like "No kernel selected for notebook"

 Do not auto-pick kernel first pass. Too much policy.

 ### 8. Handle selector semantics same as notebook tools

 Match notebook repo conventions:

 - exactly one of cellId or index
 - cellId preferred when notebook has stored ids
 - index fallback for no-id notebooks

 This keeps model mental model aligned.

 Pi-side implications

 Even though you asked VS Code side, Pi side needs thin glue:

 - if IDE hello says tool capability present, register local tool facade:
     - ide_notebook_execute_cell or plain notebook_execute_cell
 - facade sends protocol toolCall to current IDE conn
 - returns IDE result
 - maybe tool guidelines:
     - execute cell, then inspect outputs with notebook tools

 I’d keep name namespaced first:
 - ide_notebook_execute_cell

 Reason: avoid confusion with file-backed notebook package.
 Later maybe unify.

 Recommended order

 ### Phase 1 — protocol

 - add capabilities to hello result
 - add Pi->IDE toolCall request + typed result
 - add parser/schema support

 ### Phase 2 — VS Code exec MVP

 - resolve notebook by path
 - open/show notebook
 - resolve cell by selector
 - execute selected cell via built-in command
 - wait for completion
 - save notebook
 - return status

 ### Phase 3 — Pi facade

 - register exec tool only when connected IDE advertises capability
 - route request to active IDE conn
 - expose terse result

 ### Phase 4 — polish

 - better progress updates
 - multi-cell execute
 - interrupt/restart
 - richer error extraction
 - maybe notebook-level selection event improvements

 Main risks

 ### Built-in command awkwardness

 VS Code notebook exec APIs not super clean. Command-driven impl may be brittle. Still best first pass.

 ### Completion detection

 Need reliable “done” signal. This is hardest part. Keep heuristics narrow, test against Jupyter ext.

 ### In-memory vs on-disk divergence

 Must save after run.

 ### Cell ids in VS Code

 Notebook cell metadata.id may not always match raw nbformat id. Need verify on real Jupyter notebooks. If mismatch, index selector becomes fallback truth.

 One thing I would not do

 Do not move execution into pi-lovely-notebook repo first.
 Wrong layer. That repo owns .ipynb structure. VS Code ext owns live notebook runtime.

 Concrete first-pass acceptance bar

 From Pi session connected to VS Code:

 1. call exec tool with notebook path + cell selector
 2. VS Code opens notebook if needed
 3. target cell runs in current kernel
 4. ext waits until done/fail
 5. notebook saved
 6. Pi can immediately inspect outputs via existing notebook tools

 That enough for v1.

 If you want, next step I can turn this into:
 - protocol message sketch
 - exact VS Code API/command candidates
 - implementation checklist by file for packages/protocol, ide-plugins/vscode, Pi ext only.