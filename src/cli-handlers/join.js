/**
 * `sigil join <master-node-id> <pairing-code> [--name laptop-b] [--addresses host:port,...]`
 *
 * Run on a fresh device to enroll with an existing master. Uses the
 * local Sigil's own identity (~/.sigil/identity.key) and dials master
 * over Iroh sigil/pair/1.
 *
 * On success:
 *   - Master records this device's NodeID in its `device` table
 *   - We persist SIGIL_MASTER_NODE_ID in ~/.sigil/.env
 *   - We flip SIGIL_MODE to 'follower' (or 'lite-follower' if --lite)
 *
 * Iroh resolves the master's transport details (relay + direct addrs)
 * automatically when --addresses isn't given.
 */
import { hostname } from 'node:os';

import { getSigilVersion } from '../lib/version.js';
import { parseFlags } from './flags.js';

const HELP = `sigil join — pair this device with a Sigil master

Usage:
  sigil join <master-node-id> <pairing-code> [--name <name>]
              [--addresses host:port,host:port]
              [--relay <url>]
              [--lite]

The master prints both the node id and the pairing code when you run
\`sigil pair create\` on it.`;

export async function runJoin(args) {
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }

  const positional = args.filter((a) => !a.startsWith('--'));
  if (positional.length < 2) {
    console.error('Usage: sigil join <master-node-id> <pairing-code> [options]');
    process.exit(1);
  }
  const [masterNodeId, code] = positional;
  const flags = parseFlags(args);
  const name = flags.name || hostname();
  const addresses = flags.addresses ? flags.addresses.split(',').map((s) => s.trim()) : undefined;
  const relayUrl = flags.relay || undefined;
  const lite = Boolean(flags.lite);

  // We must boot Iroh on this side to dial. Force network on if it's not
  // already configured.
  if (process.env.SIGIL_MODE === undefined || process.env.SIGIL_MODE === 'solo') {
    process.env.SIGIL_MODE = lite ? 'lite-follower' : 'follower';
    process.env.SIGIL_NETWORK_ENABLED = 'true';
  }

  const { joinMaster } = await import('../net/pairing.js');
  const version = getSigilVersion();

  console.log(`[sigil] joining master ${masterNodeId.slice(0, 12)}…`);
  const result = await joinMaster({
    masterAddr: { nodeId: masterNodeId, relayUrl, addresses },
    code,
    name,
    sigilVersion: version,
  });

  if (!result.ok) {
    console.error(`Pairing rejected: ${result.error?.code} — ${result.error?.message}`);
    process.exit(1);
  }

  console.log('✓ paired successfully');
  console.log(`  device id:        ${result.device.id}`);
  console.log(`  role:             ${result.device.role}`);
  console.log(`  namespaces:       ${(result.device.namespaces || []).join(', ') || '(all)'}`);
  console.log(`  master nodeId:    ${result.masterNodeId}`);

  // Verify the master's schema manifest matches what THIS device can
  // produce. Failure is fatal for full-stack followers (their facts
  // would silently corrupt the cluster's vector space). Lite followers
  // tolerate it — they don't store anything anyway.
  if (result.manifest) {
    const { produceManifest, verifyManifest } = await import('../memory/manifest.js');
    const local = await produceManifest();
    const verdict = verifyManifest(local, result.manifest);
    if (verdict.warnings.length) {
      console.log('\nManifest warnings:');
      for (const w of verdict.warnings) console.log(`  ⚠ ${w}`);
    }
    if (!verdict.ok) {
      console.error('\nManifest errors:');
      for (const e of verdict.errors) console.error(`  ✗ ${e}`);
      if (!lite) {
        console.error('\nFollower mode requires a matching manifest. Either align the config on');
        console.error('this device (embedding model/dim, chunker, migrations) or join as a');
        console.error('lite-follower (which never stores facts locally): retry with --lite');
        process.exit(1);
      } else {
        console.error('\nProceeding as lite-follower — manifest drift OK because lite-follower');
        console.error('devices never store facts locally.');
      }
    } else {
      console.log('✓ schema manifest matches master');
    }
  }

  // Persist mode + master node id in ~/.sigil/.env so subsequent runs
  // start in follower mode automatically.
  try {
    const { connectOrStartDaemon } = await import('../clients/auto-spawn.js');
    const client = await connectOrStartDaemon({ quiet: true });
    await client.call('writeEnv', {
      patch: {
        SIGIL_MODE: lite ? 'lite-follower' : 'follower',
        SIGIL_MASTER_NODE_ID: result.masterNodeId,
        SIGIL_NETWORK_ENABLED: 'true',
      },
    });
    await client.close();
    console.log('✓ updated ~/.sigil/.env (SIGIL_MODE, SIGIL_MASTER_NODE_ID)');
  } catch (err) {
    console.error(`(warning: failed to persist mode to .env: ${err.message})`);
  }
}
