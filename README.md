# LangVision

LangVision is a self-hosted service for visually designing, running, and
debugging agents. It uses Chronusphaera's Agent Editor, agent chat, and
Historia experience with a standalone Node.js and JavaScript LangGraph
runtime. It does not require Chronusphaera to run.

## Start from this checkout

With Node.js 24 installed, run this command from the repository root:

```powershell
npm run launch
```

Open [LangVision on port 8780](http://127.0.0.1:8780/). This checkout is the
Node.js service, not the older Python editor on port 8765. It does not use
`pip`, a virtual environment, or the Python `langvision editor` command.
`npm run launch` installs locked dependencies, builds the UI, and starts
LangVision only if setup succeeds. Use `npm start` for later launches if
the dependencies and build are unchanged. Stop an existing instance first.

**Coding Agent starts as the local default.** No ZIP import is required.
First startup provisions local Ollama profiles at `http://127.0.0.1:11434`
for **Default** (`gpt-oss-120b-32k:latest`, medium reasoning) and **Coding**
(Qwen3 Coder Next Q4). Default is protected from deletion.
Ollama and those models
must be available to run a turn, not to open the UI. If a model is missing
or fails to load, choose a working cached model in Agent Editor's node
settings. Existing custom agent selections and history are preserved.

1. Open **Coding Workspace**, enter an existing absolute project path,
   enable edits and click **Grant access**. Re-grant after a restart.
2. See **Built-in coding tools** in that same tab, or open a node's tool
   settings for its specific allowlist. Generic coding skills are under
   **Agent Editor > Skills**. Optional external tools use **MCP connections**.
3. Send a request in chat and approve exact edits or test commands.
   Keep Docker running for sandboxed command execution.
4. In **Historia**, select the request and click **Copy run ID** to share
   the ID for troubleshooting.

Keep the terminal running and use `Ctrl+C` there to stop LangVision. In a
second PowerShell window, verify startup with:

```powershell
Invoke-RestMethod http://127.0.0.1:8780/api/ready
```

It should return `ready: True`. If you set `PORT`, use that port in the URL.

### Recover from a Windows SQLite lock

If setup reports `EPERM` on `better_sqlite3.node`, an older server may
still have the DLL loaded. Stop this worktree's server with `Ctrl+C` before
running setup. If that terminal is gone, setup lists the exact Node process
IDs holding this worktree's SQLite module. Check the reported ID in Task
Manager, then stop only that LangVision process with
`Stop-Process -Id <reported process ID>`. Some older
instances used port `18780`, so check there too.

Then rerun `npm run setup`. Only run `npm start` after setup succeeds.
A previous failed install can leave dependencies such as `express`
missing; rerunning setup with the lock released repairs that installation.
Do not delete the SQLite database or run npm as Administrator for this.

See [standalone setup, MCP, and agent packages](standalone/README.md).
For the coding agent, see the [delivery plan](CodingAgent.md) and the
[importable example package](examples/coding-agent/README.md).
