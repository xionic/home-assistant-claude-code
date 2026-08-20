/*
 * Everything here lands in the app log (Supervisor → app → Log). Milestone logs
 * stay at INFO always; the noisy per-event stream is gated behind the
 * `verbose_logging` option so day-to-day logs stay readable.
 */
import { VERBOSE_LOGGING } from './config.js';

export function log(level, msg) {
  console.log(`[${new Date().toISOString()}] ${level} ${msg}`);
}

export function vlog(msg) {
  if (VERBOSE_LOGGING) log('DEBUG', msg);
}
