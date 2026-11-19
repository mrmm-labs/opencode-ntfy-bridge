# opencode-oob-bridge

An OpenCode plugin that sends the questions and permission prompts of selected sessions to your
phone through [ntfy](https://ntfy.sh) and/or Telegram, and lets you answer the questions from
there.

When you step away from the terminal, a session that asks a question stops and waits. With this
plugin the question arrives on your phone as a notification with one button per option. Tap a
button, or reply with text, and the session continues. Permission prompts are sent too, but only
as a heads-up: they are always answered in the TUI.

Renamed from `opencode-ntfy-bridge` in 0.4.0, because ntfy is no longer the only channel. The old
config file (`ntfy-bridge.jsonc`), state directory and `OPENCODE_NTFY_BRIDGE_*`
variables are still read when the new ones are absent.

## Install

Needs OpenCode 2 and Node 24 to build.

```sh
mise install && mise run build   # or: pnpm install && pnpm run build
```

Put the folder where OpenCode loads plugins from (OpenCode 2 loads a directory through its
`index.js`, and its TUI through `tui.tsx`), or list the published package in your OpenCode config:

```jsonc
{ "plugins": ["opencode-oob-bridge"] }
```

Then copy [`oob-bridge.example.jsonc`](oob-bridge.example.jsonc) to
`~/.config/opencode/oob-bridge.jsonc` and restart the TUI. **Without a config file the plugin does
nothing and opens no connection.**

## Configuration

```jsonc
{
  "channels": {
    "ntfy": {
      "server": "https://ntfy.example.com",
      "token": { "env": "OOB_BRIDGE_TOKEN" }, // or { "command": ["pass", "show", "ntfy/opencode"] }
      "topics": { "out": "oc-3k9f2x7q-out", "in": "oc-3k9f2x7q-in" },
    },
    "telegram": {
      "token": { "command": ["pass", "show", "telegram/opencode-bot"] },
    },
  },
  "defaultChannel": "all", // "all", "ntfy" or "telegram"
  "away": { "minutes": 10 },
  "rules": [{ "agent": "^coordinator$" }, { "directory": "**/my-app" }],
  "redact": "head:300",
  "permissions": { "tier": 3 },
}
```

| Key                 | Default  | Meaning                                                                       |
| ------------------- | -------- | ----------------------------------------------------------------------------- |
| `channels.ntfy`     | none     | The ntfy channel. See [Channels](#channels).                                  |
| `channels.telegram` | none     | The Telegram channel. See [Channels](#channels).                              |
| `defaultChannel`    | `all`    | Where pushes go for a session that chose no channel: `all` or a channel name. |
| `away.minutes`      | `10`     | Minutes without input in the TUI before matching sessions are mirrored.       |
| `rules`             | `[]`     | Which sessions are mirrored while you are away. Empty: all.                   |
| `redact`            | `full`   | `full`, `head:<n>` (first n characters) or `title` (no body at all).          |
| `permissions`       | tier 3   | Only tier 3 (push only) exists.                                               |
| `messages`          | built in | Push formats per kind, overriding the defaults field by field. See below.     |
| `profiles`          | `[]`     | Per-use-case formats: the first profile matching `agent`/`directory` wins.    |
| `otel`              | off      | OpenTelemetry export. See [Telemetry](#telemetry).                            |

The old single-channel form still works: `server`, `token`, `topics` and `actionAuth` at the top
level mean `channels.ntfy`. Use one form or the other.

A rule has any of `agent` (regular expression on the session's agent), `directory` (glob on the
session's directory: `**` any depth, `*` one segment) and `command` (argv; exit code 0 routes; it
gets `OOB_BRIDGE_SESSION`, `OOB_BRIDGE_AGENT` and `OOB_BRIDGE_DIRECTORY`). Fields in one rule
must all match; any matching rule routes the session. Rules look at the top-level session, so a
subagent follows its parent.

### Push formats

Each push kind (`question`, `permission`, `finished`, `failed`, `closed`, `notice`) has a default
`title`, `message`, `tags` and `priority`, defined in `src/messages.ts`. Override any field in
`messages`; a `profiles` entry (`agent` regular expression and/or `directory` glob, plus
`messages`) overrides it again for matching sessions. `{{name}}` placeholders are filled per push
and an unknown name renders empty; the placeholder list is in `oob-bridge.example.jsonc`. Text
from the session is redacted before it is placed, so `redact` still applies.

```jsonc
"messages": { "finished": { "title": "✅ {{project}}", "priority": 3 } },
"profiles": [
  { "agent": "^coordinator$", "messages": { "question": { "priority": 5, "tags": ["rotating_light"] } } }
]
```

Environment overrides: `OPENCODE_OOB_BRIDGE_CONFIG` (config file), `OPENCODE_OOB_BRIDGE_DATA`
(state directory, default `~/.local/share/opencode/oob-bridge`), `OPENCODE_OOB_BRIDGE_LOG` (log
file, default `bridge.log` in the state directory).

## Channels

A channel is a way to reach your phone. Configure one or both; every enabled channel gets the
pushes of a session (see `defaultChannel` and `/oob on <channel>` below). A question can be
answered from any of them: the first answer wins, and every channel's message is then updated to
say who answered ("Answered from telegram: Yes", "Answered in the TUI").

| Key (under `channels.ntfy`) | Default    | Meaning                                                                               |
| --------------------------- | ---------- | ------------------------------------------------------------------------------------- |
| `server`                    | (required) | ntfy server URL.                                                                      |
| `token`                     | none       | `{ "env": NAME }` or `{ "command": [argv] }`. A literal token in the file is refused. |
| `topics.out`                | (required) | Topic the plugin publishes to. Subscribe to it in the ntfy app.                       |
| `topics.in`                 | (required) | Topic the plugin reads replies from.                                                  |
| `actionAuth`                | `true`     | Put the token in each button so buttons work on an auth-protected server.             |
| `enabled`                   | `true`     | Set `false` to configure it without using it.                                         |

| Key (under `channels.telegram`) | Default                    | Meaning                                                                                     |
| ------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------- |
| `token`                         | (required)                 | The bot token, as `{ "env": NAME }` or `{ "command": [argv] }`. A literal token is refused. |
| `chatId`                        | none                       | The chat to talk to. Leave it out and run `/oob pair telegram` instead.                     |
| `enabled`                       | `true`                     | Set `false` to configure it without using it.                                               |
| `apiBase`                       | `https://api.telegram.org` | Bot API URL, for a local Bot API server.                                                    |

Which channels are on is also a TUI setting (`/oob`, "Channels"). The choice is stored in
`settings.json` in the state directory and layered over the config file, which the plugin never
rewrites.

### Connectors

A channel is an instance of a connector type. The key under `channels` is its name, and
`channels.<name>.type` defaults to the name, so `ntfy` and `telegram` need no `type`. A second
instance of a type needs one: `"phone": { "type": "telegram", ... }`.

The core never looks at a connector's type. It reads what the connector declares it can do and
degrades to match:

| Capability      | Without it                                                               |
| --------------- | ------------------------------------------------------------------------ |
| `buttons`       | The question is numbered text, answered by number or `#id answer`.       |
| `multiselect`   | A multiple-choice question gets no toggle buttons, only numbered text.   |
| `edit`          | The outcome ("Answered from ...") is a follow-up message, not an edit.   |
| `threads`       | The session is named in each message, not given its own thread or topic. |
| `pairing`       | There is no "Pair" menu item and `/oob pair` refuses it.                 |
| `inboundPrompt` | Reserved: sending text into a session from a chat. No connector has it.  |

ntfy has buttons and edit; Telegram has all of them but `inboundPrompt`. A new connector is one
file in `src/connectors/` implementing `Connector` from `src/connectors/types.ts`, plus one line
in `src/connectors/index.ts`. Pairing goes through `pair()`, which returns a one-time code, an
optional link (the TUI shows a QR code of it) and an expiry, whatever the connector is. Inbound
messages arrive through one callback as `{ kind: "answer" | "prompt", pendingId?, sessionKey?,
text, choice?, from }`; `prompt` exists in the types only and the core ignores it.

### Telegram

The plugin talks to the Bot API over HTTPS with long polling (`getUpdates`): it only makes
outgoing requests, and exposes no port or webhook.

1. In Telegram, talk to [@BotFather](https://t.me/BotFather), run `/newbot` and keep the token.
2. Put the token in a secret store or an environment variable and reference it in
   `channels.telegram.token` (`{ "command": ["pass", "show", "telegram/opencode-bot"] }`).
3. Restart the TUI and run `/oob pair telegram`. The dialog shows a link and a QR code
   (`https://t.me/<bot>?start=<code>`). Scan it or open the link, press Start, and the plugin
   stores that chat. Typing the six-character code to the bot works too. The code works once and
   expires after 10 minutes. The chat id is saved in `settings.json`, not in your config file.
   If the terminal is too small for the QR code, the dialog shows the link and the code only.

What you get in Telegram:

- A **question** is a message with one button per option (up to 10). Tap one: the phone shows a
  toast with the outcome at once, and the message becomes "Answered: X" with the buttons removed.
  **Multiple choice** shows toggle buttons (a tick marks the chosen ones) and a Done button.
  You can always answer by replying to the question message with a number or text, or with
  `#id answer` as on ntfy.
- **Several questions in one prompt**, or a question with more than 10 options, get no buttons:
  reply to the message with one answer per question, separated by `|` (for example
  `1 | yes | 2,3`). This is the same grammar as ntfy.
- A **permission** prompt is a message without buttons that says to answer in the TUI. It can
  never be answered from Telegram.
- **Finished / failed** pushes and answered-in-the-TUI updates use the same formats as ntfy
  (`messages`, `profiles`). Low priority pushes arrive without a sound.
- The plugin acts only on messages and taps from the paired chat. Anything else is ignored and
  logged without its content. The bot token is never logged.
- In a **forum** supergroup (topics enabled; the bot must be an admin who can manage topics), each
  top-level session gets its own topic, named `<project> · <session title>` (just the project when
  `redact` is `title`), and its messages go there. Elsewhere everything goes to the chat, with the
  project and session in each message.

**Privacy.** Telegram bot chats are not end-to-end encrypted: Telegram can read what the bot
sends. Before pointing a sensitive project at it, use `redact: "title"` (no question text), a
`profiles` entry that blanks its messages, or `rules`/`/oob on ntfy` to keep that session off
Telegram. Known secret shapes are masked in every message either way.

## Telemetry

The plugin can export OpenTelemetry traces and metrics over OTLP/HTTP JSON, using only `fetch`
(no OpenTelemetry packages). It is **off** unless `otel.endpoint` is set (with optional
`otel.headers`) or `OTEL_EXPORTER_OTLP_ENDPOINT` is (with optional `OTEL_EXPORTER_OTLP_HEADERS`);
the config wins.

```jsonc
"otel": { "endpoint": "http://localhost:4318", "headers": { "authorization": "Bearer ..." } }
```

Service `opencode/oob-bridge`, scope `opencode-oob-bridge`. The trace id is the first 32 hex
characters of `sha256(<top-level session id>)`, as in the other OpenCode plugins that export
telemetry, so these spans join the session's trace.

| Spans           | What                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `oob.route`     | A routing decision: mode, reason, channel chosen, number of targets.                                                                                               |
| `oob.push`      | One push of a kind, with a child `oob.send` or `oob.update` per connector (type, ok, HTTP status, retries).                                                        |
| `oob.inbound`   | An answer or prompt from a chat: kind, connector type, outcome (`applied`, `expired`, `duplicate`, `unreadable`, `permission-refused`, `failed`, `rejected-chat`). |
| `oob.pair`      | Pairing, until paired or expired.                                                                                                                                  |
| `oob.reconnect` | A connector's poll or subscription reconnecting.                                                                                                                   |

| Metrics                 | Kind      | Labels                                              |
| ----------------------- | --------- | --------------------------------------------------- |
| `oob.pushes`            | counter   | `connector.type`, `push.kind`                       |
| `oob.push.errors`       | counter   | `connector.type`, `push.kind`                       |
| `oob.answers`           | counter   | `connector.type`, `answered_by` (`phone`, `tui`)    |
| `oob.inbound.rejected`  | counter   | `connector.type`, `reason`                          |
| `oob.reconnects`        | counter   | `connector.type`                                    |
| `oob.answer.latency_ms` | histogram | `connector.type`, `answered_by` (asked to answered) |
| `oob.pending`           | gauge     | none (open prompts)                                 |

Attributes are ids, kinds, counts and timings only. Message text, titles, answers, tokens, chat
ids and URLs are never exported. Data is batched every few seconds in a bounded queue (the oldest
is dropped), sent on exit, and a failed export is dropped and logged at most once a minute; it
never affects a session.

## Which sessions are mirrored

- `/oob` opens a settings menu: **This session** (on with the default channel, on via telegram,
  on via ntfy, off, auto), **Channels** (switch each on or off), **Pair Telegram**, **Send test
  push** (to every enabled channel) and **Status** (channels, connection, last error, open
  prompts). It is also in the command palette.
- The same from the prompt: `/oob on` mirrors the session now, through `defaultChannel`;
  `/oob on telegram`, `/oob on ntfy` or `/oob on all` picks the channel for this session;
  `/oob off` never mirrors it; `/oob auto` returns it to the away rule. `/oob status`,
  `/oob test` and `/oob pair telegram` do what the menu items do. `/ntfy` still works as an
  alias. The setting covers the session's subagents and is remembered across restarts (in
  `settings.json`).
- Otherwise, a session is mirrored when nobody has typed a message in the TUI for `away.minutes`
  and a rule matches. Typing again stops it for new prompts.

## Tiers

| Tier | Prompts           | From a channel                                                                        |
| ---- | ----------------- | ------------------------------------------------------------------------------------- |
| 1    | Questions         | Answered: buttons, or a text reply.                                                   |
| 2    | (not implemented) | Remote allow/deny of permissions. There is no code path for it.                       |
| 3    | Every permission  | Push only, with a hint to answer in the TUI. A reply from a channel is never applied. |

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
Slack tokens, private keys, JWTs, `password=` style pairs, URL credentials) and the channel tokens
themselves.

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
- This is why permissions stay tier 3: a permission is never granted or denied from a channel.
- Telegram answers come only from the paired chat, found by its numeric chat id. Anyone who can
  send messages as that chat (or take over that Telegram account) can answer questions.
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
