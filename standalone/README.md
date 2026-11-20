# LangVision

Standalone agent authoring, conversation, and Historia from Chronusphaera's
Agent Editor and JavaScript LangGraph runtime. Chronusphaera is not a runtime
dependency. The extraction baseline is StreamSQL commit `2a03048`.

## Run locally

With Node.js 24 installed, run these commands from the `standalone/` directory.
Prefer the repository root: `npm run setup` checks for locked SQLite DLLs
before installing, and `npm start` launches the service. See the
[Windows recovery steps](../README.md#recover-from-a-windows-sqlite-lock)
if an older server is still running.

```sh
npm ci
npm run build
npm start
```

Open `http://127.0.0.1:8780`. Use the Agent chat profile settings to connect
Ollama or an OpenAI-compatible API. The latter expects the API base URL
including its version segment, for example `https://example.test/v1`.
Environment bindings use variables prefixed with `LANGVISION_SECRET_`.

The server binds to loopback by default. Use `PORT` to change the port and
`LANGVISION_DB` to set the SQLite path. Back up the database, its adjacent
checkpoint database, and model encryption key. Historia can retain sensitive
tool and model payloads; set `LANGVISION_DEBUG_CAPTURE=off` if this is not
appropriate. Do not share raw execution exports without reviewing them.

For a remote single-operator installation, put the service behind a TLS
reverse proxy that preserves the public Host and Authorization headers,
set `LANGVISION_PUBLIC_ORIGIN` to the exact HTTPS origin, and set a unique
`LANGVISION_OPERATOR_PASSWORD` of at least 24 characters. The Basic Auth
username is `operator`. Keep the Node port private; do not expose it directly.
There is no multi-tenant administration.

## MCP and packages

Create a connection with a trusted Streamable HTTP URL, explicit tool
allowlist, and optional provisioned bearer token from a
`LANGVISION_SECRET_` variable. Enable it and refresh tools. Add the namespaced
tools to the model and Tool nodes in the editor. Remote tool annotations do
not grant permission: the standalone runtime treats all remote calls as
approval-required actions. This version does not perform interactive OAuth
discovery or stdio process launching.

To add a Chronusphaera Speculum widget, prepare `speculum.add_widget` with a
stable request key. A Chronusphaera operator reviews it at that product's
`/mcp-operator`. Then use `chronusphaera.operation_status` and
`chronusphaera.operation_commit` with the returned operation ID. The
standalone approval and product approval are separate. If a response is lost,
check the same operation's status; do not prepare a different mutation.

Packages download as one `.langvision.zip` file containing graph layout,
child graphs, inline skills and prompts, tool/approval settings, and non-secret
model and MCP configuration. Imports produce inactive drafts and disabled
connections with fresh local identities. Rebind model profiles in the editor
and trust and enable intended endpoints before activation. Never paste
credentials into prompt text or skills; package validation rejects credential
fields but cannot identify arbitrary secrets embedded in prose.

## Try the coding agent

Coding Agent is the local system default on startup. The ZIP under
`examples/coding-agent/` is only needed for creating an independent copy
or transferring the workflow. For a first installation, the Ollama URL and
model names can be overridden using `LANGVISION_OLLAMA_URL`,
`LANGVISION_PLANNER_MODEL`, `LANGVISION_INSPECTOR_MODEL`, and
`LANGVISION_CODER_MODEL`. Later, edit saved profiles in the portal.
To use different models, edit each LLM node and select its **Model profile**.
The built-in **Default** connection uses `gpt-oss-120b-32k:latest` with
medium reasoning for planning and inspection. **Coding** uses Qwen3 Coder
Next Q4 on fresh installs for implementation and verification. Existing model selections are preserved. Ollama owns the context
size. The model connection editor refreshes installed models when opened.
Nodes without a selection inherit the
workflow, agent, or workspace profile in that order. Tool and data nodes do not
invoke a model. Approval nodes can select a profile for model-written wording.

New Ollama profiles default to a 15-minute request limit. Set
`LANGVISION_OLLAMA_TIMEOUT_MINUTES` before startup to change the server default
for profiles saved without an explicit timeout. Existing profiles retain their
saved **Request timeout (seconds)**; set it to 900 if needed. Coding turns get
60 minutes of active execution by default (`LANGVISION_CODING_ACTIVE_MINUTES`).
Approval wait does not consume that budget, and neither setting changes the
Docker runner or web tool limits.
Under **Coding Workspace**, enter an existing, dedicated local project folder.
Enable edit requests only if desired. Do not grant a home folder, live profile
folder, or a directory that contains credentials. Access expires after one hour
or when the service stops. The feature is available in local-only mode.

The agent uses local workspace tools for file access and exact approvals for
edits and commands. Commands use Docker with a disposable copy, not a mount
of the source folder. Make sure Docker's Linux engine is running and
`python:3.12-slim` is already cached. Bash and Python work with this image;
for PowerShell commands, set `LANGVISION_CODING_IMAGE` to a locally built image
containing Python, Bash, and PowerShell. The runner never downloads images.

**Web research:** The local Coding Agent can search before implementation and
use `web.fetch` for public text. No external MCP connection is required. To search by keyword, set `LANGVISION_SEARCH_URL` to a trusted SearXNG
`/search` endpoint with JSON results enabled. Restart LangVision. To use
that same research service via optional MCP, add the
connection `web` at `http://127.0.0.1:8780/mcp/research` with allowlist
`search,fetch`. Enable and refresh it, then add `web.search` and `web.fetch`
to the reasoning and Tool nodes. Alternatively set
`LANGVISION_PACKAGE_RESEARCH_URL` to the MCP URL before regenerating the ZIP
to include that disabled connection template. The MCP does not receive
workspace files unless an operator approves the exact request arguments.

For JavaScript-rendered pages, install the pinned Chromium build and opt in
before starting the local portal:

```powershell
node standalone/node_modules/playwright/cli.js install chromium
$env:LANGVISION_WEB_BROWSER = '1'
npm start
```

The browser uses an isolated temporary context. Use `web.navigate` to open a
public URL, `web.snapshot` to inspect the rendered page, `web.follow_link` with a
reference from that snapshot, and `web.close` to release it. A new snapshot
invalidates old references. The search query and initial or follow-up
navigation are reviewed in the portal. Browser network requests are
intercepted and fetched through the public-address policy; private addresses,
standard browser sessions, credentials, downloads and form submission are not
supported. Pages must not be treated as instructions. The separate legacy
research MCP endpoint continues to expose search and fetch only.

**Planning and chat status:** The Coding Agent extracts the request checklist,
plans the approach, and can inspect the grant, research, or ask a focused
clarification before editing. A clarification resumes the same Historia run
and never authorizes a tool. In a node dialog, use **Skills** for editable
reusable instructions and **Chat status updates** for optional lifecycle
messages. Model nodes can also opt into `agent.report_status` on both the model
and its Tool node. These updates are separate from task completion and link
to Historia. On an existing installation, review and activate the upgraded
Coding Agent draft rather than replacing the active revision automatically.
If an existing draft already occupies the editor, use **Agent options →
Add approach planning to draft** to add the new stages to that compatible
draft, then validate and activate when ready.

Rebuild the example ZIP from the repository root with
`node standalone/scripts/package-coding-agent.mjs`. Run the isolated browser
check with `node standalone/tests/coding-agent-smoke.mjs`. Setting
`LANGVISION_REAL_CODING=1` runs the Tetris prompt with a cached Ollama model.
The harness approves only the test folder's file and command operations; do
not point automated approval at a live workspace.

## Verify

Run `npm test` for isolated MCP, package, terminal-emulation, and model transport checks.

### Windows interactive terminal

Run LangVision on Windows over loopback. Install Git for Windows and optionally PowerShell 7. The terminal starts without loading a profile. For a trusted nonstandard PowerShell 7 installation, set `LANGVISION_PWSH_PATH` to its absolute `pwsh.exe` path before starting LangVision.

1. In **Coding Workspace**, choose an empty, disposable local folder and enable **Allow agent-controlled PowerShell** before granting access.
2. Ask Coding Agent: “Create a `terminal-poc` Git repository and a `git-prompt.ps1` script in my authorized folder. Activate it in the interactive PowerShell session. Verify the rendered prompt shows `[main]` inside the repo and not outside. Type a command without submitting, then send Enter. Close the session. Do not modify my PowerShell profile or global Git configuration.”
3. Review the exact opening request and approve it once. In Historia, inspect the screen result, cursor row, and **Terminal lifecycle**. Revoke the workspace grant when finished.

**Not a sandbox:** The folder limits the starting location, not what PowerShell can access under your Windows account. After opening, the agent can send arbitrary commands and key input without another approval. Never enter credentials. Screens and sanitized diagnostics may appear in model input and Historia. Do not use this mode for untrusted tasks or sensitive folders.

From the repository root, run both real ConPTY tests and the LangGraph protocol fixture:

```powershell
$env:LANGVISION_TEST_CONPTY = '1'
$env:LANGVISION_PWSH_PATH = (Get-Command pwsh.exe).Source
node --test standalone/server/windowsTerminal.test.js standalone/server/windowsTerminalAgent.test.js
```

Set `LANGVISION_TERMINAL_MODEL` to an installed tool-capable Ollama model to also run the opt-in model-driven test. It uses a disposable directory and checks the saved script and rendered prompt evidence, not the model's summary.

An accepted write is not command success. Terminal revisions describe changes to the observed screen or diagnostics, not command IDs. Only a shell exit notification supplies an exit code. Ctrl+C is interactive input, not a guarantee of process-tree termination.

### Local Ollama memory and template errors

New terminal or coding runs use a single leading system message, including authored guidance. A classified Ollama template or memory/runner failure stops the turn with a diagnosis rather than repeating the same request. It does not switch models or replay writes.

Model HTTP requests use the configured LangVision deadline and cancellation, not the HTTP client's default five-minute response-header timer. A provider transport failure is reported separately from a model deadline.

Run `node standalone/tests/git-prompt-site.mjs` on Windows after building the portal. It exercises the default Coding Agent in Edge, with a disposable Git clone and real ConPTY. The default mode supplies deterministic model responses. Set `LANGVISION_GIT_PROMPT_MODEL` to an installed Ollama tag for live inference; optionally set `LANGVISION_GIT_PROMPT_PLANNER` to a distinct planning tag. The test requires a separately approved file edit and terminal session, a saved script outside the clone, the actual rendered prompt, and matching Historia evidence.

```powershell
$env:LANGVISION_GIT_PROMPT_PLANNER = 'gpt-oss-120b-16k:latest'
$env:LANGVISION_GIT_PROMPT_MODEL = 'qwen3-coder-next:q4_K_M'
node standalone/tests/git-prompt-site.mjs
```

Set `LANGVISION_KEEP_SITE_EVIDENCE=1` to retain the disposable workspace and
Historia database for investigation. Without a live model, set
`LANGVISION_TEST_CLARIFICATION=1` to exercise a clarification and page reload.
For web research, install Chromium as above, set `LANGVISION_WEB_TEST_MODEL`
to a cached Ollama tag, and run `node standalone/tests/live-web-site.mjs`. If
no `LANGVISION_SEARCH_URL` is set, that test uses a fixture search index; the
model, approvals, and public browser navigation are real.
Both live tests use the current local Ollama endpoint by default; set
`LANGVISION_TEST_OLLAMA_URL` to a separate endpoint when comparing runner
configurations without changing the production model profiles.

The Coding Agent's verification node uses a single completion action. Its saved
alternative evidence paths accept either a successful Linux behavior test, or
a Windows screen match, matching cursor line, and close from the same terminal
after the edit. A terminal command being accepted is not verification.

For constrained local hardware, set `LANGVISION_LOCAL_OLLAMA_CONTEXT=8192` before starting LangVision, then check the allocated context and offload in `ollama ps`. This caps loopback native Ollama requests only; it does not edit the installed model or an OpenAI-compatible request. Start with one loaded model and one parallel request in Ollama. Increase context only after verifying memory headroom; too small a context can truncate a long coding turn. Keep profile timeouts separate from context limits.

The [Git prompt example](../examples/coding-agent/GitPrompt.ps1) is session-only by default. Dot-source it from PowerShell, then run `Disable-LangVisionGitPrompt` to restore the previous prompt. To install permanently, add the dot-source line with its absolute path to your chosen PowerShell profile. No GitHub API or automatic fetch is used; counters compare against the last-fetched upstream, and `?` means no upstream count is available. `=0` means clean; `dirty:N` counts staged, unstaged and untracked paths.

LLM nodes can scope discovery to chosen saved skills. Enable `skills.list`,
`skills.search`, and `skills.read` on the LLM and its connected Tool node.
Only a compact catalog is offered upfront for small sets; larger catalogs
are searchable. Skill bodies and references load only when requested, using
the same [progressive disclosure pattern](https://agentskills.io/client-implementation/adding-skills-support).
`npm run test:browser` uses Chromium and the cached Qwen model against a
disposable standalone instance on port 18780. Set
`LANGVISION_CHRONUS_FIXTURE=http://127.0.0.1:17877` to include the optional
cross-service product check, using a disposable Chronusphaera instance
configured for the test workspace and credentials in the fixture.
