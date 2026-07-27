import "@testing-library/jest-dom";

// Stub Vite-injected globals so tests don't see undefined
globalThis.__APP_VERSION__   = "v1.1.0";
globalThis.__BUILD_VERSION__ = "test · 2026-01-01";

// Silence console.error from intentional error-boundary tests
// (remove this line if you want noisy output)
// vi.spyOn(console, "error").mockImplementation(() => {});
