# MCP Setup — Use Sound Browser directly in Claude

The MCP server lets Claude Desktop and Claude Code control the browser as a built-in tool — no SDK, no HTTP calls, just natural language.

## Claude Desktop

Add to `~/.claude/claude_desktop_config.json` (create if missing):

```json
{
  "mcpServers": {
    "sound-browser": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/sound-browser/src/mcp/server.ts"]
    }
  }
}
```

Restart Claude Desktop. You'll see "sound-browser" in the tools panel.

## Claude Code

```bash
claude mcp add sound-browser -- bun run /absolute/path/to/sound-browser/src/mcp/server.ts
```

## Cursor / Windsurf

Add to MCP config:
```json
{
  "mcpServers": {
    "sound-browser": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/sound-browser/src/mcp/server.ts"]
    }
  }
}
```

---

## Available tools

| Tool | What it does |
|------|-------------|
| `navigate` | Go to a URL, returns page structure |
| `get_page` | Read current page structure |
| `action` | Execute any browser action (fill, click, press, scroll…) |
| `js` | Run JavaScript in the page |
| `screenshot` | Take a screenshot |
| `save_auth` | Save current cookies to a named profile |
| `load_auth` | Restore cookies from a saved profile (skip login) |
| `new_session` | Open a fresh Chrome window |
| `sessions` | List active sessions |

---

## Example usage

Once connected, just talk to Claude:

> "Go to zoho mail and check my unread emails"

> "Log into github.com with my saved 'github' profile and open my notifications"

> "Go to my company's invoice portal, find all unpaid invoices, and list them"

---

## Auth profiles (login once, reuse forever)

```
# In Claude: "Go to github.com and log in with user@example.com / mypassword"
# Then: "Save the current session as 'github'"

# Next time: "Load my 'github' auth profile, then go to github.com/notifications"
```

Cookies saved to `~/.sound-browser/cookies/<profile>.json`.
