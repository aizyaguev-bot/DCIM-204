import { useCallback, useEffect, useState } from "react";

// A per-viewer convenience kept in localStorage (remembered tab, collapsed cards…). Storage can be missing or throw
// (private window, blocked site data): the page then simply uses the default.
export function readStored(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function useStoredState(key, fallback) {
  const [value, setValue] = useState(() => readStored(key, fallback));
  const set = useCallback(next => {
    setValue(prev => {
      const resolved = typeof next === "function" ? next(prev) : next;
      try { window.localStorage.setItem(key, JSON.stringify(resolved)); } catch { /* storage unavailable */ }
      return resolved;
    });
  }, [key]);
  return [value, set];
}

export function useMediaQuery(query) {
  const get = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener?.("change", onChange);
    return () => list.removeEventListener?.("change", onChange);
  }, [query]);
  return matches;
}

export function useDebounced(value, ms) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export const prefersReducedMotion = () => {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
};

// Briefly outlines an element after a jump (skipped when the viewer prefers less motion).
export function flash(el) {
  if (!el || prefersReducedMotion()) return;
  el.classList.remove("is-flash");
  void el.offsetWidth;
  el.classList.add("is-flash");
  setTimeout(() => el.classList.remove("is-flash"), 1200);
}
