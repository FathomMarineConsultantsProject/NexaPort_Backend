import { findInspectionMethod } from "./inspectionCatalogueService.js";
import { resolveRequestPort } from "./requestParticularsService.js";
import { generateGeminiScope, scopeError } from "./geminiScopeService.js";

const fail = scopeError;
const limits = { keywords: 1000, vesselType: 240, portName: 240, terminalName: 240, eta: 40, existingScope: 12000, legacyCertification: 2000 };
export async function resolveScopeInput(body, queryable) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw fail(400, "INVALID_SCOPE_INPUT", "Provide scope keywords.");
  const context = {};
  for (const [field, max] of Object.entries(limits)) {
    if (body[field] == null) continue;
    if (typeof body[field] !== "string" || body[field].length > max) throw fail(400, "INVALID_SCOPE_INPUT", `${field} must be text of ${max} characters or fewer.`);
    context[field] = body[field].trim();
  }
  if (!context.keywords) throw fail(400, "INVALID_SCOPE_INPUT", "Enter a few keywords to generate a scope.");
  if (body.inspectionMethodId != null && body.inspectionMethodId !== "") {
    const method = await findInspectionMethod(queryable, body.inspectionMethodId);
    if (!method) throw fail(400, "INVALID_SCOPE_INPUT", "Select a valid service.");
    context.service = method.name;
    context.vertical = method.vertical_name;
  }
  if (body.portId != null && body.portId !== "") {
    try {
      const port = await resolveRequestPort(queryable, body.portId);
      context.portName = port.port_name;
    } catch (error) {
      if (error.status === 400) throw fail(400, "INVALID_SCOPE_INPUT", error.message);
      throw error;
    }
  }
  return context;
}

export const generateScope = generateGeminiScope;
