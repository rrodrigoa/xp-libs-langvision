# LangVision

LangVision is a self-hosted service for visually designing, running, and
debugging agents. It uses Chronusphaera's Agent Editor, agent chat, and
Historia experience with a standalone Node.js and JavaScript LangGraph
runtime. It does not require Chronusphaera to run.

## Start from this checkout

With Node.js 24 installed, run these commands from the repository root:

```powershell
npm run setup
npm start
```

Open [LangVision on port 8780](http://127.0.0.1:8780/). This checkout is the
Node.js service, not the older Python editor on port 8765. It does not use
`pip`, a virtual environment, or the Python `langvision editor` command.
`npm run setup` installs the locked dependencies and builds the browser UI
in `standalone/`. Run it on a fresh checkout, then use `npm start` to restart.
No model server is required to open the UI; configure one to run an agent.

See [standalone setup, MCP, and agent packages](standalone/README.md).
