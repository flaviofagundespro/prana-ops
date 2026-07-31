/**
 * Vitest setup for the web workspace.
 *
 * xterm.js probes HTMLCanvasElement.getContext at import time to build its
 * color palette. jsdom does not implement canvas, which produces a noisy (but
 * harmless) "Not implemented" warning. We stub getContext to a no-op so the
 * smoke test output stays clean without pulling in the heavy `canvas` package.
 */
HTMLCanvasElement.prototype.getContext = (() => null) as never;

// jest-dom matchers (toHaveTextContent, toBeInTheDocument, ...) for RTL tests.
import '@testing-library/jest-dom/vitest';
