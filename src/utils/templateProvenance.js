const clean = (value) => String(value ?? "").trim();

export function isProvenanceOnlyLabel(value) {
  const label = clean(value);
  if (!label) return false;
  return /^(?:[A-Z]{1,3}\d+)(?::[A-Z]{1,3}\d+)?$/i.test(label)
    || /^(?:block|part)-\d+$/i.test(label)
    || /^cell\s+\d+$/i.test(label)
    || /^(?:blank\s+)?(?:cell|input)\s+[A-Z]{1,3}\d+$/i.test(label)
    || /^(?:word\/)?(?:header|footer)\d*\.xml$/i.test(label)
    || /^\/(?:[^/\s]+\/)*[^/\s]+(?:\[\d+\])?$/.test(label)
    || /^(?:x|left)\s*[:=]?\s*-?\d+(?:\.\d+)?\s*[,; ]+\s*(?:y|top)\s*[:=]?\s*-?\d+(?:\.\d+)?$/i.test(label);
}
