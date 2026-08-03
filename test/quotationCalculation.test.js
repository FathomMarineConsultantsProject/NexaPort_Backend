import assert from "node:assert/strict";
import test from "node:test";
import { calculateQuotationTotals } from "../src/controllers/quotationController.js";

const quote = (overrides = {}) => ({
  total_quote_usd: 1000,
  travel_cost: 0,
  accommodation_cost: 0,
  report_fee: 0,
  urgency_surcharge: 0,
  ...overrides,
});

test("quotation totals include every consultant cost exactly once", () => {
  assert.deepEqual(calculateQuotationTotals(quote()), {
    consultantTotalUsd: 1000,
    markupUsd: 0,
    clientTotalUsd: 1000,
  });
  assert.equal(calculateQuotationTotals(quote({ travel_cost: 150 })).consultantTotalUsd, 1150);
  assert.equal(calculateQuotationTotals(quote({
    travel_cost: 150,
    accommodation_cost: 150,
    urgency_surcharge: 150,
  })).consultantTotalUsd, 1450);
  assert.equal(calculateQuotationTotals(quote({ report_fee: 75 })).consultantTotalUsd, 1075);
  assert.equal(calculateQuotationTotals(quote({
    travel_cost: 10,
    accommodation_cost: 20,
    report_fee: 30,
    urgency_surcharge: 40,
  })).consultantTotalUsd, 1100);
});

test("null, empty, missing, and non-finite optional costs count as zero", () => {
  assert.equal(calculateQuotationTotals({
    total_quote_usd: 1000,
    travel_cost: null,
    accommodation_cost: "",
    report_fee: undefined,
    urgency_surcharge: "invalid",
  }).consultantTotalUsd, 1000);
});

test("admin markup is added after the consultant total", () => {
  const fullQuote = quote({
    travel_cost: 150,
    accommodation_cost: 150,
    urgency_surcharge: 150,
  });

  assert.equal(calculateQuotationTotals(fullQuote, 50).clientTotalUsd, 1500);
  assert.equal(calculateQuotationTotals(fullQuote, 500).clientTotalUsd, 1950);
});

test("calculating totals does not mutate historical quotation values", () => {
  const acceptedQuote = Object.freeze({
    ...quote({ travel_cost: 150 }),
    status: "accepted",
    client_total_usd: 1050,
  });

  calculateQuotationTotals(acceptedQuote, 50);
  assert.equal(acceptedQuote.client_total_usd, 1050);
});
