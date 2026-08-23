import { describe, it, expect } from 'vitest';
import {
  DEFAULTS,
  resolveConfig,
  parseModelId,
  thresholdForStage,
} from '../src/config.js';

const CHAIN = [
  { model: 'openrouter/deepseek/deepseek-v4-flash-0731' },
  { model: 'openrouter/deepseek/deepseek-v4-pro-0813' },
  { model: 'openrouter/moonshotai/kimi-k3' },
];

describe('DEFAULTS (CONFIGURATION_REFERENCE.md §3, CFG-1)', () => {
  it('matches the documented defaults verbatim', () => {
    expect(DEFAULTS.enabled).toBe(true);
    expect(DEFAULTS.same_failure_threshold).toBe(2);
    expect(DEFAULTS.shell_tool_name).toBe('bash');
    expect(DEFAULTS.idle_cleanup_ms).toBe(600000);
    expect(DEFAULTS.notify).toBe(true);
    expect(DEFAULTS.debug).toBe(false);
    expect(DEFAULTS.require_code_change_between_failures).toBe(true);
    expect(DEFAULTS.reset_on_new_user_task).toBe(true);
    expect(DEFAULTS.stop_at_max_model).toBe(true);
    expect(DEFAULTS.notify_on_escalation).toBe(true);
    expect(DEFAULTS.provider_failover).toBe(true);
    expect(DEFAULTS.retry_on_errors).toEqual([429, 500, 502, 503, 504]);
    expect(DEFAULTS.retry_on_patterns).toEqual([]);
    expect(DEFAULTS.test_commands).toEqual([
      'pytest',
      'python -m pytest',
      'npm test',
      'npm run test',
      'pnpm test',
      'yarn test',
      'bun test',
      'vitest',
      'jest',
      'go test',
      'cargo test',
      'dotnet test',
      'mvn test',
      'gradle test',
    ]);
    expect(DEFAULTS.fingerprint).toEqual({
      normalize_durations: true,
      normalize_line_numbers: true,
      normalize_temp_paths: true,
      normalize_addresses: true,
      strip_ansi: true,
      failure_markers: [
        'FAILED',
        'ERROR',
        'AssertionError',
        'Expected:',
        'Received:',
        'panic:',
        'Traceback',
        '--- FAIL:',
        'Tests failed',
        '✕',
        '✗',
      ],
    });
  });

  it('ships no `models` default — no unverified model id (OQ1/C-4)', () => {
    expect((DEFAULTS as Record<string, unknown>).models).toBeUndefined();
  });
});

describe('parseModelId (spec §5.1: split on first "/")', () => {
  it('splits OpenRouter nested ids on the first slash', () => {
    expect(parseModelId('openrouter/deepseek/deepseek-v4-flash-0731')).toEqual({
      providerID: 'openrouter',
      modelID: 'deepseek/deepseek-v4-flash-0731',
    });
  });
  it('rejects ids without a slash', () => {
    expect(parseModelId('noslash')).toBeNull();
  });
  it('rejects empty provider or model', () => {
    expect(parseModelId('/model')).toBeNull();
    expect(parseModelId('provider/')).toBeNull();
  });
});

describe('resolveConfig — zero-config viability (NFR-5, AC-12 unit part)', () => {
  it('returns a fully-defaulted config from only a models chain and never throws', () => {
    const cfg = resolveConfig({ models: CHAIN });
    expect(cfg.models).toHaveLength(3);
    expect(cfg.test_commands).toEqual(DEFAULTS.test_commands);
    expect(cfg.fingerprint).toEqual(DEFAULTS.fingerprint);
    expect(cfg.shell_tool_name).toBe('bash');
    expect(cfg.same_failure_threshold).toBe(2);
    expect(cfg.retry_on_errors).toEqual([429, 500, 502, 503, 504]);
  });

  it('deep-merges a partial fingerprint block over defaults', () => {
    const cfg = resolveConfig({
      models: CHAIN,
      fingerprint: { strip_ansi: false },
    });
    expect(cfg.fingerprint.strip_ansi).toBe(false);
    // untouched toggles retain their defaults
    expect(cfg.fingerprint.normalize_durations).toBe(true);
    expect(cfg.fingerprint.failure_markers).toEqual(
      DEFAULTS.fingerprint.failure_markers,
    );
  });

  it('honors user overrides of scalar toggles', () => {
    const cfg = resolveConfig({
      models: CHAIN,
      debug: true,
      shell_tool_name: 'sh',
    });
    expect(cfg.debug).toBe(true);
    expect(cfg.shell_tool_name).toBe('sh');
  });

  it('preserves per-stage same_failure_threshold overrides', () => {
    const cfg = resolveConfig({
      models: [
        { model: 'openrouter/a/b', same_failure_threshold: 3 },
        { model: 'openrouter/c/d' },
      ],
    });
    expect(thresholdForStage(cfg, 0)).toBe(3);
    expect(thresholdForStage(cfg, 1)).toBe(2); // falls back to default
  });
});

describe('resolveConfig — fail loudly on invalid config (CFG-2, AC-14)', () => {
  it('throws on empty models array (AC-14)', () => {
    expect(() => resolveConfig({ models: [] })).toThrow(/models/);
  });

  it('throws on missing models', () => {
    expect(() => resolveConfig({} as never)).toThrow(/models/);
  });

  it('throws naming the bad id on an unparseable model id (AC-14)', () => {
    expect(() => resolveConfig({ models: [{ model: 'noslash' }] })).toThrow(
      /noslash/,
    );
  });

  it('throws on a ModelStage missing `model`', () => {
    expect(() =>
      resolveConfig({ models: [{ notmodel: 'x' }] as never }),
    ).toThrow(/model/);
  });

  it('throws on same_failure_threshold < 1 (per-stage)', () => {
    expect(() =>
      resolveConfig({
        models: [{ model: 'openrouter/a/b', same_failure_threshold: 0 }],
      }),
    ).toThrow(/same_failure_threshold/);
  });

  it('throws on top-level same_failure_threshold < 1', () => {
    expect(() =>
      resolveConfig({ models: CHAIN, same_failure_threshold: 0 }),
    ).toThrow(/same_failure_threshold/);
  });

  it('throws on non-array test_commands when supplied', () => {
    expect(() =>
      resolveConfig({ models: CHAIN, test_commands: 'pytest' as never }),
    ).toThrow(/test_commands/);
  });

  it('throws on empty test_commands — never silently disable detection (P4)', () => {
    expect(() =>
      resolveConfig({ models: CHAIN, test_commands: [] }),
    ).toThrow(/test_commands/);
  });

  it('throws on empty fingerprint.failure_markers (P4)', () => {
    expect(() =>
      resolveConfig({ models: CHAIN, fingerprint: { failure_markers: [] } }),
    ).toThrow(/failure_markers/);
  });

  it('throws on non-array retry_on_errors (P1)', () => {
    expect(() =>
      resolveConfig({ models: CHAIN, retry_on_errors: 429 as never }),
    ).toThrow(/retry_on_errors/);
  });

  it('throws on non-integer retry_on_errors element (P1)', () => {
    expect(() =>
      resolveConfig({ models: CHAIN, retry_on_errors: [429, 'x'] as never }),
    ).toThrow(/retry_on_errors/);
  });

  it('throws on non-array retry_on_patterns (P1)', () => {
    expect(() =>
      resolveConfig({ models: CHAIN, retry_on_patterns: 'rate' as never }),
    ).toThrow(/retry_on_patterns/);
  });

  it('throws naming the bad pattern on an invalid retry_on_patterns regex (P1, P7c)', () => {
    expect(() =>
      resolveConfig({ models: CHAIN, retry_on_patterns: ['('] }),
    ).toThrow(/retry_on_patterns.*\(/s);
  });
});
