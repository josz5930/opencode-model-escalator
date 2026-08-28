import { describe, it, expect } from 'vitest';
import { resolveConfig } from '../src/config.js';
import {
  looksLikeTestCommand,
  normalizeOutput,
  failureFingerprint,
  classifyFailure,
} from '../src/detection.js';

const cfg = resolveConfig({
  models: [{ model: 'openrouter/deepseek/deepseek-v4-flash-0731' }],
});

describe('looksLikeTestCommand (spec §3.2, FR-11)', () => {
  it('recognizes a configured test command (matrix row)', () => {
    expect(looksLikeTestCommand('pytest -q', cfg)).toBe(true);
  });
  it('does not recognize a non-test command (matrix row, FR-15)', () => {
    expect(looksLikeTestCommand('ls -la', cfg)).toBe(false);
  });
  it('matches other default runners as substrings', () => {
    expect(looksLikeTestCommand('cd app && npm test --silent', cfg)).toBe(true);
    expect(looksLikeTestCommand('go test ./...', cfg)).toBe(true);
    expect(looksLikeTestCommand('cargo test --release', cfg)).toBe(true);
  });
  it('is case-sensitive by default', () => {
    expect(looksLikeTestCommand('PYTEST -q', cfg)).toBe(false);
  });
});

describe('normalizeOutput (spec §3.3 scrub table, NFR-2)', () => {
  it('scrubs durations, addresses, temp paths, line numbers, ANSI', () => {
    const raw =
      '\x1b[31mFAILED\x1b[0m at 0x71abc2 in /tmp/a81x/foo.py took 2.13s foo.py:183';
    const out = normalizeOutput(raw, cfg.fingerprint);
    expect(out).not.toContain('\x1b[');
    expect(out).not.toContain('0x71abc2');
    expect(out).not.toContain('/tmp/a81x');
    expect(out).not.toContain('2.13s');
    expect(out).toContain('<addr>');
    expect(out).toContain('<tmp>');
    expect(out).toContain('<duration>');
    expect(out).toContain(':<line>');
  });

  it('respects toggles (strip_ansi=false keeps ANSI)', () => {
    const noStrip = resolveConfig({
      models: [{ model: 'a/b' }],
      fingerprint: { strip_ansi: false },
    });
    const out = normalizeOutput('\x1b[31mX\x1b[0m', noStrip.fingerprint);
    expect(out).toContain('\x1b[');
  });

  it('finding 16: scrubs the configured project_root to <root>', () => {
    const rooted = resolveConfig({
      models: [{ model: 'a/b' }],
      fingerprint: { project_root: '/home/dev/checkout-xyz' },
    });
    const out = normalizeOutput(
      'FAILED /home/dev/checkout-xyz/src/app.py boom',
      rooted.fingerprint,
    );
    expect(out).not.toContain('/home/dev/checkout-xyz');
    expect(out).toContain('<root>');
  });

  it('finding 16: scrubs Windows temp paths to <tmp>', () => {
    const out = normalizeOutput(
      'wrote C:\\Users\\dev\\AppData\\Local\\Temp\\pytest-7\\t.log ok',
      cfg.fingerprint,
    );
    expect(out).not.toContain('AppData\\Local\\Temp');
    expect(out).toContain('<tmp>');
  });
});

describe('failureFingerprint — AC-9: noise-only diffs hash EQUAL', () => {
  it('durations differ only', () => {
    const a = 'FAILED test_auth.py::test_expiry - 2.13s';
    const b = 'FAILED test_auth.py::test_expiry - 2.46s';
    expect(failureFingerprint('pytest -q', a, cfg)).toBe(
      failureFingerprint('pytest -q', b, cfg),
    );
  });

  it('line numbers, temp paths, addresses, ANSI differ only', () => {
    const a =
      '\x1b[31mFAILED\x1b[0m test_math.py::test_add\n' +
      'test_math.py:42: AssertionError: expected 3\n' +
      'tmp at /tmp/aaa111/run and addr 0x71abc2';
    const b =
      '\x1b[32mFAILED\x1b[0m test_math.py::test_add\n' +
      'test_math.py:57: AssertionError: expected 3\n' +
      'tmp at /tmp/zzz999/run and addr 0x99ff00';
    expect(failureFingerprint('pytest', a, cfg)).toBe(
      failureFingerprint('pytest', b, cfg),
    );
  });

  it('ordering-only differences among FAILED lines collapse (P3)', () => {
    const a = 'FAILED t.py::test_a\nFAILED t.py::test_b';
    const b = 'FAILED t.py::test_b\nFAILED t.py::test_a';
    // Same set of retained failure lines, reversed print order → EQUAL hash
    // (retained lines are deduped + sorted before hashing).
    expect(failureFingerprint('pytest', a, cfg)).toBe(
      failureFingerprint('pytest', b, cfg),
    );
  });

  it('Python-traceback line numbers are noise (P5)', () => {
    const a =
      'Traceback (most recent call last):\n' +
      '  File "app.py", line 183, in handler\n' +
      'AssertionError: boom';
    const b =
      'Traceback (most recent call last):\n' +
      '  File "app.py", line 207, in handler\n' +
      'AssertionError: boom';
    expect(failureFingerprint('pytest', a, cfg)).toBe(
      failureFingerprint('pytest', b, cfg),
    );
  });

  it('AC-9: UUID / ISO-8601 timestamp / long bare-hex are noise (P7a)', () => {
    const uuidA =
      'ERROR run 550e8400-e29b-41d4-a716-446655440000 failed: boom';
    const uuidB =
      'ERROR run 3f2504e0-4f89-41d3-9a0c-0305e82c3301 failed: boom';
    expect(failureFingerprint('pytest', uuidA, cfg)).toBe(
      failureFingerprint('pytest', uuidB, cfg),
    );

    const tsA = 'ERROR at 2026-08-22T13:45:07.123Z: boom';
    const tsB = 'ERROR at 2026-08-22T09:01:59.000Z: boom';
    expect(failureFingerprint('pytest', tsA, cfg)).toBe(
      failureFingerprint('pytest', tsB, cfg),
    );

    const hexA = 'ERROR digest deadbeefcafe1234 mismatch: boom';
    const hexB = 'ERROR digest 0123456789abcdef mismatch: boom';
    expect(failureFingerprint('pytest', hexA, cfg)).toBe(
      failureFingerprint('pytest', hexB, cfg),
    );
  });
});

describe('failureFingerprint — AC-10: semantic diffs hash DIFFERENT', () => {
  it('different failing test name', () => {
    const a = 'FAILED test_auth.py::test_expiry - 2.13s';
    const b = 'FAILED test_auth.py::test_login - 2.13s';
    expect(failureFingerprint('pytest', a, cfg)).not.toBe(
      failureFingerprint('pytest', b, cfg),
    );
  });

  it('different assertion message', () => {
    const a =
      'FAILED test_math.py::test_add\ntest_math.py:10: AssertionError: expected 1';
    const b =
      'FAILED test_math.py::test_add\ntest_math.py:10: AssertionError: expected 2';
    expect(failureFingerprint('pytest', a, cfg)).not.toBe(
      failureFingerprint('pytest', b, cfg),
    );
  });

  it('P10: trailing failure summary survives a long head of matching lines', () => {
    const noise = Array.from({ length: 600 }, (_, i) => `ERROR deprecation ${i}`).join(
      '\n',
    );
    const a = `${noise}\nFAILED test_alpha\nAssertionError: expected 1`;
    const b = `${noise}\nFAILED test_beta\nAssertionError: expected 2`;
    expect(failureFingerprint('pytest', a, cfg)).not.toBe(
      failureFingerprint('pytest', b, cfg),
    );
  });

  it('finding 10: unmarked pytest `E assert` detail lines keep failures distinct on a shared FAILED line', () => {
    // Same FAILED marker line; the distinguishing value lives only on the
    // marker-less `E   assert …` detail line. Dropping it would collide these.
    const a = 'FAILED test_calc.py::test_sum\nE       assert 1 == 2';
    const b = 'FAILED test_calc.py::test_sum\nE       assert 1 == 3';
    expect(failureFingerprint('pytest', a, cfg)).not.toBe(
      failureFingerprint('pytest', b, cfg),
    );
  });

  it('2026-08-25 finding 6: unmarked ValueError detail lines keep failures distinct', () => {
    // The FAILED/ERROR marker line is identical; the only difference lives on an
    // unmarked `ValueError: …` detail line that carries no `assert`/`E ` prefix.
    // Retaining error-detail lines (ClassNameError/Exception/…) keeps these apart
    // so a genuinely different error is never counted as the same repeat (AC-10).
    const a = 'ERROR test_x\nValueError: one';
    const b = 'ERROR test_x\nValueError: two';
    expect(failureFingerprint('pytest', a, cfg)).not.toBe(
      failureFingerprint('pytest', b, cfg),
    );
  });

  it('2026-08-25 finding 6: distinct exception classes on a shared marker stay apart', () => {
    const a = 'FAILED suite\nKeyError: missing';
    const b = 'FAILED suite\nRuntimeError: missing';
    expect(failureFingerprint('pytest', a, cfg)).not.toBe(
      failureFingerprint('pytest', b, cfg),
    );
  });

  it('different test command', () => {
    const out = 'FAILED test_x.py::test_y';
    expect(failureFingerprint('pytest', out, cfg)).not.toBe(
      failureFingerprint('go test ./...', out, cfg),
    );
  });

  it('marker-less outputs stay distinct — no false collapse (P2)', () => {
    // Neither output carries a failure marker, so nothing is retained. They
    // must NOT hash equal (which would manufacture a false repeat).
    const a = 'segmentation fault in module alpha';
    const b = 'segmentation fault in module beta';
    expect(failureFingerprint('pytest', a, cfg)).not.toBe(
      failureFingerprint('pytest', b, cfg),
    );
  });
});

describe('failureFingerprint — determinism (NFR-1)', () => {
  it('same inputs ⇒ same hash across calls', () => {
    const out = 'FAILED test_a.py::test_b\nAssertionError: nope';
    expect(failureFingerprint('pytest', out, cfg)).toBe(
      failureFingerprint('pytest', out, cfg),
    );
  });
});

describe('classifyFailure (spec §4, FR-9)', () => {
  it('AC-5 unit part: HTTP 429 text ⇒ "A"', () => {
    expect(
      classifyFailure('… HTTP 429 too many requests …', cfg),
    ).toBe('A');
  });

  it('capability failure ⇒ "B"', () => {
    expect(classifyFailure('AssertionError: expected 1', cfg)).toBe('B');
  });

  it('built-in infra phrases ⇒ "A" (case-insensitive)', () => {
    expect(classifyFailure('Rate Limit exceeded', cfg)).toBe('A');
    expect(classifyFailure('service unavailable', cfg)).toBe('A');
    expect(classifyFailure('the model is Overloaded', cfg)).toBe('A');
    expect(classifyFailure('quota exceeded for today', cfg)).toBe('A');
  });

  it('retry_on_errors status codes ⇒ "A"', () => {
    expect(classifyFailure('server returned 503', cfg)).toBe('A');
    expect(classifyFailure('got 500 internal error', cfg)).toBe('A');
  });

  it('bare built-in infra code 529 ⇒ "A" even when not in retry_on_errors (P7b)', () => {
    expect(cfg.retry_on_errors).not.toContain(529);
    expect(classifyFailure('provider replied 529 overloaded', cfg)).toBe('A');
  });

  it('does not misfire on a number embedded in a larger token', () => {
    expect(classifyFailure('elapsed 4290 iterations', cfg)).toBe('B');
  });

  it('finding 9: an assertion value that happens to be a status code stays "B"', () => {
    // `Expected: 500 Received: 400` is ordinary capability output — a status
    // number with NO HTTP/status context must not be misclassified as infra.
    expect(classifyFailure('Expected: 500 Received: 400', cfg)).toBe('B');
    expect(classifyFailure('assert response == 503', cfg)).toBe('B');
  });

  it('P6: Error: 500 / error: 429 in ordinary test output stay "B" in shell mode', () => {
    expect(
      classifyFailure('Error: 500', cfg, { requireHttpContext: true }),
    ).toBe('B');
    expect(
      classifyFailure('error: 429', cfg, { requireHttpContext: true }),
    ).toBe('B');
  });

  it('finding 9: bare "try again" is capability; "try again later" is infra', () => {
    expect(classifyFailure('the test says: try again', cfg)).toBe('B');
    expect(classifyFailure('server busy, try again later', cfg)).toBe('A');
  });

  it('honors user retry_on_patterns', () => {
    const custom = resolveConfig({
      models: [{ model: 'a/b' }],
      retry_on_patterns: ['circuit breaker open'],
    });
    expect(classifyFailure('Circuit Breaker Open', custom)).toBe('A');
  });

  describe('2026-08-25 finding 8: shell-output phrases require provider/HTTP context', () => {
    const shell = { requireHttpContext: true } as const;

    it('a bare infra phrase in ordinary test output stays "B" in shell mode', () => {
      // A normal failed assertion whose text happens to contain an infra phrase
      // must NOT spoof Category A and bypass capability accounting.
      expect(classifyFailure('Expected: rate limit exceeded', cfg, shell)).toBe('B');
      expect(classifyFailure('assert msg == "service unavailable"', cfg, shell)).toBe('B');
      expect(classifyFailure('printed: quota exceeded', cfg, shell)).toBe('B');
    });

    it('the same phrase WITH provider/HTTP context is still "A" in shell mode', () => {
      expect(classifyFailure('HTTP 503 service unavailable', cfg, shell)).toBe('A');
      expect(
        classifyFailure('openrouter upstream: rate limit exceeded', cfg, shell),
      ).toBe('A');
      expect(
        classifyFailure('x-ratelimit-remaining: 0 — quota exceeded', cfg, shell),
      ).toBe('A');
    });

    it('the authoritative session.error path (default mode) keeps phrases unconditional', () => {
      // Structured session.error text is trusted: no HTTP framing required.
      expect(classifyFailure('rate limit exceeded', cfg)).toBe('A');
      expect(classifyFailure('service unavailable', cfg)).toBe('A');
    });

    it('user retry_on_patterns and contextual status codes fire in shell mode too', () => {
      const custom = resolveConfig({
        models: [{ model: 'a/b' }],
        retry_on_patterns: ['circuit breaker open'],
      });
      expect(classifyFailure('Circuit Breaker Open', custom, shell)).toBe('A');
      expect(classifyFailure('server returned 503', cfg, shell)).toBe('A');
    });
  });
});
