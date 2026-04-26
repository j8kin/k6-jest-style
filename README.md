# k6-test-jest-style

Jest-style `describe / test / beforeEach / afterEach` syntax for [k6](https://k6.io/) load tests. Zero runtime
dependencies beyond k6 built-ins. TypeScript-first.

```typescript
import { describe, beforeEach, afterEach, test, suiteOptions } from 'k6-test-jest-style';
import http from 'k6/http';
import { check } from 'k6';

const suite = describe('Users API', () => {
  let userId: string;

  beforeEach(() => {
    const res = http.post('/users', JSON.stringify({ name: 'alice' }));
    userId = JSON.parse(res.body as string).id;
  });

  afterEach(() => {
    http.del(`/users/${userId}`);
  });

  test('GET returns 200', () => {
    const res = http.get(`/users/${userId}`);
    check(res, { 'status is 200': (r) => r.status === 200 });
  });

  test('GET returns correct body', () => {
    const res = http.get(`/users/${userId}`);
    check(res, {
      'name matches': () => JSON.parse(res.body as string).name === 'alice',
    });
  });
});

export const options = suiteOptions(suite);
export default async function () {
  await suite.run();
}
```

## Installation

```bash
yarn install k6-test-jest-style
```

Import in your k6 script:

```typescript
// ESM (k6 native)
import { describe, test, suiteOptions } from 'k6-test-jest-style';

// CommonJS (bundler / webpack)
const { describe, test, suiteOptions } = require('k6-test-jest-style');
```

## API

### `describe(name, fn)` — suite construction

Runs `fn` **synchronously** at init time to collect the suite tree, then returns a `TestSuite` handle. Must be called at
the module level (k6 init context), not inside `run()` or `export default`.

```typescript
const suite = describe('My Suite', () => {
  // register hooks and tests here
});
```

`describe.skip(name, fn)` marks the whole suite as skipped — its callback still executes for collection (type errors
surface at compile time) but no tests run.

### `test(name, fn)` / `it(name, fn)` — test cases

Registers a test inside a `describe` callback. `fn` may be async.

```typescript
test('does something', async () => {
  const result = await myAsyncOp();
  check(null, { 'result is ok': () => result.ok });
});
```

| Variant               | Behaviour                                              |
| --------------------- | ------------------------------------------------------ |
| `test(name, fn)`      | Normal test                                            |
| `test.skip(name, fn)` | Registers but never executes                           |
| `test.only(name, fn)` | Only this test runs in the suite; siblings are skipped |

`test.only` is **per-suite**, not global — it only suppresses siblings within the same `describe`.

### Lifecycle hooks

Hooks are scoped to the `describe` block they are declared in. All hook functions may be async.

```typescript
describe('Suite', () => {
  beforeAll(async () => {
    /* runs once before all tests */
  });
  afterAll(async () => {
    /* runs once after all tests  */
  });
  beforeEach(() => {
    /* runs before every test     */
  });
  afterEach(() => {
    /* runs after every test      */
  });
});
```

Declaring a hook outside a `describe` callback throws at init time.

**Hook execution order** (mirrors Jest):

```
beforeAll
  beforeEach → test 1 → afterEach
  beforeEach → test 2 → afterEach
afterAll
```

In nested suites, `beforeEach` runs outermost-first; `afterEach` runs innermost-first.

**Hook failure behaviour:**

- If `beforeEach` throws, the test is marked failed and `afterEach` still runs.
- If `beforeAll` throws, all tests in that suite are marked failed and `afterAll` is still attempted.

### `suiteOptions(suite, overrides?)` — k6 options helper

Returns a k6 `Options` object configured for sequential single-VU execution with a `rate==1.0` checks threshold (so k6
exits non-zero on any test failure).

```typescript
export const options = suiteOptions(suite);
// equivalent to:
// { vus: 1, iterations: 1, thresholds: { checks: ['rate==1.0'] } }

// Override any field:
export const options = suiteOptions(suite, { duration: '30s', vus: 5 });
```

### `mergeSuites(...suites)` — combine multiple suites

Creates a virtual root suite that runs each child in declaration order. Useful for splitting suites across files.

```typescript
import { authSuite } from './suites/auth.ts';
import { productSuite } from './suites/products.ts';

const all = mergeSuites(authSuite, productSuite);

export const options = suiteOptions(all);
export default async function () {
  await all.run();
}
```

### `configure(options)` — global settings

Must be called **before** any `describe()` call. Calling it inside `describe` or `run()` is a no-op and logs a warning.

```typescript
import { configure } from 'k6-test-jest-style';

configure({
  nameSeparator: ' > ', // default: ' > '
  continueOnHookFailure: true, // default: true
  verbose: false, // default: false
});
```

## Nested suites

Nesting is supported to arbitrary depth. `beforeEach` / `afterEach` declared in an outer suite are inherited by all
inner suites.

```typescript
describe('Auth', () => {
  let token: string;

  describe('Login', () => {
    test('valid credentials return token', async () => {
      /* ... */
    });
    test('invalid credentials return 401', async () => {
      /* ... */
    });
  });

  describe('Logout', () => {
    beforeEach(async () => {
      token = await getToken();
    });
    test('valid token returns 200', async () => {
      /* ... */
    });
  });
});
```

## Skipping and focusing

```typescript
describe('Feature', () => {
  test('runs normally', () => {
    /* ... */
  });
  test.skip('not implemented yet', () => {
    /* ... */
  });
});

// Skip an entire suite
describe.skip('Blocked by JIRA-123', () => {
  test('never runs', () => {
    /* ... */
  });
});
```

## How test results map to k6 output

Each test produces exactly one `check()` call. The check name is the full suite path:

```
✓ Users API > GET returns 200
✓ Users API > GET returns correct body
✗ Users API > DELETE returns 404 [FAILED: expected 404, got 500]
```

The separator (`>`) is configurable via `configure({ nameSeparator })`.

## Execution model

k6 evaluates scripts in two phases. `k6-test-jest-style` is designed around this constraint:

| Phase                | When                   | What k6-test-jest-style does                  |
| -------------------- | ---------------------- | --------------------------------------------- |
| **Init context**     | Once per VU at startup | `describe()` builds the `SuiteNode` tree      |
| **Default function** | Once per VU iteration  | `suite.run()` traverses and executes the tree |

`describe` callbacks must be **synchronous** — k6 init context does not support async. Hook and test functions may be
async.

## Constraints

- No `expect()` API — use k6's `check()` directly
- No module mocking — k6 runtime does not support it
- No parallelism between tests — sequential by design (1 VU); k6 multi-VU is for load, not test isolation
- `describe()` must not be called inside `run()` or `export default`

## Development

```bash
yarn build   # tsc (declarations) + esbuild (CJS bundle) → dist/
yarn test    # k6 run tests/self-test.k6.ts
```

Requires k6 ≥ 1.0 and Node.js for the build step.
