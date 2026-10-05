const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
const object = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const count = value => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const list = value => Array.isArray(value) ? value : [];
const first = (record, camel, snake) => record[camel] ?? record[snake];

export function serializeMaritimeEnrichment(entity = {}) {
  const extra = object(entity.extra_data);
  const source = object(object(extra.magicport_company).fleet_summary);
  const email = text(entity.public_email);
  let website = text(entity.website);
  try {
    if (website) {
      const parsed = new URL(website);
      if (!["http:", "https:"].includes(parsed.protocol) || /(^|\.)magicport\.ai$/i.test(parsed.hostname)) website = null;
    }
  } catch { website = null; }
  const fleetSummary = {
    vesselCount: count(first(source, "vesselCount", "vessel_count")),
    totalDwt: count(first(source, "totalDwt", "total_dwt")),
    activePortCount: count(first(source, "activePortCount", "active_port_count")),
    topVisitedPorts: list(first(source, "topVisitedPorts", "top_visited_ports")),
    vesselTypeMix: list(first(source, "vesselTypeMix", "vessel_type_mix")),
    ageBands: list(first(source, "ageBands", "age_bands")),
  };
  return { contact: {
    email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
    website, phone: text(entity.public_phone), address: text(entity.public_address),
  }, fleetSummary };
}
