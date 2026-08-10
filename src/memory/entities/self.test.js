/**
 * Owner-reference matching.
 *
 * These two predicates decide what gets attached to a real person's identity
 * node, so the interesting cases are the ones that must NOT match: a fact about
 * a software "user" role is not a fact about the human who owns the store.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getConfig = vi.fn();
vi.mock('../../setup/config-store.js', () => ({ getConfig: () => getConfig() }));
vi.mock('./resolver.js', () => ({ resolveEntity: vi.fn() }));
vi.mock('./store.js', () => ({ setPrimaryEntityType: vi.fn() }));

let self;
beforeEach(async () => {
  vi.resetModules();
  getConfig.mockReset().mockReturnValue({ identity: { name: 'Anmol' } });
  self = await import('./self.js');
});

describe('selfName', () => {
  it('reads the name captured during setup', () => {
    expect(self.selfName()).toBe('Anmol');
  });

  it('returns null when setup never captured one', () => {
    getConfig.mockReturnValue({ identity: { name: null } });
    expect(self.selfName()).toBeNull();
  });

  it('returns null rather than throwing when config is unreadable', () => {
    getConfig.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(self.selfName()).toBeNull();
  });
});

describe('isSelfReference', () => {
  it('matches the placeholder the graph prompt emits', () => {
    for (const n of ['user', 'User', ' the user ', 'I', 'me', 'my', 'owner']) {
      expect(self.isSelfReference(n), n).toBe(true);
    }
  });

  it('matches the owner by their own name, case-insensitively', () => {
    expect(self.isSelfReference('anmol')).toBe(true);
    expect(self.isSelfReference('ANMOL')).toBe(true);
  });

  it('does not match ordinary entities', () => {
    for (const n of ['postgres', 'sigil', 'users', 'user session', '', null]) {
      expect(self.isSelfReference(n), String(n)).toBe(false);
    }
  });

  it('matches only the aliases when no owner name is configured', () => {
    getConfig.mockReturnValue({ identity: { name: null } });
    expect(self.isSelfReference('user')).toBe(true);
    expect(self.isSelfReference('anmol')).toBe(false);
  });
});

describe('isOwnerFact', () => {
  it('matches the real orphaned preferences from the reported store', () => {
    const real = [
      "User's name is Anmol",
      'User prefers implementing functionality at controller/route level rather than extracting to new lib files',
      'User prefers technical content to follow ASD-STE100 Simplified Technical English standard',
      'User prefers progressive layered explanations that start with conceptual foundation',
      'User prefers concise, brief responses and dislikes lengthy explanations',
      'Prefer implementing functionality at controller/route level',
    ];
    for (const c of real) expect(self.isOwnerFact(c), c).toBe(true);
  });

  it('matches first-person phrasing', () => {
    expect(self.isOwnerFact('I use Postgres for everything')).toBe(true);
    expect(self.isOwnerFact('My editor is Neovim')).toBe(true);
    expect(self.isOwnerFact("I don't want auto-formatting on save")).toBe(true);
  });

  it('does NOT match facts about a software user role', () => {
    const notOwner = [
      'User must authenticate before calling the API',
      'Users of the dashboard see a loud banner when the store is unreachable',
      'User accounts are stored in the identity table',
      'The user table has a unique index on email',
      'Payment admins can zero paid_actual for non-WON records',
      'I/O throughput on the embedded engine is 400MB/s',  // "I" is not a pronoun here
      'mycohort-api uses Postgres 15',
    ];
    for (const c of notOwner) expect(self.isOwnerFact(c), c).toBe(false);
  });

  it('ignores empty or non-string input', () => {
    for (const c of ['', '   ', null, undefined, 42]) expect(self.isOwnerFact(c)).toBe(false);
  });
});
