/**
 * Starts the Expo dev server pinned to a specific LAN interface.
 *
 * ── Why a script and not just CLI flags ────────────────────────────────────
 * `expo start --host` takes a MODE (`lan` | `tunnel` | `localhost`), not an IP
 * address — `--host 10.0.0.25` is rejected. The only supported way to choose
 * WHICH interface Metro advertises is the REACT_NATIVE_PACKAGER_HOSTNAME
 * environment variable, and that has to be set in the process environment
 * before the CLI boots.
 *
 * That matters on this machine specifically: it has two non-loopback IPv4
 * interfaces — Ethernet (10.0.0.25) and a Radmin VPN adapter (26.188.57.188).
 * If Expo advertises the VPN address, the phone cannot reach Metro and, worse,
 * `Linking.createURL()` bakes that unreachable host into the Supabase auth
 * redirect, which surfaces as "Safari cannot connect to the server" after
 * sign-in rather than as an obvious bundling failure.
 *
 * Override the host when the network changes:
 *   LAN_HOST=192.168.1.50 node scripts/start-native.mjs
 */
import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';

const DEFAULT_HOST = '10.0.0.25';
const PORT = process.env.EXPO_PORT ?? '8090';

const host = process.env.LAN_HOST ?? DEFAULT_HOST;

// Fail loudly rather than advertising an address this machine does not own —
// the resulting failure mode is otherwise very hard to trace back to here.
const owned = Object.entries(networkInterfaces() ?? {})
  .flatMap(([name, addrs]) => (addrs ?? []).map((a) => ({ name, ...a })))
  .filter((a) => a.family === 'IPv4' && !a.internal);

if (!owned.some((a) => a.address === host)) {
  console.error(`\n  ✖ ${host} is not an IPv4 address on this machine.`);
  console.error('    Available interfaces:');
  for (const a of owned) console.error(`      ${a.address}  (${a.name})`);
  console.error(`\n    Re-run with: LAN_HOST=<one of the above> node scripts/start-native.mjs\n`);
  process.exit(1);
}

process.env.REACT_NATIVE_PACKAGER_HOSTNAME = host;

console.log(`\n  Expo dev server pinned to ${host}:${PORT}`);
console.log(`  Expo Go            exp://${host}:${PORT}`);
console.log(`  Web                http://localhost:${PORT}`);
console.log(`  Supabase redirect  exp://${host}:${PORT}/--/auth/callback\n`);

const child = spawn(
  'npx',
  ['expo', 'start', '--lan', '--go', '--port', PORT],
  { stdio: 'inherit', shell: true, env: process.env },
);

child.on('exit', (code) => process.exit(code ?? 0));
