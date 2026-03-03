import { describe, expect, test } from 'bun:test';
import { resolveModel, getModelVariants } from '../../src/plugin/models.js';

describe('resolveModel variants (bun)', () => {
  test('defaults to base enum when no variant provided', () => {
    const result = resolveModel('gemini-3.0-pro');
    expect(result.modelId).toBe('gemini-3.0-pro');
    expect(result.variant).toBeUndefined();
  });

  test('resolves colon-delimited variant', () => {
    const result = resolveModel('gemini-3.0-pro:high');
    expect(result.modelId).toBe('gemini-3.0-pro');
    expect(result.variant).toBe('high');
  });

  test('resolves suffix variant with alias', () => {
    const result = resolveModel('gemini-3-0-pro-high');
    expect(result.modelId).toBe('gemini-3.0-pro');
    expect(result.variant).toBe('high');
  });

  test('respects variant override', () => {
    const result = resolveModel('gemini-3.0-pro', 'low');
    expect(result.variant).toBe('low');
  });
});

describe('getModelVariants (bun)', () => {
  test('returns variants list for canonical id', () => {
    const variants = getModelVariants('gpt-5.2');
    expect(variants).toBeDefined();
    expect(Object.keys(variants || {})).toContain('high');
    expect(Object.keys(variants || {})).toContain('fast');
  });
});

describe('string-UID models (bun)', () => {
  test('resolves claude-4.6-opus to modelUid', () => {
    const result = resolveModel('claude-4.6-opus');
    expect(result.modelId).toBe('claude-4.6-opus');
    expect(result.modelUid).toBe('claude-opus-4-6');
    expect(result.enumValue).toBe(0);
  });

  test('resolves claude-4.6-opus:thinking to modelUid', () => {
    const result = resolveModel('claude-4.6-opus:thinking');
    expect(result.modelUid).toBe('claude-opus-4-6-thinking');
    expect(result.variant).toBe('thinking');
  });

  test('resolves claude-4.6-sonnet:1m to modelUid', () => {
    const result = resolveModel('claude-4.6-sonnet:1m');
    expect(result.modelUid).toBe('claude-sonnet-4-6-1m');
  });

  test('resolves gpt-5.3-codex to modelUid', () => {
    const result = resolveModel('gpt-5.3-codex');
    expect(result.modelUid).toBe('gpt-5-3-codex-medium');
  });

  test('resolves gpt-5.3-codex:xhigh-fast to modelUid', () => {
    const result = resolveModel('gpt-5.3-codex:xhigh-fast');
    expect(result.modelUid).toBe('gpt-5-3-codex-xhigh-priority');
  });

  test('resolves gemini-3.1-pro:high to modelUid', () => {
    const result = resolveModel('gemini-3.1-pro:high');
    expect(result.modelUid).toBe('gemini-3-1-pro-high');
  });

  test('resolves kimi-k2.5 alias to modelUid', () => {
    const result = resolveModel('kimi-k2-5');
    expect(result.modelUid).toBe('kimi-k2-5');
  });

  test('resolves glm-5 to modelUid', () => {
    const result = resolveModel('glm-5');
    expect(result.modelUid).toBe('glm-5');
  });

  test('enum-based models have no modelUid', () => {
    const result = resolveModel('gpt-4o');
    expect(result.modelUid).toBeUndefined();
    expect(result.enumValue).toBeGreaterThan(0);
  });
});
