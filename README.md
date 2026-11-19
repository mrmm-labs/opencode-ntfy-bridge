# opencode-ntfy-bridge

An OpenCode plugin that sends the questions and permission prompts of selected sessions to
[ntfy](https://ntfy.sh), and lets you answer the questions from your phone.

When you step away from the terminal, a session that asks a question stops and waits. With this
plugin the question arrives on your phone as a notification with one button per option. Tap a
button, or reply with text, and the session continues. Permission prompts are sent too, but only
as a heads-up: they are always answered in the TUI.

## Install

Needs OpenCode 2 and Node 24 to build.

```sh
mise install && mise run build   # or: pnpm install && pnpm run build
```

Put the folder where OpenCode loads plugins from (OpenCode 2 loads a directory through its
`index.js`, and its TUI through `tui.tsx`), or list the published package in your OpenCode config:

```jsonc
{ "plugins": ["opencode-ntfy-bridge"] }
```

Then copy [`ntfy-bridge.example.jsonc`](ntfy-bridge.example.jsonc) to
`~/.config/opencode/ntfy-bridge.jsonc` and restart the TUI. **Without a config file the plugin does
nothing and opens no connection.**

## Configuration

```jsonc
{
  "server": "https://ntfy.example.com",
  "token": { "env": "NTFY_BRIDGE_TOKEN" }, // or { "command": ["pass", "show", "ntfy/opencode"] }
  "topics": { "out": "oc-3k9f2x7q-out", "in": "oc-3k9f2x7q-in" },
  "away": { "minutes": 10 },
  "rules": [{ "agent": "^coordinator$" }, { "directory": "**/my-app" }],
  "redact": "head:300",
  "permissions": { "tier": 3 },
}
```

| Key            | Default    | Meaning                                                                               |
| -------------- | ---------- | ------------------------------------------------------------------------------------- |
| `server`       | (required) | ntfy server URL.                                                                      |
| `token`        | none       | `{ "env": NAME }` or `{ "command": [argv] }`. A literal token in the file is refused. |
| `topics.out`   | (required) | Topic the plugin publishes to. Subscribe to it in the ntfy app.                       |
| `topics.in`    | (required) | Topic the plugin reads replies from.                                                  |
| `actionAuth`   | `true`     | Put the token in each button so buttons work on an auth-protected server. See below.  |
| `away.minutes` | `10`       | Minutes without input in the TUI before matching sessions are mirrored.               |
| `rules`        | `[]`       | Which sessions are mirrored while you are away. Empty: all.                           |
| `redact`       | `full`     | `full`, `head:<n>` (first n characters) or `title` (no body at all).                  |
| `permissions`  | tier 3     | Only tier 3 (push only) exists.                                                       |
| `messages`     | built in   | Push formats per kind, overriding the defaults field by field. See below.             |
| `profiles`     | `[]`       | Per-use-case formats: the first profile matching `agent`/`directory` wins.            |

A rule has any of `agent` (regular expression on the session's agent), `directory` (glob on the
session's directory: `**` any depth, `*` one segment) and `command` (argv; exit code 0 routes; it
gets `NTFY_BRIDGE_SESSION`, `NTFY_BRIDGE_AGENT` and `NTFY_BRIDGE_DIRECTORY`). Fields in one rule
must all match; any matching rule routes the session. Rules look at the top-level session, so a
subagent follows its parent.

### Push formats

Each push kind (`question`, `permission`, `finished`, `failed`, `closed`, `notice`) has a default
`title`, `message`, `tags` and `priority`, defined in `src/messages.ts`. Override any field in
`messages`; a `profiles` entry (`agent` regular expression and/or `directory` glob, plus
`messages`) overrides it again for matching sessions. `{{name}}` placeholders are filled per push
and an unknown name renders empty; the placeholder list is in `ntfy-bridge.example.jsonc`. Text
from the session is redacted before it is placed, so `redact` still applies.

```jsonc
"messages": { "finished": { "title": "✅ {{project}}", "priority": 3 } },
"profiles": [
  { "agent": "^coordinator$", "messages": { "question": { "priority": 5, "tags": ["rotating_light"] } } }
]
```

Environment overrides: `OPENCODE_NTFY_BRIDGE_CONFIG` (config file), `OPENCODE_NTFY_BRIDGE_DATA`
(state directory, default `~/.local/share/opencode/ntfy-bridge`), `OPENCODE_NTFY_BRIDGE_LOG` (log
file, default `bridge.log` in the state directory).

## Which sessions are mirrored

- `/ntfy on` in a session mirrors it now; `/ntfy off` never mirrors it; `/ntfy auto` returns it to
  the away rule; `/ntfy` shows the current mode. The setting covers the session's subagents.
- Otherwise, a session is mirrored when nobody has typed a message in the TUI for `away.minutes`
  and a rule matches. Typing again stops it for new prompts.

## Tiers

| Tier | Prompts           | From ntfy                                                                        |
| ---- | ----------------- | -------------------------------------------------------------------------------- |
| 1    | Questions         | Answered: a button per option, or a text reply.                                  |
| 2    | (not implemented) | Remote allow/deny of permissions. There is no code path for it.                  |
| 3    | Every permission  | Push only, with a hint to answer in the TUI. A reply over ntfy is never applied. |

### What you receive

- **Question**: title `<project> · <agent> asks`, the top-level session's title, the question
  (redacted per `redact`), a numbered option list with short descriptions, and one line telling
  you how to answer with the prompt's short id. Up to three options also become buttons; with
  more options, multiple choice or several questions you reply by number. A subagent's question
  carries its agent name as a tag.
- **Permission**: title `<project> · <agent> needs permission`, the action and its resources.
- **Session finished / failed**: one low-priority push each time a mirrored top-level session
  stops working. A session woken up again (for example by a background subagent reporting back)
  sends another.
- When a prompt is answered in the TUI, its notification is updated to say so.

### Replying

Buttons post `{"id":"ab12","choice":1}` to `topics.in`. You can also publish text there:

| Reply              | Meaning                                      |
| ------------------ | -------------------------------------------- |
| `#ab12 2`          | Option 2                                     |
| `#ab12 yes`        | The option labelled "yes", or a free answer  |
| `#ab12 1,3`        | Options 1 and 3 (multiple choice)            |
| `#ab12 2 \| later` | One part per question when there are several |

The first answer wins, from the phone or the TUI. A later answer gets an "already answered" push
and is not applied; an unknown or expired id (older than a day) gets a push too.

Every outgoing body passes a secret filter that masks known token shapes (API keys, GitHub and
Slack tokens, private keys, JWTs, `password=` style pairs, URL credentials) and the ntfy token
itself.

## Security

- ntfy `http` buttons are sent by the app with no identity: **anyone who can publish to
  `topics.in` can answer a question.** Use long random topic names, and on your own server give
  `topics.in` write access only to the clients you trust.
- Buttons are `http` actions the app sends itself. With `actionAuth: true` (the default) each
  button carries `Authorization: Bearer <token>`, so it works when the server denies anonymous
  writes. **The token is then stored in the notification**: anyone who can read `topics.out` can
  read it. Give that token the least access it needs (write `topics.in`, write `topics.out`, read
  `topics.in`). The alternative is `actionAuth: false` plus an ACL that lets anonymous users only
  write to `topics.in` (`ntfy access everyone <in-topic> write-only`); then the buttons carry no
  credentials, and anyone who knows the topic name can answer.
- This is why permissions stay tier 3: a permission is never granted or denied from ntfy.
- Never route production approvals through this plugin.

## Limitations

- OpenCode 2 only. The bridge runs in the TUI process, the only place a plugin can answer a
  question, so a server without a TUI (`opencode serve`) sends nothing.
- Each running TUI sends its own pushes: with two TUIs open you get every push twice.
- Away means no prompt typed in any session of this TUI; keystrokes alone do not count.
- Tier 2 (remote permission replies) is not implemented.
- In OpenCode 2.3 the built-in subagents have no `question` tool, so subagent questions only come
  from agents you give it to. Subagent permission prompts are mirrored as usual.
- A session that is interrupted (for example by rejecting a permission) sends no finished push.

## Development

```sh
mise run check   # lint, typecheck, tests, build, npm pack --dry-run
pnpm test        # unit tests, plus the e2e test when docker is available
pnpm test:e2e    # e2e against a real ntfy (binwiederhier/ntfy), or NTFY_E2E_URL
```

The e2e test starts `binwiederhier/ntfy serve` with docker, or uses `NTFY_E2E_URL`. It skips when
docker is missing or `NTFY_E2E_SKIP` is set.

## License

MIT
