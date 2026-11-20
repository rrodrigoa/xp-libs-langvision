# Coding Agent

Import [coding-agent.langvision.zip](coding-agent.langvision.zip) under
**Packages**. Bind a local model, activate the draft, and grant an empty
dedicated directory in **Coding Workspace**. See the
[standalone runbook](../../standalone/README.md) for Docker and optional MCP
research setup.

The [reviewable definition](../../standalone/shared/codingAgent.js) is
generic. It includes no generated game, project files, or credentials.
Regenerate from the repository root:

```powershell
node standalone/scripts/package-coding-agent.mjs
```
