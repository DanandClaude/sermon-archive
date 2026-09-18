import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireCapability = vi.fn();
const updateSettings = vi.fn();
vi.mock('@/lib/auth/guard', () => ({ requireCapability }));
vi.mock('@/lib/settings', () => ({ updateSettings }));
vi.mock('@/db/client', () => ({ getDb: () => ({}) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { saveSettings } = await import('./actions');

const idle = { status: 'idle' as const, values: { churchName: '', defaultSpeaker: '' } };
const form = (churchName: string) => {
  const data = new FormData();
  data.set('churchName', churchName);
  data.set('defaultSpeaker', '');
  return data;
};

describe('saveSettings server action', () => {
  beforeEach(() => vi.clearAllMocks());

  it('checks the settings.manage capability and stops before touching settings if it fails', async () => {
    requireCapability.mockRejectedValue(new Error('NEXT_HTTP_ERROR_FALLBACK;403'));
    await expect(saveSettings(idle, form('Anything'))).rejects.toThrow(/403/);
    expect(requireCapability).toHaveBeenCalledWith('settings.manage');
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('saves for a permitted user and returns the trimmed values', async () => {
    requireCapability.mockResolvedValue({ id: 'u1', role: 'admin' });
    updateSettings.mockResolvedValue({ ok: true, changed: ['churchName'] });
    const state = await saveSettings(idle, form('  Grace  '));
    expect(state.status).toBe('saved');
    expect(state.values.churchName).toBe('Grace');
  });

  it('returns field errors without claiming success', async () => {
    requireCapability.mockResolvedValue({ id: 'u1', role: 'admin' });
    updateSettings.mockResolvedValue({
      ok: false,
      errors: { churchName: 'Enter your church name.' },
    });
    const state = await saveSettings(idle, form(''));
    expect(state.status).toBe('error');
    expect(state.errors?.churchName).toBe('Enter your church name.');
  });
});
