/*
 * Shelling out, for the diagnostic probes. Output is capped so a chatty command
 * cannot produce a diagnostic response too large to read.
 */
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function runCmd(cmd, timeoutMs = 15000) {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: timeoutMs, env: process.env, maxBuffer: 1024 * 1024, shell: '/bin/bash',
    });
    return { ok: true, stdout: stdout.toString().trim().slice(0, 1500), stderr: stderr.toString().trim().slice(0, 400) };
  } catch (e) {
    return {
      ok: false,
      error: String(e.message || e).slice(0, 400),
      stdout: String(e.stdout || '').trim().slice(0, 1500),
      stderr: String(e.stderr || '').trim().slice(0, 400),
    };
  }
}
