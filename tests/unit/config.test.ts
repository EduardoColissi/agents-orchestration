import { describe, expect, it } from 'vitest';
import { parseDotEnv } from '../../src/config.js';

describe('parseDotEnv', () => {
  it('parses plain, quoted, commented and exported lines', () => {
    const env = parseDotEnv(Buffer.from('# c\nA=1\nB="two words" \nC=\'x\'\nexport D=4 # trailing\n\nE=sk-ant-abc...def\n'));
    expect(env).toEqual({ A: '1', B: 'two words', C: 'x', D: '4', E: 'sk-ant-abc...def' });
  });

  it('tolerates UTF-8 BOM, CRLF and UTF-16 files written by Windows editors', () => {
    expect(parseDotEnv(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('KEY=v\r\nOTHER=w\r\n')]))).toEqual({ KEY: 'v', OTHER: 'w' });
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('KEY=v\r\nOTHER=w', 'utf16le')]);
    expect(parseDotEnv(utf16)).toEqual({ KEY: 'v', OTHER: 'w' });
  });
});
