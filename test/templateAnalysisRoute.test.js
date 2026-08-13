import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { allowRoles } from "../src/middlewares/authMiddleware.js";
import { createAnalyseTemplate } from "../src/controllers/templateController.js";

const source = (file) => readFile(new URL(file, import.meta.url), "utf8");

test("template analyse remains behind authentication and exact allowed roles", async () => {
  const routes = await source("../src/routes/templateRoutes.js");
  assert.ok(routes.indexOf("router.use(requireAuth, allowRoles(1, 2))") < routes.indexOf('router.post("/analyse"'));
  const next = () => { next.called = true; }; const response = { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  allowRoles(1, 2)({ user: { role_id: 1 } }, response, next); assert.equal(next.called, true);
  allowRoles(1, 2)({ user: { role_id: 3 } }, response, () => {}); assert.equal(response.statusCode, 403); assert.equal(response.body.message, "Access denied");
});

test("template analyse accepts one in-memory document and does not log document contents", async () => {
  const routes = await source("../src/routes/templateRoutes.js"); const controller = await source("../src/controllers/templateController.js");
  assert.match(routes, /limits: \{ files: 1, fileSize:/); assert.match(routes, /uploadTemplateDocument/);
  assert.match(controller, /parseDocument\(req\.file/); assert.doesNotMatch(controller, /console\.(?:info|error)\([^\n]*(?:req\.file\.buffer|document\.content)/);
});

test("an authenticated route payload returns validated generated fields", async () => {
  let aiInput; const req = { body: { sourceType: "docx" }, file: { buffer: Buffer.from("fixture"), originalname: "fixture.docx" }, once() {} };
  const res = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  const document = { fileName: "fixture.docx", fileType: "docx", blocks: [{ id: "block-0", text: "Inspection Date" }] };
  const fields = [{ fieldKey: "inspection_date", label: "Inspection Date", fieldType: "date", sectionKey: "general", sortOrder: 0 }];
  await createAnalyseTemplate({ parseDocument: async () => document, analyseWithAi: async (input) => { aiInput = input; return { providerUsed: "gemini", modelUsed: "test", fallbackUsed: false, fallbackReason: null, sections: [{ sectionKey: "general", title: "General", order: 0 }], fields }; } })(req, res);
  assert.equal(res.statusCode, 200); assert.deepEqual(res.body.data.fields, fields); assert.strictEqual(aiInput.document, document); assert.equal(aiInput.mode, "map");
});
