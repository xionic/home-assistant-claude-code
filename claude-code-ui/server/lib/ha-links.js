/*
 * Home Assistant deep links, so a reply can link straight to the thing it
 * describes.
 *
 * Clients get two things:
 *  - `entities`: every real entity_id, so only things that exist are linkified
 *    (a regex alone would happily link "configuration.yaml").
 *  - `automations`: entity_id → editor id. Automation entities expose their
 *    editor id as an `id` attribute, which is what /config/automation/edit/<id>
 *    wants — the entity_id will not work there.
 */
import { SUPERVISOR_URL } from './config.js';
import { vlog } from './log.js';
import { runtime } from './state.js';

export async function refreshHaLinks() {
  const tok = process.env.SUPERVISOR_TOKEN;
  if (!tok) return;
  try {
    const res = await fetch(`${SUPERVISOR_URL}/core/api/states`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) { vlog(`ha links: /states returned ${res.status}`); return; }
    const states = await res.json();
    const entities = [];
    const automations = {};
    for (const s of states) {
      if (!s || !s.entity_id) continue;
      entities.push(s.entity_id);
      if (s.entity_id.startsWith('automation.') && s.attributes && s.attributes.id != null) {
        automations[s.entity_id] = String(s.attributes.id);
      }
    }
    runtime.haLinks = { entities, automations };
    vlog(`ha links: ${entities.length} entities, ${Object.keys(automations).length} automations`);
  } catch (e) {
    vlog(`ha links refresh failed: ${e.message}`);
  }
}
