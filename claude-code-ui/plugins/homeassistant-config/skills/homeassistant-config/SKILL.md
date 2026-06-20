---
name: homeassistant-config
description: Create and manage Home Assistant YAML configuration files including automations, scripts, templates, blueprints, Lovelace dashboards, and file organization. Use when working with Home Assistant configuration files (.yaml, .yml) or discussing HA automations, scripts, sensors, or dashboards.
---

# Home Assistant Configuration Skill

Create and manage Home Assistant YAML configuration files including automations, scripts, templates, blueprints, and file organization.

## Slash Commands

- `/ha-find-duplicates [path]` — Find duplicate automations and scripts in configuration

## Subagents

- `ha-suggestions` — Smart home improvement advisor for automations, scenes, and device recommendations

## Pre-Save Validation Hook

This plugin includes a pre-save hook that automatically validates YAML files before saving. It checks for:
- Tab characters (HA requires spaces)
- Basic YAML syntax errors

The hook runs automatically on Write/Edit operations for `.yaml` and `.yml` files.

## YAML Requirements

- **Indentation**: 2 spaces per level (never tabs)
- **Strings**: Quote boolean-like values (`"on"`, `"off"`, `"yes"`, `"no"`)
- **Lists**: Use `-` prefix with proper indentation
- **Comments**: Use `#` for inline documentation
- **Key Terms**: Use `action:` (not `service:`), `triggers:` (not `trigger:`), `actions:` (not `action:` for sequences)

## File Organization

### Basic Includes

```yaml
# configuration.yaml
automation: !include automations.yaml
script: !include scripts.yaml
sensor: !include sensors.yaml
```

### Directory Includes

```yaml
automation: !include_dir_merge_list automations/
sensor: !include_dir_merge_list sensors/
```

### Secrets Management

```yaml
# secrets.yaml
mqtt_password: "super_secret_password"
api_key: "your-api-key-here"

# configuration.yaml
mqtt:
  password: !secret mqtt_password
```

## Automations (2024+ Syntax)

### Basic Structure

```yaml
automation:
  - alias: "Descriptive Name"
    id: unique_automation_id
    description: "What this automation does"
    mode: single  # single, restart, queued, parallel
    triggers:
      - trigger: state
        entity_id: binary_sensor.motion
        to: "on"
    conditions:
      - condition: time
        after: "sunset"
    actions:
      - action: light.turn_on
        target:
          entity_id: light.living_room
```

### Common Triggers

**State Trigger**
```yaml
triggers:
  - trigger: state
    entity_id: sensor.temperature
    from: "off"
    to: "on"
    for:
      minutes: 5
```

**Time Trigger**
```yaml
triggers:
  - trigger: time
    at: "07:00:00"
```

**Sun Trigger**
```yaml
triggers:
  - trigger: sun
    event: sunset
    offset: "-00:30:00"
```

**Template Trigger**
```yaml
triggers:
  - trigger: template
    value_template: "{{ states('sensor.power') | float > 1000 }}"
```

### Common Actions

**Service Call**
```yaml
actions:
  - action: light.turn_on
    target:
      entity_id: light.bedroom
    data:
      brightness_pct: 50
      color_temp: 350
```

**If-Then-Else**
```yaml
actions:
  - if:
      - condition: state
        entity_id: sun.sun
        state: "below_horizon"
    then:
      - action: light.turn_on
        target:
          entity_id: light.porch
    else:
      - action: light.turn_off
        target:
          entity_id: light.porch
```

**Choose**
```yaml
actions:
  - choose:
      - conditions:
          - condition: state
            entity_id: sun.sun
            state: "below_horizon"
        sequence:
          - action: light.turn_on
            target:
              entity_id: light.porch
    default:
      - action: light.turn_off
        target:
          entity_id: light.porch
```

**Wait for Trigger**
```yaml
actions:
  - action: light.turn_on
    target:
      entity_id: light.porch
  - wait_for_trigger:
      - trigger: state
        entity_id: binary_sensor.motion
        to: "off"
    timeout:
      minutes: 10
    continue_on_timeout: true
  - action: light.turn_off
    target:
      entity_id: light.porch
```

## Scripts

```yaml
script:
  morning_routine:
    alias: "Morning Routine"
    description: "Start the day"
    fields:
      brightness:
        description: "Light brightness"
        default: 100
        selector:
          number:
            min: 0
            max: 100
    sequence:
      - action: light.turn_on
        target:
          area_id: bedroom
        data:
          brightness_pct: "{{ brightness }}"
```

## Jinja2 Templates

```yaml
# Get state
{{ states('sensor.temperature') }}

# Get attribute
{{ state_attr('climate.thermostat', 'current_temperature') }}

# Arithmetic
{{ states('sensor.power') | float * 0.15 | round(2) }}

# Date/time
{{ now().strftime('%H:%M') }}
```

### Template Sensors

```yaml
template:
  - sensor:
      - name: "Total Power Usage"
        unit_of_measurement: "W"
        state: >
          {{ states('sensor.plug_1_power') | float(0) +
             states('sensor.plug_2_power') | float(0) }}
        availability: >
          {{ states('sensor.plug_1_power') not in ['unknown', 'unavailable'] }}
```

## Lovelace Dashboards

### Basic Structure

```yaml
# ui-lovelace.yaml
title: My Home
views:
  - title: Home
    path: home
    icon: mdi:home
    cards:
      - type: entities
        title: Living Room
        entities:
          - light.living_room
          - switch.fan
```

### Common Cards

**Entities Card**
```yaml
type: entities
title: Room Controls
state_color: true
entities:
  - entity: light.ceiling
    name: Ceiling Light
```

**Button Card**
```yaml
type: button
entity: light.bedroom
name: Bedroom
icon: mdi:lightbulb
tap_action:
  action: toggle
```

**Area Card**
```yaml
type: area
area: living_room
display_type: compact
```

**Conditional Card**
```yaml
type: conditional
conditions:
  - condition: state
    entity: person.john
    state: home
card:
  type: entities
  entities:
    - light.johns_room
```

## Blueprints

```yaml
blueprint:
  name: Motion-activated Light
  description: Turn on a light when motion is detected
  domain: automation
  input:
    motion_sensor:
      name: Motion Sensor
      selector:
        entity:
          filter:
            - domain: binary_sensor
              device_class: motion
    target_light:
      name: Light
      selector:
        target:
          entity:
            - domain: light

triggers:
  - trigger: state
    entity_id: !input motion_sensor
    to: "on"

actions:
  - action: light.turn_on
    target: !input target_light
```

## Common Issues

| Problem | Solution |
|---------|----------|
| Tab characters | Replace with 2 spaces |
| Unquoted booleans | Quote `"on"`, `"off"`, `"yes"`, `"no"` |
| Template errors | Test in Developer Tools > Template |
| Entity not found | Check entity_id spelling in Developer Tools > States |
| Automation not firing | Check trace in Automations UI |

## Live HA Access Tools

**IMPORTANT — tool selection rules:**
- Use **ha-ws-client** for entity states, service calls, template rendering, registry search, traces, history.
- Use **ha-lovelace** for dashboard config (list / get / save). Lovelace lives only on the WebSocket API — the REST endpoints `/api/lovelace/config` and `/api/lovelace/dashboards` return **404** and must not be used.
- For **YAML-mode dashboards**, edit the dashboard `.yaml` files directly in `/config`.
- Never ask the user for a long-lived access token — `$SUPERVISOR_TOKEN` is available automatically and is sufficient for everything above.

All tools authenticate automatically using `$SUPERVISOR_TOKEN` — no additional setup required.

### Editing dashboards (ha-lovelace)

```bash
# List storage-mode dashboards (empty result → default dashboard is YAML-mode or auto-generated)
ha-lovelace list

# Get a dashboard config (omit url_path for the default dashboard)
ha-lovelace get
ha-lovelace get my-dashboard

# Save a config from a JSON file or stdin (full config object: {"views":[...]})
ha-lovelace save /tmp/dash.json
ha-lovelace save /tmp/dash.json my-dashboard
echo '{"views":[{"title":"Home","cards":[]}]}' | ha-lovelace save -
```

Workflow for an edit: `ha-lovelace get [url_path] > /tmp/dash.json`, modify the JSON, then `ha-lovelace save /tmp/dash.json [url_path]`.

**Mode matters:**
- **Storage mode** → use `ha-lovelace get`/`save` as above.
- **YAML mode** → `save` will fail; instead edit the YAML file referenced by `lovelace:` in `/config/configuration.yaml` (commonly `/config/ui-lovelace.yaml` or files under `/config/dashboards/`). The user then reloads dashboard resources or restarts HA.

### ha-ws-client (WebSocket — preferred for live data)

```bash
# Test connection
ha-ws-client ping

# Get a single entity state (--json for machine-readable output)
ha-ws-client state sensor.temperature --json
ha-ws-client state light.living_room

# Get all states, optionally filtered by pattern
ha-ws-client states-filter "sensor.*" --json
ha-ws-client states-filter "light.*"

# Call a service
ha-ws-client call light turn_on '{"entity_id": "light.living_room", "brightness_pct": 80}'
ha-ws-client call climate set_temperature '{"entity_id": "climate.thermostat", "temperature": 21}'
ha-ws-client call input_boolean turn_on '{"entity_id": "input_boolean.guest_mode"}'

# Render a Jinja2 template
ha-ws-client template '{{ states("sensor.temperature") | float | round(1) }}'
ha-ws-client template '{{ state_attr("climate.thermostat", "current_temperature") }}'

# Search entity/device/area registry
ha-ws-client entities humidity --json
ha-ws-client devices "phone" --json
ha-ws-client areas --json

# Fire an event
ha-ws-client fire-event custom_event '{"key": "value"}'

# Get HA config / list services
ha-ws-client config --json
ha-ws-client services --json

# Diagnostics
ha-ws-client compare sensor.temp_bedroom sensor.temp_living_room
```

### REST API via supervisor proxy (curl — use for dashboard editing)

The supervisor proxy at `http://supervisor/core/api/` handles authentication automatically with `$SUPERVISOR_TOKEN`.

```bash
# Get entity state
curl -s -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  http://supervisor/core/api/states/sensor.temperature | jq .

# Call a service
curl -s -X POST \
  -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "light.living_room"}' \
  http://supervisor/core/api/services/light/turn_on
```

> Dashboards are **not** available over REST (those endpoints 404). Use `ha-lovelace` (see above) or edit YAML files directly.
