# Gmail MCP Integration

Aila treats Gmail as a product integration backed by a standard remote MCP server.
The integration preset writes a normal user MCP config entry named `gmail` and
adds Aila-owned metadata for setup, OAuth state, and default tool approval policy.

## Endpoint

- MCP transport: `http`
- MCP URL: `https://gmailmcp.googleapis.com/mcp/v1`
- Default scopes:
  - `https://www.googleapis.com/auth/gmail.readonly`
  - `https://www.googleapis.com/auth/gmail.compose`

## OAuth

The MCP SDK owns protocol details: discovery, PKCE, authorization-code exchange,
refresh, and token injection into HTTP/SSE transports.

Aila provides:

- OAuth client configuration in `mcp.json`
- a local loopback callback server for user-initiated Connect
- local credential persistence in `mcp-oauth.json` with file mode `0600`
- non-interactive background connection behavior, so app startup never opens a browser

For Google, create an OAuth client in Google Cloud and paste the client ID into
Settings > Extensions > Integrations > Gmail. A client secret is optional for
desktop-style public clients and can be supplied for web-style clients. Leaving
the redirect URI blank lets Aila use a dynamic loopback redirect during Connect.

## Approval Policy

Read-only Gmail MCP tools are configured as `auto` by default:

- `search_threads`
- `get_thread`
- `list_labels`
- `list_drafts`

Tools that create drafts or modify labels stay on `ask`:

- `create_draft`
- `label_message`
- `label_thread`
- `unlabel_message`
- `unlabel_thread`

## External Requirements

Google consent-screen configuration, app verification, test-user access, and any
Workspace admin policy are outside this repository. Aila can store client
configuration and run OAuth, but production rollout still needs the Google-side
project, scopes, branding, and verification status to be correct.
