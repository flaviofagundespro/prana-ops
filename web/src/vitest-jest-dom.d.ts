/**
 * Makes the jest-dom matchers (toBeInTheDocument, toHaveTextContent, ...)
 * visible to `tsc` for the RTL component tests. The runtime registration lives
 * in `test/setup.ts` (`import '@testing-library/jest-dom/vitest'`); this file is
 * the type-only counterpart, referenced from `src` so the web tsconfig picks it
 * up (its `include` is `src`).
 */
import '@testing-library/jest-dom/vitest';
