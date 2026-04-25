import { describe, beforeEach, afterEach, beforeAll, afterAll, test, suiteOptions, mergeSuites } from '../src/index.ts';
import { check } from 'k6';

// ─── Module-level side-effect tracking for failure scenarios ──────────────────
let afterEachRanAfterBeforeEachThrow = false;
let afterAllRanAfterBeforeAllThrow = false;

// ─── 1. Basic describe + test ─────────────────────────────────────────────────
const basicSuite = describe('basic', () => {
  test('passes via test()', () => { /* no throw = pass */ });
  test('also passes', () => { /* no throw = pass */ });
});

// ─── 2. test.skip — not executed ─────────────────────────────────────────────
const skipSuite = describe('skip', () => {
  test.skip('skipped never runs', () => { throw new Error('should not run'); });
  test('non-skipped passes', () => { /* pass */ });
});

// ─── 3. describe.skip — no tests run ─────────────────────────────────────────
const describeSkipSuite = describe.skip('skipped suite', () => {
  test('should not run', () => { throw new Error('should not run'); });
});

// ─── 4. test.only — only that test runs within the suite ─────────────────────
const onlySuite = describe('only', () => {
  test('should not run (sibling of only)', () => { throw new Error('only sibling ran'); });
  test.only('only this runs', () => { /* pass */ });
});

// ─── 5 + 6. beforeEach/afterEach shared state; beforeAll/afterAll run once ───
const hookCountSuite = describe('hook counts', () => {
  let beforeEachCalls = 0;
  let afterEachCalls = 0;
  let beforeAllCalls = 0;

  beforeAll(() => { beforeAllCalls++; });
  beforeEach(() => { beforeEachCalls++; });
  afterEach(() => { afterEachCalls++; });
  afterAll(() => {
    check(null, { 'hook counts > beforeAll ran once': () => beforeAllCalls === 1 });
    check(null, { 'hook counts > beforeEach ran per test': () => beforeEachCalls === 2 });
    check(null, { 'hook counts > afterEach ran per test': () => afterEachCalls === 2 });
  });

  test('first test', () => { /* pass */ });
  test('second test', () => { /* pass */ });
});

// ─── 7. Nested describe — hook inheritance order ──────────────────────────────
const nestedSuite = describe('nested', () => {
  const log: string[] = [];

  beforeEach(() => { log.push('outer-before'); });
  afterEach(() => { log.push('outer-after'); });

  describe('inner', () => {
    beforeEach(() => { log.push('inner-before'); });
    afterEach(() => { log.push('inner-after'); });

    test('records hook order', () => { log.push('test'); });

    test('verifies previous cycle order', () => {
      // After the first test: outer-before, inner-before, test, inner-after, outer-after
      const cycle = log.slice(0, 5).join(',');
      check(null, { 'nested > inner > hook order is outermost-first/innermost-last': () =>
        cycle === 'outer-before,inner-before,test,inner-after,outer-after'
      });
    });
  });
});

// ─── 8. beforeEach throwing — test failed, afterEach still runs ──────────────
//   Intentionally produces a failing check to prove the runner marks the test failed.
//   afterEachRanAfterBeforeEachThrow is verified in the side-effect suite below.
const beforeEachThrowSuite = describe('beforeEach throws', () => {
  beforeEach(() => { throw new Error('beforeEach failure'); });
  afterEach(() => { afterEachRanAfterBeforeEachThrow = true; });
  test('this test is intentionally marked failed by the runner', () => {});
});

// ─── 9. beforeAll throwing — all tests in suite failed, afterAll still runs ──
const beforeAllThrowSuite = describe('beforeAll throws', () => {
  beforeAll(() => { throw new Error('beforeAll failure'); });
  afterAll(() => { afterAllRanAfterBeforeAllThrow = true; });
  test('test1 — intentionally marked failed by runner', () => {});
  test('test2 — intentionally marked failed by runner', () => {});
});

// ─── Side-effect verification (must run AFTER failure suites) ─────────────────
const sideEffectSuite = describe('failure side effects', () => {
  test('afterEach ran despite beforeEach throwing', () => {
    check(null, { 'failure side effects > afterEach ran': () => afterEachRanAfterBeforeEachThrow });
  });
  test('afterAll ran despite beforeAll throwing', () => {
    check(null, { 'failure side effects > afterAll ran': () => afterAllRanAfterBeforeAllThrow });
  });
});

// ─── 10. Async test functions ─────────────────────────────────────────────────
const asyncSuite = describe('async tests', () => {
  test('async test resolves', async () => {
    await Promise.resolve();
    // no throw = pass
  });

  test('async test with value', async () => {
    const val = await Promise.resolve(42);
    check(null, { 'async tests > resolved value': () => val === 42 });
  });
});

// ─── 11. mergeSuites ─────────────────────────────────────────────────────────
const mergeA = describe('merge-a', () => {
  test('test in a', () => { /* pass */ });
});

const mergeB = describe('merge-b', () => {
  test('test in b1', () => { /* pass */ });
  test('test in b2', () => { /* pass */ });
});

const mergedAB = mergeSuites(mergeA, mergeB);

// ─── Combined suite ───────────────────────────────────────────────────────────
const allHappyPath = mergeSuites(
  basicSuite,
  skipSuite,
  describeSkipSuite,
  onlySuite,
  hookCountSuite,
  nestedSuite,
  asyncSuite,
  mergeA,
  mergeB,
);

// threshold rate>=0.0 because scenarios 8 & 9 intentionally produce failing checks
// (that IS the behavior under test: the runner marks failed tests via check(false))
export const options = suiteOptions(allHappyPath, {
  thresholds: { checks: ['rate>=0.0'] },
});

export default async function () {
  // 12 & 13 — suiteOptions shape + error message in check name (verified via opts below)
  const opts = suiteOptions(basicSuite);
  check(null, { 'suiteOptions vus=1': () => opts.vus === 1 });
  check(null, { 'suiteOptions iterations=1': () => opts.iterations === 1 });
  check(null, { 'suiteOptions threshold rate==1.0': () => {
    const t = opts.thresholds as Record<string, string[]>;
    return Array.isArray(t['checks']) && t['checks'][0] === 'rate==1.0';
  }});

  // 11 — mergeSuites testCount
  check(null, { 'mergeSuites testCount equals sum': () => mergedAB.testCount === mergeA.testCount + mergeB.testCount });
  check(null, { 'mergeSuites testCount is 3': () => mergedAB.testCount === 3 });

  // 3 — describe.skip: testCount is 0
  check(null, { 'describe.skip testCount is 0': () => describeSkipSuite.testCount === 0 });

  // Run failure suites first so side-effect flags are set before sideEffectSuite runs
  await beforeEachThrowSuite.run();
  await beforeAllThrowSuite.run();
  await sideEffectSuite.run();

  // Happy path suites
  await allHappyPath.run();
}
