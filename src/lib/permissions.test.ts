import { describe, expect, it } from 'vitest';
import { ForbiddenError } from './errors';
import {
  assertCan,
  canApproveSermon,
  canEditSermon,
  canRetrySermon,
  canViewSermon,
  can,
  CAPABILITY_ROLES,
  type Capability,
} from './permissions';
import { ROLES, type Role } from './roles';
import { SERMON_STATUSES, type SermonStatus } from './sermon-status';

const ALL = Object.keys(CAPABILITY_ROLES).sort() as Capability[];
const capabilitiesOf = (role: Role) => ALL.filter((c) => can(role, c));

// SPEC §2, written out per role so a change to the matrix has to change a test.
describe('role capabilities', () => {
  it('viewers can only browse the library', () => {
    expect(capabilitiesOf('viewer')).toEqual(['library.browse']);
  });

  it('contributors can browse, upload and review, and nothing administrative', () => {
    expect(capabilitiesOf('contributor')).toEqual([
      'library.browse',
      'sermon.review',
      'sermon.upload',
    ]);
  });

  it('admins can do everything', () => {
    expect(capabilitiesOf('admin')).toEqual(ALL);
  });

  it.each([
    'sermon.publish',
    'vault.open',
    'connections.manage',
    'team.manage',
    'settings.manage',
    'sermon.editAfterApproval',
  ] as const)('%s is admin-only', (capability) => {
    for (const role of ROLES) expect(can(role, capability)).toBe(role === 'admin');
  });

  it('assertCan throws ForbiddenError for a missing capability and passes otherwise', () => {
    expect(() => assertCan('contributor', 'vault.open')).toThrow(ForbiddenError);
    expect(() => assertCan('viewer', 'sermon.upload')).toThrow(ForbiddenError);
    expect(() => assertCan('admin', 'vault.open')).not.toThrow();
  });
});

const me = { id: 'me' };
const other = 'someone-else';
const approvedStates: SermonStatus[] = ['approved', 'filing', 'filed'];
const draftStates = SERMON_STATUSES.filter((s) => !approvedStates.includes(s));

describe('canViewSermon (viewers: approved only; contributors: own drafts + approved)', () => {
  it.each(approvedStates)('everyone can view a %s sermon', (status) => {
    for (const role of ROLES) {
      expect(canViewSermon({ ...me, role }, { contributorId: other, status })).toBe(true);
    }
  });

  it.each(draftStates)('viewers never see a %s sermon', (status) => {
    expect(canViewSermon({ ...me, role: 'viewer' }, { contributorId: 'me', status })).toBe(false);
    expect(canViewSermon({ ...me, role: 'viewer' }, { contributorId: other, status })).toBe(false);
  });

  it.each(draftStates)('contributors see their own %s sermon but not someone else’s', (status) => {
    const actor = { ...me, role: 'contributor' as const };
    expect(canViewSermon(actor, { contributorId: 'me', status })).toBe(true);
    expect(canViewSermon(actor, { contributorId: other, status })).toBe(false);
  });

  it.each(draftStates)('admins see a %s sermon from anyone', (status) => {
    expect(canViewSermon({ ...me, role: 'admin' }, { contributorId: other, status })).toBe(true);
  });
});

describe('canEditSermon', () => {
  it('lets a contributor edit their own sermon before approval only', () => {
    const actor = { ...me, role: 'contributor' as const };
    for (const status of draftStates) {
      expect(canEditSermon(actor, { contributorId: 'me', status })).toBe(true);
    }
    for (const status of approvedStates) {
      expect(canEditSermon(actor, { contributorId: 'me', status })).toBe(false);
    }
  });

  it('does not let a contributor edit someone else’s sermon (D2 default)', () => {
    const actor = { ...me, role: 'contributor' as const };
    expect(canEditSermon(actor, { contributorId: other, status: 'needs_review' })).toBe(false);
  });

  it('lets admins edit anything, including after approval', () => {
    for (const status of SERMON_STATUSES) {
      expect(canEditSermon({ ...me, role: 'admin' }, { contributorId: other, status })).toBe(true);
    }
  });

  it('never lets viewers edit', () => {
    for (const status of SERMON_STATUSES) {
      expect(canEditSermon({ ...me, role: 'viewer' }, { contributorId: 'me', status })).toBe(false);
    }
  });
});

describe('canApproveSermon (D1: contributors approve their own)', () => {
  it('lets a contributor approve their own sermon once it needs review', () => {
    const actor = { ...me, role: 'contributor' as const };
    expect(canApproveSermon(actor, { contributorId: 'me', status: 'needs_review' })).toBe(true);
    expect(canApproveSermon(actor, { contributorId: other, status: 'needs_review' })).toBe(false);
  });

  it('lets admins approve any sermon that needs review', () => {
    expect(
      canApproveSermon({ ...me, role: 'admin' }, { contributorId: other, status: 'needs_review' }),
    ).toBe(true);
  });

  it('never lets viewers approve', () => {
    expect(
      canApproveSermon({ ...me, role: 'viewer' }, { contributorId: 'me', status: 'needs_review' }),
    ).toBe(false);
  });

  it.each(SERMON_STATUSES.filter((s) => s !== 'needs_review'))(
    'nobody can approve a sermon that is %s',
    (status) => {
      for (const role of ROLES) {
        expect(canApproveSermon({ ...me, role }, { contributorId: 'me', status })).toBe(false);
      }
    },
  );
});

describe('canRetrySermon', () => {
  it('lets the uploader and admins retry a failed sermon', () => {
    expect(
      canRetrySermon({ ...me, role: 'contributor' }, { contributorId: 'me', status: 'failed' }),
    ).toBe(true);
    expect(
      canRetrySermon({ ...me, role: 'admin' }, { contributorId: other, status: 'failed' }),
    ).toBe(true);
  });

  it('refuses other contributors and viewers', () => {
    expect(
      canRetrySermon({ ...me, role: 'contributor' }, { contributorId: other, status: 'failed' }),
    ).toBe(false);
    expect(
      canRetrySermon({ ...me, role: 'viewer' }, { contributorId: 'me', status: 'failed' }),
    ).toBe(false);
  });

  it('refuses everyone for a sermon that has not failed, or was deleted', () => {
    for (const status of SERMON_STATUSES.filter((s) => s !== 'failed')) {
      for (const role of ROLES) {
        expect(canRetrySermon({ ...me, role }, { contributorId: 'me', status })).toBe(false);
      }
    }
    expect(
      canRetrySermon(
        { ...me, role: 'admin' },
        { contributorId: 'me', status: 'failed', deleted: true },
      ),
    ).toBe(false);
  });
});
