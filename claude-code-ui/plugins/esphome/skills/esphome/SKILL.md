---
name: esphome
description: Work with ESPHome devices — read/edit their YAML, validate configs, compile firmware, flash over-the-air (OTA), and stream device logs to debug. Use when the user mentions ESPHome, a specific ESP device/board (ESP32/ESP8266/etc.), flashing firmware, or debugging a device that's misbehaving. Requires the add-on's "enable_esphome" option to be on.
---

# ESPHome Skill

The `esphome` CLI is bundled in this add-on (enabled via the `enable_esphome`
option). Use it to validate, compile, flash, and debug ESPHome devices whose YAML
lives in the ESPHome add-on's config folder.

## Where the configs are

Your ESPHome add-on's device YAML is exposed **read/write** inside this add-on.
The folder is in the `$ESPHOME_CONFIG_DIR` environment variable — always resolve
it before doing anything:

```bash
echo "$ESPHOME_CONFIG_DIR"          # usually /config/esphome (the Device Builder folder)
ls "$ESPHOME_CONFIG_DIR"/*.yaml     # each device is a <name>.yaml
```

`secrets.yaml` in that folder holds Wi-Fi/API/OTA secrets — **read it only if you
must, never print secret values back to the user, and never move it.** The ESPHome
dashboard add-on remains the user's editor; you're adding a CLI on top of the same
files, so leave its own bookkeeping files (`.esphome/`, hidden dirs) alone.

## Commands

Run from anywhere with a full path, or `cd "$ESPHOME_CONFIG_DIR"` first.

```bash
esphome config   <device>.yaml     # validate & show the fully-rendered config (safe, read-only)
esphome compile  <device>.yaml     # build firmware (first build per chip downloads the toolchain — slow)
esphome upload   <device>.yaml     # OTA-flash the already-built firmware to the device
esphome run      <device>.yaml     # compile + upload + then tail logs
esphome logs     <device>.yaml     # stream the device's live logs over its API/OTA (great for debugging)
```

## Workflow rules

1. **Validate before you build or flash.** Always run `esphome config <file>`
   first and fix any errors it reports. If it doesn't validate, do not compile or
   upload.
2. **Confirm before flashing.** `upload`/`run` change firmware on real hardware.
   State plainly which device you're about to flash and why, and get the user's
   go-ahead before running it. Prefer OTA (the default); only mention serial if the
   device is unreachable over the network.
3. **Debugging a misbehaving device:** start with `esphome logs <file>` to watch
   what it's actually doing — that's usually faster than guessing from the YAML.
   The device must be online and reachable on the network for logs.
4. **First-time slowness is normal.** The very first `compile` for a chip family
   downloads the PlatformIO toolchain (hundreds of MB) and can take several
   minutes on a Raspberry Pi; later builds are much faster (cached under `/data`).
5. **If `esphome` says it isn't installed,** the background install hasn't
   finished (or the option is off). Tell the user to check the add-on log / wait a
   few minutes — don't try to install it yourself.
6. **After an add-on upgrade,** the system build tools (patch, compilers) reinstall
   automatically on start (in the background). If a compile fails on a missing
   system tool right after an upgrade, wait a minute and retry — don't apt-install
   by hand (it'd just be wiped by the next upgrade).

## Editing YAML

Edit device YAML with the normal file tools (the same HA-YAML conventions apply:
spaces not tabs, valid YAML). After editing, `esphome config` to validate, then
`compile`/`upload` as needed. Keep changes minimal and explain what each does.
