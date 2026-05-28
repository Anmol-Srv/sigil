/**
 * `sigil pair` — manage pairing codes on master.
 *
 *   sigil pair create [--name N] [--role R] [--ns A,B] [--ttl 600]
 *   sigil pair list
 *   sigil pair revoke <id>
 */
import { connectOrStartDaemon } from '../clients/auto-spawn.js';
import { parseFlags } from './flags.js';

const HELP = `sigil pair — create and manage device pairing codes

Usage:
  sigil pair create  --name <device-name> [--role <role>] [--ns ns1,ns2] [--ttl <seconds>]
  sigil pair list
  sigil pair revoke <id>

Roles:
  reader  — read-only access (search, status)
  writer  — read + write (remember, ingest)  (default)
  admin   — full access including device management

The plaintext code is printed once at creation time and never stored.
Hand it to the device you want to pair, along with the master node id.`;

export async function runPair(args) {
  const [sub, ...rest] = args;
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(HELP);
    return;
  }
  switch (sub) {
    case 'create': return cmdCreate(rest);
    case 'list':   return cmdList(rest);
    case 'revoke': return cmdRevoke(rest);
    default:
      console.error(`Unknown subcommand: pair ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

async function cmdCreate(args) {
  const flags = parseFlags(args);
  if (!flags.name) {
    console.error('pair create: --name <device-name> is required');
    process.exit(1);
  }
  const client = await connectOrStartDaemon();
  try {
    const { data } = await client.call('pair.create', {
      name: flags.name,
      role: flags.role || 'writer',
      namespaces: flags.ns ? flags.ns.split(',').map((s) => s.trim()).filter(Boolean) : [],
      ttlSeconds: flags.ttl ? Number(flags.ttl) : undefined,
    });
    console.log(`Pairing code created — share this with "${data.name}":`);
    console.log('');
    console.log(`  code:          ${data.code}`);
    console.log(`  master nodeId: ${data.masterNodeId || '(iroh not running)'}`);
    console.log(`  role:          ${data.role}`);
    console.log(`  namespaces:    ${data.namespaces.length ? data.namespaces.join(', ') : '(all)'}`);
    console.log(`  expires at:    ${data.expiresAt}`);
    console.log('');
    console.log('On the joining device, run:');
    console.log(`  sigil join ${data.masterNodeId || '<master-node-id>'} ${data.code} --name ${data.name}`);
  } finally {
    await client.close();
  }
}

async function cmdList() {
  const client = await connectOrStartDaemon();
  try {
    const { data } = await client.call('pair.list', {});
    if (!data.codes.length) {
      console.log('No pairing codes outstanding.');
      return;
    }
    for (const c of data.codes) {
      const state = c.consumedBy
        ? `consumed by ${c.consumedBy.name} (${c.consumedBy.nodeId.slice(0, 12)}…)`
        : c.expired ? 'EXPIRED' : 'pending';
      console.log(`${c.id}  ${c.name}  ${c.role}  ${state}  expires=${c.expiresAt}`);
    }
  } finally {
    await client.close();
  }
}

async function cmdRevoke(args) {
  const id = args[0];
  if (!id) {
    console.error('pair revoke <id>');
    process.exit(1);
  }
  const client = await connectOrStartDaemon();
  try {
    const { data } = await client.call('pair.revoke', { id: Number(id) });
    console.log(data.deleted ? `Revoked pairing code ${id}.` : `No pairing code with id=${id}.`);
  } finally {
    await client.close();
  }
}

