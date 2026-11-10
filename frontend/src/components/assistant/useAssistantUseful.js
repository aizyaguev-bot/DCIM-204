import { useEffect, useState } from "react";
import { getStatus } from "../../api/assistant";
import { getConfig as getActionConfig } from "../../api/assistantActions";

// The lab assistant is shown only when it adds something: a language model is connected (status mode "llm"), or
// assistant actions are turned on. Without either it would only answer in demo mode, so it stays hidden until an
// Admin connects a key (Admin -> AI assistant) or turns actions on; checked again every few minutes.
export function assistantUseful(status, actionConfig) {
  return status?.mode === "llm" || actionConfig?.enabled === true || status?.show_in_demo === true;
}

export default function useAssistantUseful(enabled = true, intervalMs = 5 * 60 * 1000) {
  const [useful, setUseful] = useState(false);
  useEffect(() => {
    if (!enabled) { setUseful(false); return undefined; }
    let active = true;
    const check = async () => {
      const [status, actions] = await Promise.all([
        getStatus().catch(() => null),
        getActionConfig().catch(() => null),
      ]);
      if (active) setUseful(assistantUseful(status, actions));
    };
    check();
    const timer = setInterval(check, intervalMs);
    return () => { active = false; clearInterval(timer); };
  }, [enabled, intervalMs]);
  return useful;
}
