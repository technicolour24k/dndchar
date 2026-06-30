import {describe,expect,it} from 'vitest';
import {effectApplicationDecision} from './effects';

describe('effect application policy',()=>{
  it('applies a missing effect',()=>expect(effectApplicationDecision(false,'refresh')).toBe('applied'));
  it('refreshes, stacks, or rejects an existing effect according to its definition',()=>{
    expect(effectApplicationDecision(true,'refresh')).toBe('refreshed');
    expect(effectApplicationDecision(true,'stack')).toBe('stacked');
    expect(effectApplicationDecision(true,'reject')).toBe('rejected');
  });
});
