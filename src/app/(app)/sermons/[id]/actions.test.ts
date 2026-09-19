import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireCapability = vi.fn();
const revalidatePath = vi.fn();
const service = {
  updateDetails: vi.fn(),
  saveSummary: vi.fn(),
  requestRegenerate: vi.fn(),
  addScriptureRef: vi.fn(),
  editScriptureRef: vi.fn(),
  deleteScriptureRef: vi.fn(),
  approveSermon: vi.fn(),
};
vi.mock('@/lib/auth/guard', () => ({ requireCapability }));
vi.mock('@/db/client', () => ({ getDb: () => ({ db: true }) }));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('@/lib/review/service', async (original) => ({
  ...(await original<typeof import('@/lib/review/service')>()),
  ...service,
}));

const actions = await import('./actions');
const { ReviewError } = await import('@/lib/review/service');

const ID = '6f1c2d3e-4a5b-4c6d-8e7f-1a2b3c4d5e6f';
const user = { id: 'u1', role: 'contributor' };

describe('review server actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireCapability.mockResolvedValue(user);
  });

  it('check the review capability first and do nothing if it fails', async () => {
    requireCapability.mockRejectedValue(new Error('NEXT_HTTP_ERROR_FALLBACK;403'));
    await expect(actions.approveAction(ID)).rejects.toThrow(/403/);
    await expect(actions.saveDetailsAction(ID, {})).rejects.toThrow(/403/);
    expect(requireCapability).toHaveBeenCalledWith('sermon.review');
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });

  it('reject an id that is not a UUID before reaching the service', async () => {
    expect(await actions.approveAction('../etc')).toEqual({
      ok: false,
      error: 'Sermon not found.',
    });
    expect(service.approveSermon).not.toHaveBeenCalled();
  });

  it('pass the signed-in user, never one supplied by the caller', async () => {
    service.updateDetails.mockResolvedValue({ changed: ['title'] });
    const result = await actions.saveDetailsAction(ID, { title: 'New' });
    expect(result).toEqual({ ok: true, changed: ['title'] });
    expect(service.updateDetails).toHaveBeenCalledWith({ db: true }, user, ID, { title: 'New' });
  });

  it('refresh the sermon page and the library after a change', async () => {
    service.approveSermon.mockResolvedValue({ stem: 'a_b_c' });
    expect(await actions.approveAction(ID)).toEqual({ ok: true, stem: 'a_b_c' });
    expect(revalidatePath).toHaveBeenCalledWith(`/sermons/${ID}`);
    expect(revalidatePath).toHaveBeenCalledWith('/library');
  });

  it('turn a refused change into a message and field errors, without refreshing', async () => {
    service.updateDetails.mockRejectedValue(
      new ReviewError('invalid', 'Check the highlighted fields.', { title: 'Too long.' }),
    );
    expect(await actions.saveDetailsAction(ID, {})).toEqual({
      ok: false,
      error: 'Check the highlighted fields.',
      fieldErrors: { title: 'Too long.' },
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('let unexpected errors through instead of pretending they were handled', async () => {
    service.saveSummary.mockRejectedValue(new Error('connection lost'));
    await expect(actions.saveSummaryAction(ID, 'x')).rejects.toThrow('connection lost');
  });

  it.each([
    ['saveSummaryAction', () => actions.saveSummaryAction(ID, 'text'), 'saveSummary'],
    ['regenerateSummaryAction', () => actions.regenerateSummaryAction(ID), 'requestRegenerate'],
    ['addPassageAction', () => actions.addPassageAction(ID, {}), 'addScriptureRef'],
    ['editPassageAction', () => actions.editPassageAction(ID, 'r1', {}), 'editScriptureRef'],
    ['deletePassageAction', () => actions.deletePassageAction(ID, 'r1'), 'deleteScriptureRef'],
  ] as const)('%s calls the matching service function', async (_name, call, fn) => {
    service[fn].mockResolvedValue({ id: 'r9' });
    const result = await call();
    expect(result.ok).toBe(true);
    expect(service[fn]).toHaveBeenCalledOnce();
  });
});
