# Claude Code UI — Work Report Part 2 (2026-06-17)

Covers: `/usage` note, multi-session + `/resume`, the `/btw` and remote-control
assessments, and the ha-mcp investigation (driven by reading your actual stored
sessions).

---

## Part 1 — Shipped (v2.3.0)

### `/usage` note
The output now leads with: *"⚠️ Real Claude usage/limit information isn't available
through this UI (the full /usage breakdown is an interactive-only feature). The
figures below are just this session's local activity:"* followed by the session
message/turn/cost counts.

### Multi-session, built on Claude Code's own store ✅
This is built directly on Claude Code's canonical transcript store
(`~/.claude/projects/-config/<session-id>.jsonl`) — the **same files the CLI
uses**, so sessions are fully interchangeable with the Claude Terminal add-on and
any other tool sharing this config dir.

- **New "Sessions" button** (history icon) in the header opens a panel listing all
  stored sessions — title (first user message), relative time, with delete buttons.
- **Click any session to resume it** — the server parses its `.jsonl` into the
  same render format and replays it; the SDK's `resume` continues it *in place*
  (verified: resuming kept the same session id and appended turns).
- **`/resume`** opens the same Sessions panel.
- **New chat** starts a fresh session; the previous one is preserved and browsable
  (so the old "your chat will be cleared" confirm is gone — nothing is lost now;
  it only confirms if a response is actively running).
- The server keeps just a tiny `/data/active-session.json` pointer; **all
  transcripts are read from the store** (we no longer keep our own copy). This
  replaced the old single `conversation.json`.

Verified end-to-end via the headless tools: listing (34 sessions parsed with
titles/dates), parsing (user/text/tool_use/tool_result all reconstructed),
create, resume-in-place, and the active-session pointer surviving restarts.

> Note: the store currently contains ~34 sessions, many of which are my test runs
> ("hi", "Test", "PINEAPPLE", "Say hello…"). You can now delete those from the
> Sessions panel — a good way to confirm the feature.

---

## Part 2 — `/btw` (assessment)

From the docs you linked: `/btw` is an **ephemeral side-question** — it has full
visibility into the current conversation, **no tool access**, returns a single
response in a dismissible overlay, **never enters conversation history**, and can
run **even while Claude is working**.

**Feasibility: Moderate (~half day).** It maps cleanly onto the SDK:
- Run a separate `query()` with `resume: <activeSessionId>`, `forkSession: true`
  (so it branches off without modifying the real session), `allowedTools: []`
  (no tools), and the `/btw` text as the prompt. It reuses the parent context.
- Stream the answer into a **dismissible overlay** instead of the transcript, so
  it never touches the main chat.
- Because it's a separate query with its own abort controller, it can run
  concurrently with the main turn — matching "available while Claude is working".
- Cleanup: the fork creates a throwaway session file; delete it after answering
  (or keep it if we later add the "fork into a real session" `f` action).

Not done yet — it's a self-contained feature I can add on request.

---

## Part 3 — Remote control (`/remote-control`)

You clarified you mean Claude Code's `/remote-control` → driving the session from
Anthropic's services (claude.ai / mobile).

**Assessment: not implementable in this add-on.** `/remote-control` is an
interactive feature that brokers the session through Anthropic's hosted relay. It
is **not exposed through the Agent SDK** — it isn't in the SDK's slash-command
list (I checked: the SDK exposes `usage`, `context`, `compact`, etc., but not
`remote-control`), and the relay requires Anthropic-side infrastructure we can't
stand up in a self-hosted container.

Two practical alternatives:
1. **You already have remote access** — this web UI is reachable wherever you can
   reach Home Assistant (LAN, VPN, or Nabu Casa Remote). It's effectively "remote
   control" of an agent running on your Pi, from any browser.
2. If you specifically want Anthropic's relay-based remote control, use
   `/remote-control` from the **Claude Terminal add-on** (the real CLI), not this
   SDK-based UI.

---

## Part 4 — ha-mcp investigation (what you did "yesterday")

I read your actual recent sessions from the store. The two real HA tasks were:

### A. "Are you able to access the frigate conf?" (06-18) — **unanswered**
This session contains **only your question and no response** — it was abandoned
before Claude answered. So this is likely the "lost session" you remember.

- **Can we do it now?** Partially. Frigate's *add-on options* are reachable via the
  Supervisor REST API (our add-on has `hassio_api` + `manager` role), e.g.
  `curl -H "Authorization: Bearer $SUPERVISOR_TOKEN" http://supervisor/addons/<frigate-slug>/info`.
  Frigate's *detection config* (`frigate.yaml`) is directly readable if it lives in
  `/config`. What we **don't** have is a clean, documented path for add-on config
  access — so Claude didn't reach for it.
- **What ha-mcp 7.x adds:** dedicated **add-on management** tools that wrap exactly
  this. Convenience, not a hard capability we lack.

### B. "Add a template for the car temp webhook… replace the input number on machine dash" (06-20)
A long exploratory session (300 KB). The agent *was* doing the work — editing
template YAML and reading the dashboard — and the only hard error was a **url_path
typo** (`dashboard_machines` vs the real `dashboard-machines`), not a missing
capability. The template-sensor + dashboard-edit parts are fully doable with our
tools (`ha-lovelace`, YAML editing).

### The genuine gap (what newest ha-mcp can do that we can't)
Our tools cover states, services, templates, history/stats, registry **search**,
dashboards, and YAML-file editing. What they **don't** cover are
**UI storage-collection mutations**, which aren't YAML-editable and aren't in
`ha-ws-client`:

- Create/edit/delete **helpers** (`input_number`, `input_text`, `input_boolean`,
  `input_select`, `input_datetime`) — *this is the likely match for "replace the
  input number"* if you meant changing the helper itself, not just a dashboard card.
- **Zones**, **scenes captured from current state**, **device-registry** edits
  (rename devices, assign areas), **area** management.
- **Blueprint import** from a URL; **backup/restore**; **add-on management**.

ha-mcp 7.8.1 (84–95+ tools) wraps all of these.

### Recommendation (a cheaper middle path than the Debian rebase)
Rather than reintroduce ha-mcp + rebase Alpine→Debian, I can replicate the
high-value gaps natively (they're all HA WebSocket storage commands, same
mechanism as the `ha-lovelace` helper I already built):

1. **`ha-helpers`** — a small WS CLI for `input_*` helper create/update/delete/list
   (covers your "replace the input number" case).
2. **Documented add-on-config access** via the Supervisor REST API (covers the
   Frigate case) — no new binary needed.
3. Optionally **`ha-registry`** for device rename / area assignment, and a
   blueprint-import helper, if you want them.

This keeps the lean Alpine image, avoids ha-mcp's broken-auth/permission issues,
and still closes the real capability gaps. The full Debian + ha-mcp 7.x route
remains an option if you'd rather have all 84+ tools at once — I'd test
`uvx ha-mcp@7.8.1` on Alpine first before committing to the rebase.

---

## Suggested next steps
1. **`ha-helpers`** (input_* management) — highest-value gap-closer, ~half day.
2. Implement **`/btw`** (ephemeral side-questions) — ~half day.
3. Tidy the session store via the new Sessions panel (delete test sessions).
4. Decide ha-mcp: native helpers (recommended) vs full Debian rebase.
