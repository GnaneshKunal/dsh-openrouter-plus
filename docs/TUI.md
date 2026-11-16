# Terminal: the same switches, from a slash command

dsh-openrouter-plus has two halves. The Host half is a loopback relay plus a control API under
`/__openrouter-plus/*`; the browser half is `client.js`, the settings page and its seats. Neither one
is a terminal, so somebody running the plugin under `dsh-tui` could route traffic through it — a
provider row's `baseURL` is enough for that — but could not change a preset, the precision floor or
the user tracking without hand-editing YAML or curling the control API.

This is the outlet: one slash command, `/openrouter-plus`, registered through the DSH command
registry, which both `dsh-tui` and the Web UI resolve.

## Why a command, and not a panel

Three reasons, in the order they decided it:

- **The registry is already wired in both front doors.** One registration is one command in a
  terminal and in the Web UI's palette. A panel would be a component per front door, and a second
  place for the two to disagree.
- **A command's lifetime is not the plugin's to own.** The TUI mounts its own screen, and a plugin
  that registers into it has to survive scene switches, minimal mode and a backend swap. A command
  is inert until somebody types it.
- **It degrades by absence.** A composition with no command registry — a headless Host, a bare
  `cordis.yml` start, a test fixture — never registers, logs one line and keeps serving HTTP. There
  is no key to set, because there is nothing to configure.

It appears in the Web UI's command palette for the same reason it appears in a terminal's: both
front doors read the same registry, which is intended. One command, two registered names,
`/openrouter-plus` and `/oorp`; both are in the palette and either one works.

## Nothing to install

It ships in the package: the bundle's patch declares the Host row, so a profile that has the plugin
has the command, and in a `dsh-tui` profile the bundle is already declared. Check it with
`/openrouter-plus help`. If it is missing, the composition has no command registry: the log carries
`no command registry in this composition; the terminal outlet stays off`, and the relay is unaffected.

## What the verbs do

Both names take the same argument; a bare command is `status`, and `help` prints this table.

| Command | What it does |
| --- | --- |
| `/openrouter-plus` · `status` | Relay state (version, uptime, the address that answered, upstream), this Session's preset and whether it was chosen here or inherited, the precision floor and its origin, and spend: today, the retained window, requests. |
| `preset` | The presets, one line each, with the current choice and the profile default marked. |
| `preset <id>` | This Session runs on `<id>`. Memory only: no config write, no reload. |
| `preset default <id>` | What a new Session inherits. A config write, so the plugin row reloads once. |
| `preset clear` | Hand this Session back to the profile default. |
| `precision` | The four floors, one line each, with the current one marked. |
| `precision <id>` | This Session's floor. Memory only, like the preset. |
| `precision default <id>` | The floor a new Session inherits. A config write and one reload. |
| `precision clear` | Back to the profile default floor. |
| `routes` | One row per provider through the relay — with a pinned tier, or `per-Session preset` — the registered targets, and the preset a new Session inherits. |
| `route <provider>` | Point a provider row at the relay. Its own endpoint is recorded first, which is what makes `unroute` possible. |
| `unroute <provider>` | Put that row back on its own endpoint. |
| `spend` | Today, the retained window, requests and errors, tokens in and out, the measured multiplier of list price, and the priciest presets by cost. |
| `user` · `user on` · `user off` | The optional OpenRouter `user` identifier: whether one is sent, which one, and the switch. |
| `repair` | Refill the reasoning efforts a relay route is missing. |
| `models` | Why model discovery lives in `/provider`, not here. |

The nine preset ids are `none`, `standard`, `fastest`, `fastest-standard`, `cheapest`, `flex`,
`priority`, `ultra` and `floor`; the four floors are `any`, `no-four-bit`, `eight-bit-up` and
`full-width`. Each list names what the choice sends, because a name like "Cheapest" is a routing
decision and not a price guarantee. `route` takes the provider key as `routes` prints it, not the
display name.

## Two kinds of write, and why they are different

A preset or floor chosen for **this Session** is held in the Host's memory and applied to the next
request from that Session. It never rewrites the profile, because a switch that reloads the plugin
mid-conversation would drop the conversation's own state to change one field. The cost is the
familiar one: a Host restart forgets it.

`preset default <id>` and `precision default <id>` are the other kind: preferences, so they write the
plugin row. The Loader re-applies it, the listener rebinds, and the per-Session choices held in
memory are dropped — everybody's. The reply says the row reloads. Neither form needs a Session; the
Session-scoped writes do, since there is nothing to key the choice by otherwise. Without one,
`status` prints a dash rather than inventing a default.

## Which relay it talks to

This is the one part that had to be resolved rather than assumed. Each process binds `8791` and
falls forward to 8792, 8793 and so on when the port is taken, and each holds its own in-memory
Session table. A preset written into a process that is not serving the traffic would be a switch
that does nothing, and nothing in the transcript would say so.

So the command resolves the relay the same way the traffic does, in this order:

1. The loopback origins of the profile's live provider rows' `baseURL`s, in the order the rows
   declare them. Those are the origins the traffic actually dials.
2. The address this process's own listener reported — `8792` after a fall-forward, rather than the
   port it was configured for.
3. The configured port and the nine after it, when `portFallback` is on.

Each candidate is probed with `GET /__openrouter-plus/health`, which has to answer `ok: true`: a 200
from some other server on the port is not this plugin. The winner is cached for 30 seconds, and a
refused or unreachable call drops the cache so the next invocation re-probes. If every probe fails,
the last known origin is reused, so the error names an address instead of saying "nowhere".
Only loopback hosts are probed; a row pointing at `https://openrouter.ai/api/v1` is not a candidate.

Two profiles at once are two relays and two Session tables: a switch in one is invisible in the
other, and `routes` reports the table of the process that answered, not the one that typed the
command.

## What it does not do

- **No model list.** `/provider` already does live discovery in a terminal: it probes a route's
  stored `baseURL` with the stored key, so a model OpenRouter added after this install appears there.
  A second listing here would be a duplicate that drifts. `models` says so in the transcript.
- **No status-line field, no scene.** A field beside the model, and a full-screen page of its own,
  are the natural next steps; neither is in this change.
- **No new configuration keys.** The outlet registers itself when a command registry exists.
- **No cross-process preset sharing.** Session choices are memory in one process, the same rule the
  composer chip follows.

## Security notes

- **Writes name their front door.** `x-oorp-client` is `tui` from here and `web` from the page, and
  anything else answers `403`; `GET`s were and remain header-free.
- **That is a guard, not authentication.** The listener is loopback-only, and the value keeps a
  stray write from a page, a scanner or a pasted URL out of the config path. It proves nothing about
  who is calling.
- **The terminal holds no key.** The relay forwards the caller's `Authorization`; the command reads
  telemetry and writes preferences, never a provider key.
- **The web origin's fence is untouched.** The command is a Host-side caller, not a browser one: it
  dials a loopback relay the way `curl` does, so the GUI's Host/Origin check and session cookie are
  neither required nor weakened.

## Testing it

### 1. The suite

```bash
npm test        # node --test: no dependencies, no network, no profile writes
npm run check   # node --check over the entry points, the modules and the smoke script
```

The suite is 241 tests before this change and needs neither network nor a profile. Its formatters are
exported as pure functions, so a wording change can be checked against a fixed answer, not by eye.

### 2. A live relay, without a terminal UI

```bash
npm run smoke:tui                                      # discovers a relay on 127.0.0.1:8791..8800
OORP_ORIGIN=http://127.0.0.1:8792 npm run smoke:tui    # a specific instance
npm run smoke:tui -- --write                           # also sets and clears a Session preset
```

It prints `relay: <origin>`, then a line per verb, and exits non-zero on the first failure, reporting
`N of M verbs failed`. `--write` exercises the `x-oorp-client: tui` path: it sets and clears a
synthetic Session's preset. This is the check that says which instance your provider rows dial.

### 3. By hand, in the terminal

```
/openrouter-plus
/openrouter-plus preset
/openrouter-plus preset priority
/openrouter-plus
/oorp
```

The fourth command is the confirmation: the `preset` line now reads
`priority (chosen for this Session)`, where before the switch it read *inherited from the profile
default*. `/oorp` is the alias and answers the same status block. Then type the same commands in the
Web UI's command palette: both front doors resolve the same registry, and one profile has one Session
table. To undo it, `/openrouter-plus preset clear` and confirm it says *inherited* again.

### 4. How to tell it went to the right relay

The status block's first line ends with the address the answering relay reports for itself, and
`npm run smoke:tui` prints the origin it discovered. To compare against a specific port:

```bash
curl -s http://127.0.0.1:8791/__openrouter-plus/health
```

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| *OpenRouter Plus has no reachable relay* | Nothing answered on any candidate. The profile that runs the plugin is not up, `enabled` is false, or the relay failed to bind; `GET /__openrouter-plus/health` on the port settles which. |
| Reads work, a write answers `403 … missing x-oorp-client header` | The relay that answered runs a Host from before this change, which accepts only `web` — usually another profile on the same machine, on an older build. Restart that profile so its row re-applies. |
| `route` answered *could not reach its relay* but the row moved | The first attach to a new endpoint writes the plugin's target table, which reloads the row and rebinds the listener; that can cut the answer to the request that caused it. Run `routes`; the write is idempotent. |
| The status block names 8792 instead of 8791 | `8791` was taken when this process bound, so it fell forward. The resolver found it; nothing to fix unless you want a fixed port. |
| A line says *chosen for this Session* but the bill does not move | Check the first line of `status`: which relay answered, and whether this Session's provider is routed at all. A Session on `none`, or on a provider that is not through the relay, sends nothing to steer. |
| A switch seems to affect nothing, or the wrong conversation | Two profiles are two relays and two Session tables. `status` names the one that answered; the other will disagree. |
| `no provider route named "…"` | `route` takes the provider key as `routes` prints it, not the display name. |
| The command is missing from the palette | No command registry in this composition (the log says so), or the name collided (`could not register /openrouter-plus`). The relay keeps working either way. |

## Internals

The five pieces; `docs/ARCHITECTURE.md` carries the contracts and the seam they sit on.

| Module | What it is |
| --- | --- |
| `lib/tui.js` | The outlet: builds the resolver and the client, registers both names, disposes them with the plugin row. Installed after the relay binds, because every verb is a call to the control API on that address. |
| `lib/tui-command.js` | The text: formatters and dispatch. No socket, no colour, nothing over 80 columns, and a failure is a sentence rather than a thrown handler. |
| `lib/control-client.js` | The API client: one mount prefix, one header, a five-second timeout, and `ControlUnavailable`/`ControlRejected` carrying the reason. |
| `lib/control-origin.js` | Which relay: the candidate list, the health probe, the 30-second cache and the fallback scan. |
| `scripts/tui-smoke.mjs` | The live check behind `npm run smoke:tui`. |
