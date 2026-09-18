import { describe, expect, it } from 'vitest';
import { detectSide, parseLabelDate } from './label';
import { extensionOf, sniffAudioFormat } from './sniff';

const bytes = (...codes: number[]) => Uint8Array.from(codes);
const ascii = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const cat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
const zeros = (n: number) => new Uint8Array(n);

describe('parseLabelDate', () => {
  const today = new Date('2026-09-18T00:00:00Z');
  it.each([
    ['03/13/1988', '1988-03-13'],
    ['3/13/1988', '1988-03-13'],
    ['3-13-1988', '1988-03-13'],
    ['1988-03-13', '1988-03-13'],
    ['  12/31/1999 ', '1999-12-31'],
    ['02/29/1988', '1988-02-29'],
  ])('reads %j as %s', (input, iso) => {
    expect(parseLabelDate(input, today)).toEqual({ ok: true, iso });
  });

  it.each([
    '',
    'March 13',
    '13/03/1988x',
    '3/13/88',
    '2/30/1988',
    '02/29/1989',
    '13/13/1988',
    '01/01/1899',
    '01/01/2027',
  ])('rejects %j with a helpful message', (input) => {
    const result = parseLabelDate(input, today);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(10);
  });
});

describe('detectSide', () => {
  it.each([
    ['Tape14_SideA.wav', 'A'],
    ['Tape14_SideB.wav', 'B'],
    ['tape 3 side b.mp3', 'B'],
    ['Box3-Tape2-B.mp3', 'B'],
    ['Tape_7_A.flac', 'A'],
    ['SIDE-a.m4a', 'A'],
    ['Tape14.wav', null],
    ['Sermon_Bethel.mp3', null],
    ['Sidebar.mp3', null],
  ])('%s → %s', (name, side) => {
    expect(detectSide(name)).toBe(side);
  });
});

describe('sniffAudioFormat', () => {
  it('recognises each supported format', () => {
    expect(sniffAudioFormat(cat(ascii('ID3'), bytes(4, 0, 0, 0)))).toBe('mp3');
    expect(sniffAudioFormat(bytes(0xff, 0xfb, 0x90, 0x00))).toBe('mp3');
    expect(sniffAudioFormat(cat(ascii('fLaC'), zeros(4)))).toBe('flac');
    expect(sniffAudioFormat(cat(ascii('RIFF'), zeros(4), ascii('WAVEfmt ')))).toBe('wav');
    expect(sniffAudioFormat(cat(ascii('FORM'), zeros(4), ascii('AIFF')))).toBe('aiff');
    expect(sniffAudioFormat(cat(ascii('FORM'), zeros(4), ascii('AIFC')))).toBe('aiff');
    expect(sniffAudioFormat(cat(bytes(0, 0, 0, 0x20), ascii('ftypM4A ')))).toBe('m4a');
  });

  it('rejects things that are not audio', () => {
    expect(sniffAudioFormat(ascii('hello world, this is text'))).toBeNull();
    expect(sniffAudioFormat(ascii('%PDF-1.7'))).toBeNull();
    expect(sniffAudioFormat(cat(ascii('MZ'), bytes(0x90, 0x00)))).toBeNull();
    expect(sniffAudioFormat(bytes(1, 2))).toBeNull();
    expect(sniffAudioFormat(new Uint8Array(0))).toBeNull();
  });
});

describe('extensionOf', () => {
  it.each([
    ['a.MP3', 'mp3'],
    ['a.b.wav', 'wav'],
    ['noext', ''],
  ])('%s → %s', (name, ext) => expect(extensionOf(name)).toBe(ext));
});
