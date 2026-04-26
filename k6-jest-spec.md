# k6-test-jest-style — Specification

> Working package name: `k6-test-jest-style`
> Purpose: Jest-style test authoring DSL for [k6](https://k6.io/), published to npmjs.

---

## 1. Goals

- Let engineers write k6 tests using familiar `describe / test / beforeEach / afterEach` syntax
- Zero runtime dependencies beyond k6 itself (`k6/*` built-ins only)
- TypeScript-first: all public API is fully typed, ships its own `.d.ts` files
- Work as a drop-in layer on top of k6 — no custom k6 binary or extension required
- Publishable to npmjs and importable in any k6 project

Out of scope for v1:

- Jest-compatible assertion API (`expect`) — use k6's `check()` directly
- Module mocking — k6 does not support it at runtime
- Parallel test execution — k6 multi-VU is orthogonal; see §8

---

## 2. Design Principles

1. **Collect, then run.** `describe()` is called at module init time (k6 init context) and only
   _collects_ the suite tree. Actual execution happens inside the k6 `default` function via
   `suite.run()`. This mirrors how Jest collects tests before running them.

2. **Closures for shared state.** Variables declared inside a `describe` callback are shared
   across `beforeEach`, `afterEach`, and `test` callbacks through normal JavaScript closures —
   exactly the pattern users expect from Jest.

3. **Context stack.** A module-level stack tracks the "current describe node" so that nested
   `describe`, `beforeEach`, and `test` calls register themselves into the right parent.

4. **k6 primitives.** `describe` maps to k6's `group()`. Test pass/fail maps to k6's `check()`.
   `beforeAll` / `afterAll` map to k6's `setup` / `teardown` lifecycle when they appear at the
   top level, or execute inline when nested.

5. **Fail-safe iteration.** A test that throws does not abort remaining tests. Errors are caught,
   reported via `check(false)`, and execution continues.

---

## 3. Public API

### 3.1 Suite construction (init context)

```typescript
describe(name
:
string, fn
:
() => void
):
TestSuite
describe.skip(name
:
string, fn
:
() => void
):
TestSuite
```

`describe` runs `fn` immediately (synchronously) to collect the suite tree, then returns a
`TestSuite` handle. `describe.skip` marks the whole suite as skipped; its callback is still
executed for collection (so type errors surface at compile time) but no tests run.

### 3.2 Lifecycle hooks (inside describe callback only)

```typescript
beforeAll(fn
:
HookFn
):
void
    afterAll(fn
:
HookFn
):
void
    beforeEach(fn
:
HookFn
):
void
    afterEach(fn
:
HookFn
):
void
```

`HookFn = () => void | Promise<void>`

- Hooks are scoped to the `describe` block in which they are declared.
- `beforeAll` / `afterAll` run once per suite, before/after all tests in that suite.
- `beforeEach` / `afterEach` run once per test case inside that suite (and are inherited by
  nested suites — see §6).
- Declaring a hook outside a `describe` callback throws a descriptive error at init time.

### 3.3 Test cases (inside describe callback only)

```typescript
test(name
:
string, fn
:
TestFn
):
void
    it(name
:
string, fn
:
TestFn
):
void   // alias

    test.skip(name
:
string, fn
:
TestFn
):
void
    it.skip(name
:
string, fn
:
TestFn
):
void

    test.only(name
:
string, fn
:
TestFn
):
void
    it.only(name
:
string, fn
:
TestFn
):
void
```

`TestFn = () => void | Promise<void>`

- `test.skip` registers the test but marks it skipped (no-op at runtime, visible in report).
- `test.only` — if _any_ `test.only` exists in a suite, only those tests run; all others are
  treated as skipped. Applies per-suite (not globally across suites).

### 3.4 Execution (k6 default function)

```typescript
// Returned by describe()
interface TestSuite {
  readonly name: string;
  readonly testCount: number; // total non-skipped test leaf count
  run(): Promise<void>; // call inside k6 default export function
}
```

### 3.5 k6 entry-point helpers

```typescript
// Convenience re-export: builds k6 `options` for sequential smoke execution
function suiteOptions(suite: TestSuite, overrides?: Partial<Options>): Options;

// Convenience re-export: wraps multiple suites into one runner
function mergeSuites(...suites: TestSuite[]): TestSuite;
```

`suiteOptions` produces:

```json
{
  "vus": 1,
  "iterations": 1,
  "thresholds": {
    "checks": ["rate==1.0"]
  }
}
```

For `mergeSuites`, the returned `run()` executes each suite in declaration order.

---

## 4. Type Definitions

```typescript
// types.ts — shipped as part of the package

export type HookFn = () => void | Promise<void>;
export type TestFn = () => void | Promise<void>;

export interface TestSuite {
  readonly name: string;
  readonly testCount: number;

  run(): Promise<void>;
}

export interface DescribeFn {
  (name: string, fn: () => void): TestSuite;

  skip: (name: string, fn: () => void) => TestSuite;
}

export interface TestFnWithModifiers {
  (name: string, fn: TestFn): void;

  skip: (name: string, fn: TestFn) => void;
  only: (name: string, fn: TestFn) => void;
}

// Internal tree node — not exported
interface SuiteNode {
  name: string;
  skipped: boolean;
  beforeAll: HookFn[];
  afterAll: HookFn[];
  beforeEach: HookFn[];
  afterEach: HookFn[];
  tests: TestNode[];
  children: SuiteNode[];
}

interface TestNode {
  name: string;
  fn: TestFn;
  skipped: boolean;
  only: boolean;
}
```

---

## 5. Execution Model

### 5.1 k6 init context vs default function

k6 evaluates a script in two phases:

| Phase                | When                   | Allowed operations                                        |
| -------------------- | ---------------------- | --------------------------------------------------------- |
| **Init context**     | Once per VU at startup | Module imports, variable declarations, `describe()` calls |
| **Default function** | Once per VU iteration  | HTTP, checks, groups, assertions                          |

`describe()` and all nested `beforeEach` / `test` / etc. calls happen in the init context —
they only _build_ the tree. `suite.run()` must be called inside the `default` export function.

### 5.2 Execution sequence inside run()

For a single suite (no nesting), `suite.run()` does the following:

```
group(suite.name, async () => {
  await runHooks(suite.beforeAll)
  for each test in suite.tests (respecting .only and .skip):
    await runHooks(suite.beforeEach)     // from outermost to innermost suite
    result = await safeRun(test.fn)
    await runHooks(suite.afterEach)      // from innermost to outermost suite
    reportResult(test.name, result)
  await runHooks(suite.afterAll)
})
```

`safeRun` catches any thrown error, returns `{ ok: false, error }`. All results are reported
via k6's `check()`:

```typescript
check(null, { [testFullName]: () => result.ok });
```

### 5.3 Full name construction

The check name (visible in k6 output and Allure) is built from the suite path:

```
"Suite Name > Nested Suite > test case name"
```

Separator is configurable (see §9).

### 5.4 Recommended k6 entry-point pattern

```typescript
// my-tests.k6.ts
import { describe, beforeEach, afterEach, test, suiteOptions } from 'k6-test-jest-style';

const suite = describe('My Feature', () => {
  // ... tests
});

export const options = suiteOptions(suite);

export default async function () {
  await suite.run();
}
```

---

## 6. Hook Execution Order

### 6.1 Flat suite

```
beforeAll
  beforeEach → test 1 → afterEach
  beforeEach → test 2 → afterEach
afterAll
```

### 6.2 Nested suites

```
outer.beforeAll
  outer.beforeEach → inner.beforeAll
    outer.beforeEach → inner.beforeEach → test A → inner.afterEach → outer.afterEach
    outer.beforeEach → inner.beforeEach → test B → inner.afterEach → outer.afterEach
  inner.afterAll → outer.afterEach   ← afterEach of parent does NOT run between suites
outer.afterAll
```

Formally: `beforeEach` hooks execute outermost-first; `afterEach` hooks execute innermost-first
(same as Jest).

### 6.3 Hook failure behaviour

If a `beforeEach` hook throws, the corresponding test is marked as failed with the hook error.
The `afterEach` hooks **still run** (same as Jest). If `beforeAll` throws, all tests in that
suite are marked as failed and `afterAll` is still attempted.

---

## 7. Error Handling

### 7.1 Test errors

A test that throws (synchronously or via rejected promise) is caught. The error message is
appended to the check name for visibility:

```
check(null, { "Suite > test name [FAILED: TypeError: x is not a function]": () => false })
```

### 7.2 Hook errors

Hook errors are caught and reported as a separate check:

```
check(null, { "Suite > [beforeEach hook failed]: <error message>": () => false })
```

### 7.3 Unrecoverable errors

`exec.test.abort()` is intentionally never called by the library — the caller controls whether
to abort based on threshold failures.

---

## 8. Nested Describes

Nesting is fully supported to arbitrary depth:

```typescript
describe('Outer', () => {
    beforeEach(() => { /* runs before every test in Outer and Inner */
    });

    describe('Inner', () => {
        beforeEach(() => { /* runs before every test in Inner only */
        });
        test('case', async () => { ...
        });
    });

    test('outer-only case', async () => { ...
    });
});
```

Each `describe` call during collection pushes a new `SuiteNode` onto the context stack and
pops it when the callback returns.

---

## 9. Configuration

A global config object can be set once before `describe()` calls:

```typescript
import { configure } from 'k6-test-jest-style';

configure({
  nameSeparator: ' > ', // default: ' > '
  continueOnHookFailure: true, // default: true
  verbose: false, // default: false — if true, logs each test start/end to console
});
```

`configure()` must be called in the init context (before `describe()`). Calling it inside
`describe` or `run()` is a no-op and logs a warning.

---

## 10. k6 Integration Details

### 10.1 group() mapping

Each `describe` call maps to one `group()` call during `run()`. The k6 group name is the
full suite path (e.g., `"Outer > Inner"`). This ensures k6's built-in group metrics and
Allure reporting (when used) reflect the suite hierarchy.

### 10.2 check() naming

Every test produces exactly one `check()` call. The check name is the full test path:
`"Suite > test name"`. This is the primary pass/fail signal visible in k6's terminal output,
JSON results, and Allure.

### 10.3 Thresholds

`suiteOptions()` sets `"checks": ["rate==1.0"]` by default so k6 exits non-zero on any
test failure. Override via the `overrides` parameter.

### 10.4 Multiple suites in one script

```typescript
const suite1 = describe('Auth', () => { ...
});
const suite2 = describe('API', () => { ...
});

const all = mergeSuites(suite1, suite2);

export const options = suiteOptions(all);
export default async function () {
    await all.run();
}
```

`mergeSuites` creates a virtual root suite. Its `run()` calls each child suite's `run()` in
order. The total `testCount` is the sum of all children.

---

## 11. Package Structure

```
k6-test-jest-style/
├── src/
│   ├── index.ts           # public re-exports
│   ├── context.ts         # module-level context stack
│   ├── describe.ts        # describe() + describe.skip()
│   ├── hooks.ts           # beforeAll / afterAll / beforeEach / afterEach
│   ├── test.ts            # test() / it() + .skip / .only
│   ├── runner.ts          # suite.run() implementation
│   ├── helpers.ts         # suiteOptions(), mergeSuites()
│   ├── configure.ts       # global config
│   └── types.ts           # all exported type definitions
├── dist/
│   ├── index.js           # CJS build (for Node.js tooling / bundlers)
│   ├── index.mjs          # ESM build (for k6 direct import)
│   └── index.d.ts         # TypeScript declarations
├── package.json
├── tsconfig.json
├── tsconfig.build.json
└── README.md
```

### 11.1 package.json (key fields)

```json
{
  "name": "k6-test-jest-style",
  "version": "0.1.0",
  "description": "Jest-style describe/test/beforeEach API for k6",
  "main": "dist/index.js",
  "module": "dist/index.mjs",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.mjs",
      "require": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "files": ["dist"],
  "keywords": ["k6", "testing", "jest", "describe", "k6-lib"],
  "peerDependencies": {
    "k6": "*"
  },
  "devDependencies": {
    "@types/k6": "^1.x",
    "typescript": "^5.x",
    "esbuild": "^0.x"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json && node scripts/build-esm.js",
    "test": "k6 run tests/self-test.k6.ts"
  }
}
```

### 11.2 tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "declaration": true,
    "declarationDir": "dist",
    "outDir": "dist",
    "noEmit": false,
    "allowImportingTsExtensions": false,
    "types": ["k6"]
  },
  "include": ["src"]
}
```

---

## 12. Usage Examples

### 12.1 Basic usage

```typescript
import { describe, beforeEach, afterEach, test, suiteOptions } from 'k6-test-jest-style';
import http from 'k6/http';
import { check } from 'k6';

const suite = describe('Users API', () => {
  let userId: string;

  beforeEach(() => {
    const res = http.post('https://api.example.com/users', JSON.stringify({ name: 'test' }));
    userId = JSON.parse(res.body as string).id;
  });

  afterEach(() => {
    http.del(`https://api.example.com/users/${userId}`);
  });

  test('GET /users/:id returns 200', () => {
    const res = http.get(`https://api.example.com/users/${userId}`);
    check(res, { 'status is 200': (r) => r.status === 200 });
  });

  test('GET /users/:id returns correct body', () => {
    const res = http.get(`https://api.example.com/users/${userId}`);
    const body = JSON.parse(res.body as string);
    check(res, { 'name matches': () => body.name === 'test' });
  });
});

export const options = suiteOptions(suite);
export default async function () {
  await suite.run();
}
```

### 12.2 Nested describes

```typescript
const suite = describe('Auth', () => {
    describe('Login', () => {
        test('valid credentials return token', async () => { ...
        });
        test('invalid credentials return 401', async () => { ...
        });
    });

    describe('Logout', () => {
        let token: string;
        beforeEach(async () => {
            token = await getToken();
        });
        test('valid token returns 200', async () => { ...
        });
    });
});
```

### 12.3 Skipping tests

```typescript
describe('Feature X', () => {
    test('works normally', () => { ...
    });
    test.skip('not implemented yet', () => { ...
    });
});

describe.skip('Whole feature Y (blocked by JIRA-123)', () => {
    test('this never runs', () => { ...
    });
});
```

### 12.4 Multiple suites (recommended for large test files)

```typescript
import { mergeSuites, suiteOptions } from 'k6-test-jest-style';
import { authSuite } from './suites/auth.ts';
import { productSuite } from './suites/products.ts';

const all = mergeSuites(authSuite, productSuite);

export const options = suiteOptions(all);
export default async function () {
  await all.run();
}
```

### 12.5 beforeAll / afterAll

```typescript
describe('DB tests', () => {
    let connection: DBConnection;

    beforeAll(async () => {
        connection = await DB.connect(ENV.DB_URL);
    });

    afterAll(async () => {
        await connection.close();
    });

    test('query returns rows', async () => { ...
    });
});
```

---

## 13. Constraints and Limitations

| Constraint                                  | Reason                                                              |
| ------------------------------------------- | ------------------------------------------------------------------- |
| No `expect()` API                           | Out of scope for v1; use k6's `check()`                             |
| No module mocking                           | k6 runtime does not support it                                      |
| No parallelism between tests                | By design: 1 VU, sequential. k6 multi-VU is for load, not isolation |
| `describe` callback must be synchronous     | k6 init context does not support async; hooks/tests may be async    |
| All `describe()` calls must be at init time | Calling `describe()` inside `run()` or `default` throws             |
| No `jest.fn()` / spy API                    | Out of scope for v1                                                 |
| No DOM / browser support                    | Use xk6-browser separately if needed                                |
| No snapshot testing                         | k6 has no serialization registry                                    |

---

## 14. Internal Implementation Notes

### 14.1 Context stack

A module-level singleton holds the collection state:

```typescript
// context.ts
const _stack: SuiteNode[] = [];

export function pushSuite(node: SuiteNode) {
  _stack.push(node);
}

export function popSuite() {
  _stack.pop();
}

export function currentSuite(): SuiteNode {
  if (_stack.length === 0) throw new Error('beforeEach/afterEach/test must be called inside a describe() callback');
  return _stack[_stack.length - 1];
}
```

### 14.2 Tree walker for run()

`runner.ts` performs a depth-first traversal of the `SuiteNode` tree, accumulating inherited
hooks as it descends:

```typescript
async function runSuite(node: SuiteNode, inheritedBeforeEach: HookFn[], inheritedAfterEach: HookFn[]) {
  const allBeforeEach = [...inheritedBeforeEach, ...node.beforeEach];
  const allAfterEach = [...node.afterEach, ...inheritedAfterEach]; // reversed

  await group(node.name, async () => {
    await runHooks(node.beforeAll);
    const tests = resolveOnly(node.tests);
    for (const t of tests) {
      if (t.skipped) {
        reportSkipped(t.name);
        continue;
      }
      await runHooks(allBeforeEach);
      const result = await safeRun(t.fn);
      await runHooks(allAfterEach);
      check(null, { [fullName(node, t)]: () => result.ok });
    }
    for (const child of node.children) {
      await runSuite(child, allBeforeEach, allAfterEach);
    }
    await runHooks(node.afterAll);
  });
}
```

### 14.3 safeRun

```typescript
async function safeRun(fn: TestFn): Promise<{ ok: boolean; error?: string }> {
  try {
    await fn();
    return { ok: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
```

---

## 15. Versioning and Release

- Semantic versioning: `0.x.y` while API is stabilising, `1.0.0` once API is locked
- Changelog maintained in `CHANGELOG.md`
- Distributed on npmjs as `k6-test-jest-style` (confirm name availability before publish)
- CI: self-test suite in `tests/self-test.k6.ts` run against a real k6 binary on every PR

---

## 16. Open Questions (to resolve before implementation)

1. **Package name**: `k6-test-jest-style` vs `@your-scope/k6-test-jest-style` vs `k6-describe` — check npmjs availability.
2. **Build output format**: k6 can import ESM directly; CJS is needed only for bundler tooling. Confirm whether
   consumers will import via k6 native import or via a bundler (webpack/esbuild).
3. **`afterEach` on hook failure**: If `beforeEach` fails, should `afterEach` always run (Jest default) or be skipped?
   Proposed: always run (safer for cleanup), configurable via `configure({ runAfterEachOnHookFailure: true })`
4. **Report integration**: Should the library optionally emit Allure-compatible metadata (labels, steps) when xk6-allure
   is detected? Proposed: separate optional plugin `k6-test-jest-style-allure` to keep core dependency-free.
5. **`test.todo`**: Add `test.todo(name)` as a no-fn variant that appears in report output? Low-effort, high-visibility.
