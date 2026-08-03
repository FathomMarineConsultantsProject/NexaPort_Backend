import { XMLParser } from "fast-xml-parser";
import { normalizeFields } from "./templateFieldService.js";

const UNSAFE_XML = /<!DOCTYPE|<!ENTITY|<\?[^?]*(?:SYSTEM|PUBLIC|https?:|file:)[^?]*\?>/i;

export function extractXmlFields(buffer) {
  const source = buffer.toString("utf8");
  if (UNSAFE_XML.test(source)) throw Object.assign(new Error("XML containing DOCTYPE, entity declarations, or external processing instructions is not supported."), { status: 400 });
  let parsed;
  try {
    parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", processEntities: false, allowBooleanAttributes: true }).parse(source);
  } catch { throw Object.assign(new Error("The XML file is malformed."), { status: 400 }); }
  const candidates = [];
  const template = parsed?.inspectionTemplate;
  const sections = template?.section ? (Array.isArray(template.section) ? template.section : [template.section]) : [];
  for (const section of sections) {
    const fields = section.field ? (Array.isArray(section.field) ? section.field : [section.field]) : [];
    for (const field of fields) candidates.push({ fieldKey: field["@_key"], label: field["@_label"] || field["@_key"], type: field["@_type"], required: String(field["@_required"]).toLowerCase() === "true", section: section["@_name"] });
  }
  if (!candidates.length) {
    const walk = (value, path = []) => {
      if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
        if (path.length && !path.at(-1).startsWith("@_")) candidates.push({ label: path.at(-1).replace(/[_-]+/g, " "), section: path.slice(0, -1).join(" / ") || "General", defaultValue: value });
        return;
      }
      if (Array.isArray(value)) value.forEach((item, index) => walk(item, [...path, String(index + 1)]));
      else if (typeof value === "object") Object.entries(value).forEach(([key, item]) => walk(item, [...path, key]));
    };
    walk(parsed);
  }
  return { mode: template ? "nexaport_xml" : "generic_xml", title: template?.title || null, fields: normalizeFields(candidates.slice(0, 250), { keepKeys: true }), message: template ? "NexaPort XML fields extracted." : "Leaf nodes were proposed as fields. XML does not provide page-layout coordinates." };
}
