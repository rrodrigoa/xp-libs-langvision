# LangVision Coding Agent

## Start

Use Node.js 24 from the root of the standalone worktree. Run
`npm run launch` to install, build, and start. Check
`Invoke-RestMethod http://127.0.0.1:8780/api/ready` in another terminal.
Port 8765 is the old Python editor. The current service does not need
Chronusphaera or a model to serve the editor. Select an Ollama or
OpenAI-compatible profile before running the agent.

## Delivery Gates

1. **Portable definition.** Create an agent in the existing editor, export
   its graph, child workflows, prompts, resources and connection templates
   as `.langvision.zip`, and reimport it into a clean instance. Require an
   exact manifest, bounded reads, a payload digest and atomic inactive draft
   creation. Keep legacy JSON imports; do not package secrets or folder grants.
2. **Plan and inspect.** Publish an ordered checklist; acquire a local folder
   grant through the operator, then inspect the workspace and target platform.
   Keep the checklist visible across nodes and collect evidence in Historia.
3. **Edit and test.** Show the exact old/new content or operation and bind
   approval to the grant and expected revision. Scope reads and writes to the
   granted root. Run commands in a disposable non-root Docker snapshot with
   no network or host mounts; never fall back to a host shell.
4. **Research.** Use an optional separate MCP connection for public search
   and page reads. Review outgoing arguments, block private destinations, and
   treat retrieved content as untrusted. Do not embed Tetris, PowerShell or
   Git-specific instructions in the agent package.
5. **Tetris acceptance.** Ask exactly "write me a python Tetris game for the
   console" in a fresh instance with an empty approved folder. Require game
   source, generated behavior tests, and a successful sandbox test run. Play
   the generated game in a fresh Windows terminal: movement, rotation,
   collision, line clears, scoring, game over and quit. Inspect the execution
   in Historia. Verify opaque cards, readable edges and Edit/Cancel in the
   graph. Preserve user agents and pinned history.
6. **PowerShell follow-up.** Use the same agent to research and generate a
   Git-aware PowerShell prompt. Verify repo/branch, dirty state, local
   ahead/behind, detached HEAD and no upstream in disposable repos. Preview
   and approve a separate backup and profile update; never fetch on render or
   bypass execution policy. Verify in a fresh PowerShell 7 console.

## Current Boundaries

Workspace capabilities are built into the standalone tool host; exposing
them through external MCP and supplying a dedicated PowerShell runner image
remain follow-ups. A ZIP does not grant permissions. Coding Agent is the
local startup default; the full Tetris behavior-suite gate is still separate.

## Local Model Comparison

Both trials used the same prompt, package revision, and an empty approved
workspace, with GPT-OSS 120B 32K (low reasoning) for planning and Qwen3 8B
for inspection. The active-time budget was 60 minutes, with a 15-minute
request limit. Neither run hit a wall-clock deadline.

| Coding profile | Elapsed | Output and verification |
| --- | ---: | --- |
| `qwen3-coder:30b` | 3m 23s | Wrote `tetris.py`. A fresh Windows terminal confirmed startup, movement, rotation, drop and quit; separate operator checks passed for collision, rotation, line clearing, scoring and game over. The agent itself attempted two failed sandbox launches and did not write behavior tests, so the no-progress gate blocked completion. |
| `qwen3-coder-next:q4_K_M` | 4m 28s | Wrote `tetris.py` with an unguarded Linux-oriented `curses` import. A Linux syntax check passed, but no behavior tests or Windows run were demonstrated. Repeated exits without evidence were blocked. |

Treat these as single-run results, not a general model ranking. Repeat with
the same seed and limits before promoting a revision. Run the non-interactive
behavior suite and verify the same artifact in the Windows terminal.

The follow-up split implementation and verification into separate nodes.
The first split-graph run exposed inconsistent evidence ID handling; the
regression now accepts either recorded ID. The subsequent retry could not
reach implementation: local Ollama returned HTTP 500 while GPT-OSS 120B
was warming up. Its server log reported a CUDA initialization failure and
runner exit `0xc0000409`. This is not a LangVision timeout. Restore Ollama
runner health before rerunning the acceptance gate; the default was not
changed.
