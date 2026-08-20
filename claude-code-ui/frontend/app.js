/*
 * Claude Code UI — the browser half.
 *
 * This file is the composition root: it pulls in the modules under js/ (each of
 * which wires up its own DOM listeners as it loads), restores anything that
 * should survive a reload, and opens the connection.
 *
 * There is no build step, by design — the app is served straight from the
 * container and loaded through the Home Assistant ingress. The modules are
 * plain ES modules that the browser loads itself.
 *
 *   dom.js          every element the app touches
 *   state.js        the few values several modules share
 *   connection.js   the WebSocket and the server-message dispatch
 *   transcript.js   building the chat
 *   links.js        markdown, entity links, copy buttons
 *   dialogs.js      permission prompts and questions
 *   composer.js     the message box
 *   commands.js     slash commands and their menu
 *   attachments.js  images and files
 *   sessions.js     the sessions panel
 *   settings.js     model, effort, auto-continue
 *   banners.js      the usage-limit banner
 *   model.js        model dropdown and the context meter
 *   thinking.js     the working indicator
 *   find.js         find in chat
 *   scroll.js       scroll anchoring and the auto-hiding header
 *   promptnav.js    the ↑/↓ prompt arrows
 */
import { promptInput } from './js/dom.js';
import { connect } from './js/connection.js';
import { resizeTextarea, updateSendBtn } from './js/composer.js';

// Modules with no exported entry point still have to be loaded: each one wires
// up its own listeners as it evaluates.
import './js/attachments.js';
import './js/commands.js';
import './js/dialogs.js';
import './js/find.js';
import './js/sessions.js';
import './js/settings.js';
import './js/banners.js';
import './js/scroll.js';
import './js/promptnav.js';

// Restore any draft the user was typing before navigating away.
const draft = localStorage.getItem('draft');
if (draft) { promptInput.value = draft; resizeTextarea(); updateSendBtn(); }

connect();
