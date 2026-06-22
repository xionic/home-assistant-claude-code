# Claude Code UI — Work Report Part 3 (2026-06-20)

Covers: the in-chat Find feature, the ha-lovelace-vs-ha-mcp question (with hard
test data), and the ha-mcp discussion grepped from your sessions.

---

## Part 1 — Shipped (v2.4.0)

### Find in chat ✅
- **Find bar** with a search input, live `current/total` match count, and
  **prev / next / close** controls.
- Triggered by **Ctrl/Cmd+F** or the **`/find`** command.
- Highlights all matches; the active match is emphasised and scrolled to center.
  **Enter** = next, **Shift+Enter** = previous, **Esc** = close.
- If a match is inside a collapsed tool-call card, it auto-expands so you can see it.

---

## Part 2 — ha-lovelace vs ha-mcp (the real decision)

### Can ha-mcp do what ha-lovelace does?
**Yes.** ha-mcp has dashboard get/set/list tools, so it fully covers ha-lovelace —
and it's a superset (helpers, zones, scenes, device registry, blueprints, add-on
management, ~84 tools total). Adopting ha-mcp would let us retire `ha-lovelace`
(and the proposed `ha-helpers`).

### So why didn't we just use it? — three real blockers (tested today)

**1. ha-mcp 7.8.1 needs Python ≥3.13; our image has 3.12.**
I tested `uvx ha-mcp@7.8.1` on the live add-on:
```
Because the current Python version (3.12.13) does not satisfy Python>=3.13,<3.14
and ha-mcp==7.8.1 depends on Python>=3.13 … requirements are unsatisfiable.
```
And `uvx --python 3.13 …` (asking uv to fetch its own Python) failed too:
```
No interpreter found for Python 3.13 in managed installations or search path
```
So uv can't conjure a musl 3.13 here. **This confirms your instinct that updating
ha-mcp needs a new base image.** Good news: it does **not** require Debian — we're
on `ghcr.io/home-assistant/aarch64-base:3.21` (Alpine, Python 3.12), and HA also
publishes **`ghcr.io/home-assistant/aarch64-base-python:3.13-alpineXX`**. Switching
`build_from` to that keeps us on lean Alpine/musl and just bumps Python to 3.13 —
a one-line base change plus a rebuild/retest, not a Debian migration.

**2. The original auth problem may still apply.**
ha-mcp's historical failure here was WebSocket auth with `SUPERVISOR_TOKEN`
(the "Invalid authentication token" / "WebSocket not authenticated" errors we
chased and fixed by disabling it). Whether 7.x authenticates cleanly with
`SUPERVISOR_TOKEN`, or still wants a long-lived token, **needs a functional test**
once it can install. Not yet verified.

**3. MCP tools bypass our permission UI.**
This is an Agent SDK limitation, not ha-mcp's fault: `canUseTool` is **not** called
for MCP-server tools, only for built-in tools. So in **Ask** mode, ha-mcp tool
calls would run **without prompting**. Our Bash-based CLIs (`ha-ws-client`,
`ha-lovelace`) go through `canUseTool` and *do* honour the mode. In **Auto** or
**Bypass** mode this doesn't matter (no prompts anyway), so if you mostly run Auto,
it's a non-issue.

### What the grep found (your "problems with it" memory)
Grepping your sessions for `ha-mcp` surfaced exactly one session — and it's the
**setup script + the auth investigation we already did**. It references the
upstream repo `homeassistant-ai/ha-mcp` (OAuth-based in the original heytcass
add-on) and the `setup-ha-mcp.sh` that configured it. The "problems" you remember
are the `SUPERVISOR_TOKEN` WebSocket-auth failures — already diagnosed and the
reason ha-mcp is currently disabled.

### Recommendation
Your preference for a supported library is reasonable, and the only hard blocker is
the Python base. So I'd suggest a **focused, low-risk spike** (separate branch):

1. Switch `build_from` → HA `base-python:3.13-alpine…` (stay on Alpine).
2. Enable ha-mcp **7.8.1**, point it at `http://supervisor/core` with
   `SUPERVISOR_TOKEN`, and **functionally test auth** (read a state, then *edit a
   dashboard* — the operation that used to fail).
3. If auth is clean: adopt ha-mcp, **retire `ha-lovelace`**, and you gain helpers/
   zones/scenes/registry/add-on tools for free. Default permission mode → Auto so
   the MCP permission-bypass is moot.
4. If auth still needs a long-lived token: either add an optional `ha_token`
   (we already have the config field) or stick with the lean CLIs.

This gets you onto the supported library if (and only if) it actually
authenticates in this environment — decided by one test rather than a guess. I can
run that spike on request; it's ~half a day including the rebuild/retest cycle.

---

## Suggested next steps
1. **ha-mcp spike** (base-python:3.13 + functional auth test) — decides
   library-vs-custom for good. Recommended before building any more custom CLIs.
2. If you'd rather stay lean now, I'll add **`ha-helpers`** (input_* management) to
   close the one concrete gap from your recent tasks.
3. Tidy the session store via the Sessions panel (it has ~34 entries, many my tests).
4. `/btw` remains available to build (ephemeral side-questions).
