import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../components/assistant/useAssistantUseful.js", import.meta.url), "utf8");
const body = src.match(/export function assistantUseful\(status, actionConfig\) \{([\s\S]*?)\n\}/)[1];
const assistantUseful = new Function("status", "actionConfig", body);

test("the assistant is shown only with a language model or with assistant actions on", () => {
  assert.equal(assistantUseful({ mode: "demo" }, { enabled: false }), false);
  assert.equal(assistantUseful({ mode: "demo" }, null), false);
  assert.equal(assistantUseful(null, null), false);
  assert.equal(assistantUseful({ mode: "llm" }, null), true);
  assert.equal(assistantUseful({ mode: "demo" }, { enabled: true }), true);
  assert.equal(assistantUseful({ mode: "demo", show_in_demo: true }, null), true, "an explicit setting keeps it visible in demo mode");
});

test("App renders the assistant panel only when it is useful", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(app, /const assistantShown = useAssistantUseful\(\);/);
  assert.match(app, /\{!sshPage && assistantShown && <AssistantPanel /);
});
