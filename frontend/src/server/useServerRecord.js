// The record of one server window (serverRecord.js buildRecord), rebuilt when the provider's data changes.
import { useMemo } from "react";
import { useLabWindow } from "../window/labWindowContext.js";
import { buildRecord } from "./serverRecord.js";

export function useServerRecord(key) {
  const { data } = useLabWindow();
  return useMemo(() => buildRecord(key, data), [key, data]);
}
