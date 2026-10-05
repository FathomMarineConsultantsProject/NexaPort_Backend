import test from "node:test";
import assert from "node:assert/strict";
import { serializeMaritimeEnrichment } from "../src/utils/maritimeDirectoryEnrichment.js";

test("directory enrichment serializer maps canonical contact and camelCase MagicPort fleet", () => {
  const entity = { public_email: "ops@example.com", website: "https://example.com", public_phone: null,
    public_address: "1 Harbour Road", extra_data: { unrelated: { keep: true }, magicport_company: {
      fleet_summary: { vesselCount: 7, totalDwt: 12345, activePortCount: 4,
        topVisitedPorts: [{ name: "Singapore", unlocode: "SGSIN" }],
        vesselTypeMix: [{ name: "Tanker", percent: 100 }], ageBands: [{ band: "6-15 years", percent: 100 }] } } } };
  const result = serializeMaritimeEnrichment(entity);
  assert.deepEqual(result.contact, { email: "ops@example.com", website: "https://example.com", phone: null, address: "1 Harbour Road" });
  assert.equal(result.fleetSummary.vesselCount, 7);
  assert.equal(result.fleetSummary.totalDwt, 12345);
  assert.equal(result.fleetSummary.activePortCount, 4);
  assert.equal(result.fleetSummary.topVisitedPorts[0].unlocode, "SGSIN");
  assert.deepEqual(entity.extra_data.unrelated, { keep: true });
  assert.equal(JSON.stringify(result).includes("unrelated"), false);
});

test("directory enrichment serializer safely handles missing and legacy fleet data", () => {
  const missing = serializeMaritimeEnrichment({ extra_data: null, public_email: "not-an-email", website: "https://magicport.ai/example" });
  assert.deepEqual(missing.fleetSummary, { vesselCount: null, totalDwt: null, activePortCount: null,
    topVisitedPorts: [], vesselTypeMix: [], ageBands: [] });
  assert.equal(missing.contact.email, null);
  assert.equal(missing.contact.website, null);
  const legacy = serializeMaritimeEnrichment({ extra_data: { magicport_company: { fleet_summary: { vessel_count: 0, total_dwt: 90 } } } });
  assert.equal(legacy.fleetSummary.vesselCount, 0);
  assert.equal(legacy.fleetSummary.totalDwt, 90);
});
