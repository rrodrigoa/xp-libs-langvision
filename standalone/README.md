# LangVision

Standalone agent authoring, conversation, and Historia from Chronusphaera's
Agent Editor and JavaScript LangGraph runtime. Chronusphaera is not a runtime
dependency. The extraction baseline is StreamSQL commit `2a03048`.

## Run locally

With Node.js 24 installed, run these commands from this directory:

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

Packages download as one `.langvision.json` file containing graph layout,
child graphs, inline skills and prompts, tool/approval settings, and non-secret
model and MCP configuration. Imports produce inactive drafts and disabled
connections with fresh local identities. Rebind model profiles in the editor
and trust and enable intended endpoints before activation. Never paste
credentials into prompt text or skills; package validation rejects credential
fields but cannot identify arbitrary secrets embedded in prose.

## Verify

Run `npm test` for isolated MCP, package, and model transport checks.
`npm run test:browser` uses Chromium and the cached Qwen model against a
disposable standalone instance on port 18780. Set
`LANGVISION_CHRONUS_FIXTURE=http://127.0.0.1:17877` to include the optional
cross-service product check, using a disposable Chronusphaera instance
configured for the test workspace and credentials in the fixture.
