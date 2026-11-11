import { describe, expect, it } from 'vitest';
import { groupDigits } from './fields';

describe('groupDigits(천 단위 콤마)', () => {
  it('정수에 세 자리마다 콤마', () => {
    expect(groupDigits('0')).toBe('0');
    expect(groupDigits('999')).toBe('999');
    expect(groupDigits('1000')).toBe('1,000');
    expect(groupDigits('1234567')).toBe('1,234,567');
  });

  it('음수는 마이너스를 앞에 두고 콤마', () => {
    expect(groupDigits('-1234')).toBe('-1,234');
    expect(groupDigits('-999')).toBe('-999');
  });

  it('소수부에는 콤마를 넣지 않음', () => {
    expect(groupDigits('1234.5678')).toBe('1,234.5678');
    expect(groupDigits('-1234567.5')).toBe('-1,234,567.5');
    expect(groupDigits('0.0001')).toBe('0.0001');
  });

  it('입력 중인 꼴은 그대로 유지', () => {
    expect(groupDigits('12.')).toBe('12.');
    expect(groupDigits('1234.')).toBe('1,234.');
    expect(groupDigits('.5')).toBe('.5');
    expect(groupDigits('-')).toBe('-');
    expect(groupDigits('-.')).toBe('-.');
  });

  it('빈 문자열은 빈 문자열', () => {
    expect(groupDigits('')).toBe('');
  });

  it('숫자가 아닌 문자열은 손대지 않음', () => {
    expect(groupDigits('abc')).toBe('abc');
    expect(groupDigits('12a34')).toBe('12a34');
    expect(groupDigits('1,234')).toBe('1,234');
    expect(groupDigits('1.2.3')).toBe('1.2.3');
  });
});
