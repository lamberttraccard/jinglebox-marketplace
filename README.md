# Jinglebox for Claude Code

A [Claude Code](https://claude.com/claude-code) plugin that plays sounds from your [Jinglebox](https://jinglebox.app) workspace when something happens in a session.

| Event | When it plays |
|---|---|
| `turn-done` | Claude finished and its answer waits for you |
| `needs-answer` | Claude waits on you: a question, a plan to approve, a permission prompt, or an answer that ends on a question |
| `long-turn` | a turn longer than 60 s finished (instead of `turn-done`) |
| `tests-passed` / `tests-failed` | a test command run by Claude passed or failed (`artisan test`, `pest`, `phpunit`, `pytest`, `jest`, `vitest`, `go test`, `cargo test`, `npm test`…) |
| `pr-created` | `glab mr create` or `gh pr create` succeeded |

Out of the box every event plays a random short sound of your workspace; set your own with `/jinglebox set`.

The plugin ships **no audio**. Each machine downloads its sounds through its own Jinglebox MCP connection, with its own account, and caches them locally (40 sounds at most).

## Install

1. **Connect the Jinglebox MCP server** (once per machine):
   ```bash
   claude mcp add --transport http --scope user jinglebox https://jinglebox.app/mcp
   ```
   then run `/mcp` in an interactive `claude` terminal, pick `jinglebox` and authenticate.

2. **Allow its read-only tools**, so the plugin's calls are not refused in auto mode. In `~/.claude/settings.json`:
   ```json
   "permissions": {
     "allow": [
       "mcp__jinglebox__get-sound",
       "mcp__jinglebox__search-sounds",
       "mcp__jinglebox__get-workspace",
       "mcp__jinglebox__list-workspaces"
     ]
   }
   ```

3. **Install the plugin**:
   ```bash
   claude plugin marketplace add lamberttraccard/jinglebox-marketplace
   claude plugin install jinglebox@jinglebox
   ```
   Or try it without installing: `claude --plugin-dir ./plugins/jinglebox`.

4. Start a new session. If your account has several workspaces, pick one with `/jinglebox workspace <slug>`.

## Commands

```
/jinglebox                                       current sounds
/jinglebox workspace [slug]                      list or pick the workspace
/jinglebox set <event> 329 | #329 | <sound URL>  a fixed sound
/jinglebox set <event> 21,349,336                random among these
/jinglebox set <event> random [tag]              random short sound of the workspace, or of one tag
/jinglebox set <event> default                   back to the default (random from the workspace)
/jinglebox search <words>                        find sounds and their IDs
/jinglebox test <event>                          play an event's sound now
/jinglebox mute | unmute
/jinglebox debug                                 check the MCP call, the playback and the cache
```

Choices are kept per machine and per workspace, across sessions. A random pick never plays the same sound twice in a row, and the next sound is downloaded ahead so it starts at once. The toast names each sound played, so a random one you like can be pinned with `/jinglebox set`.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `workspace` | empty | the workspace slug; empty to pick it with `/jinglebox workspace` |
| `mcp_server` | `jinglebox` | the Jinglebox MCP server's name, as `/mcp` lists it |
| `long_turn_seconds` | `60` | a turn longer than this plays `long-turn` |
| `random_max_seconds` | `4` | a random pick only takes sounds this short |

## How it works

It is a plugin of Claude Code **function hooks** (`plugins/jinglebox/hooks/register.ts`), an early-access API: it needs a Claude Code build that supports it.

- `turn.complete`, at the end of a main-loop turn: `needs-answer` when the answer's last paragraph asks a question, else `long-turn` or `turn-done`.
- `classic.PermissionRequest`, and `tool.call` on `AskUserQuestion` and `ExitPlanMode`: `needs-answer`, at most once every 3 s.
- `tool.call` on `Bash`: `tests-passed`, `tests-failed`, `pr-created`.
- Sounds come from the MCP's `get-sound`, are cached in the plugin's store and played with `$.audio.play`. Random picks draw from `search-sounds`, refreshed once a day.

## Troubleshooting

`/jinglebox debug` runs each step and says which one fails.

- "MCP server is not connected": the Jinglebox MCP server is not connected in this session (it can time out at startup). Run `/mcp`, reconnect `jinglebox`, and try again.
- "call refused": the permissions of step 2 are missing.

## License

MIT, see [LICENSE](LICENSE).
