import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { analyseWithGemini, analyseTemplate, classifyGeminiFailure } from "../src/services/templateAiProviderService.js";
import { templateAiPrompts, normalizeAnalysisInput, validateMapping } from "../src/services/openRouterTemplateService.js";

const baseEnv = {
  GEMINI_API_KEY: 'test-key',
  GEMINI_TEMPLATE_MODEL: 'gemini-3.6-flash',
  GEMINI_TEMPLATE_THINKING_LEVEL: 'medium',
  GEMINI_TEMPLATE_TIMEOUT_MS: '30000',
  GEMINI_TEMPLATE_MAX_OUTPUT_TOKENS: '8192',
  OPENROUTER_API_KEY: 'test-openrouter-key',
  OPENROUTER_TEMPLATE_MODEL: 'google/gemini-3.5-flash',
  OPENROUTER_TEMPLATE_REASONING_EFFORT: 'medium',
  TEMPLATE_AI_PRIMARY: 'gemini',
  TEMPLATE_AI_FALLBACK: 'openrouter',
};

const makeNormalized = () => normalizeAnalysisInput({
  mode: 'map', sourceType: 'pdf', documentTitle: 'Test Checklist',
  chunk: { id: 'chunk-0', index: 0, blocks: [
    { id: 'block-0', globalOrder: 0, partOrder: 0, type: 'paragraph', text: 'Fire Pump Condition Yes No N/A', metadata: {}, location: { partIndex: 0 } },
    { id: 'block-1', globalOrder: 1, partOrder: 1, type: 'paragraph', text: 'Checked By (Sign)', metadata: {}, location: { partIndex: 0 } },
    { id: 'block-2', globalOrder: 2, partOrder: 2, type: 'paragraph', text: 'Other Remarks', metadata: {}, location: { partIndex: 0 } },
  ] }, globalContext: {},
});

const makeGeminiOutput = (overrides = {}) => ({
  documentTitle: 'Test Checklist',
  sections: [{ sectionKey: 'general', title: 'General', sourceOrder: 0, evidenceRefs: ['block-0'] }],
  fields: [
    { fieldKey: 'fire_pump_condition', label: 'Fire Pump Condition', fieldType: 'select', required: false, sectionKey: 'general', sourceOrder: 0, options: ['Yes', 'No', 'N/A'], sourceText: 'Fire Pump Condition Yes No N/A', evidenceRefs: ['block-0'], confidence: 0.95, warning: '' },
    { fieldKey: 'checked_by_sign', label: 'Checked By (Sign)', fieldType: 'signature', required: false, sectionKey: 'general', sourceOrder: 1, options: [], sourceText: 'Checked By (Sign)', evidenceRefs: ['block-1'], confidence: 0.95, warning: '' },
    { fieldKey: 'other_remarks', label: 'Other Remarks', fieldType: 'textarea', required: false, sectionKey: 'general', sourceOrder: 2, options: [], sourceText: 'Other Remarks', evidenceRefs: ['block-2'], confidence: 0.95, warning: '' },
  ],
  classifications: [
    { blockId: 'block-0', classification: 'field', reason: 'Checklist item' },
    { blockId: 'block-1', classification: 'field', reason: 'Signature field' },
    { blockId: 'block-2', classification: 'field', reason: 'Remarks field' },
  ],
  notes: [], referenceData: [], warnings: [], unmappedBlocks: [],
  ...overrides,
});

const makeIndexDocumentOutput = () => ({
  documentTitle: 'D/00 INDEX TO DECK CHECKLISTS',
  sections: [], fields: [],
  classifications: [], notes: [], referenceData: [],
  warnings: ['This is an index/reference document listing other checklists. No inspector-fillable fields identified.'],
  unmappedBlocks: [],
});

const makeMockGeminiClient = (responseText, shouldThrow = null) => ({
  models: {
    generateContent: async (params) => {
      if (shouldThrow) throw shouldThrow;
      return { text: typeof responseText === 'string' ? responseText : JSON.stringify(responseText) };
    },
  },
});

const makeMockOpenRouterFetch = (responseOutput) => async (_url, options) => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: JSON.stringify(responseOutput) } }] }),
});

describe('Gemini SDK method verification', () => {
  test('analyseWithGemini invokes client.models.generateContent (NOT client.interactions.create)', async () => {
    const normalized = makeNormalized();
    const output = makeGeminiOutput();
    let generateContentCalled = false;
    let generateContentParams = null;
    const mockClient = {
      models: {
        generateContent: async (params) => {
          generateContentCalled = true;
          generateContentParams = params;
          return { text: JSON.stringify(output) };
        },
      },
      interactions: {
        create: async () => { throw new Error('interactions.create MUST NOT be called'); },
      },
    };

    await analyseWithGemini(normalized, { env: baseEnv, geminiClient: mockClient });
    assert.equal(generateContentCalled, true, 'client.models.generateContent must be called');
    assert.equal(generateContentParams.model, 'gemini-3.6-flash');
    assert.ok(generateContentParams.config?.systemInstruction, 'systemInstruction must be set');
    assert.equal(generateContentParams.config?.responseMimeType, 'application/json');
    assert.ok(generateContentParams.config?.responseJsonSchema, 'responseJsonSchema must be set');
    assert.equal(generateContentParams.config?.thinkingConfig?.thinkingLevel, 'MEDIUM');
    assert.equal("includeThoughts" in generateContentParams.config.thinkingConfig, false);
    assert.equal(generateContentParams.config?.httpOptions?.timeout, 30000);
  });

  test('constructs GoogleGenAI with only the backend API key', async () => {
    const normalized = makeNormalized(); let constructorOptions; let generateContentCalls = 0;
    class MockGoogleGenAI {
      constructor(options) { constructorOptions = options; this.models = { generateContent: async () => { generateContentCalls += 1; return { text: JSON.stringify(makeGeminiOutput()) }; } }; }
    }
    await analyseWithGemini(normalized, { env: baseEnv, googleGenAiCtor: MockGoogleGenAI });
    assert.deepEqual(constructorOptions, { apiKey: 'test-key' });
    assert.equal(generateContentCalls, 1);
  });

  test('a valid mocked Gemini response produces fields', async () => {
    const normalized = makeNormalized();
    const output = makeGeminiOutput();
    const mockClient = makeMockGeminiClient(output);
    const result = await analyseWithGemini(normalized, { env: baseEnv, geminiClient: mockClient });
    assert.equal(result.providerUsed, 'gemini');
    assert.equal(result.modelUsed, 'gemini-3.6-flash');
    assert.ok(result.output, 'output must be returned');
  });
});

describe('Provider fallback logic', () => {
  test('Gemini success does not invoke OpenRouter', async () => {
    const normalized = makeNormalized();
    const output = makeGeminiOutput();
    const mockClient = makeMockGeminiClient(output);
    let openRouterCalled = false;

    const result = await analyseTemplate(
      { mode: 'map', sourceType: 'pdf', documentTitle: 'Test Checklist', chunk: { id: 'chunk-0', index: 0, blocks: normalized.chunk.blocks }, globalContext: {} },
      { env: baseEnv, geminiClient: mockClient, fetchImpl: async () => { openRouterCalled = true; return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) }; } },
    );
    assert.equal(openRouterCalled, false, 'OpenRouter must NOT be called on Gemini success');
    assert.equal(result.fallbackUsed, false);
  });

  test('Gemini 429 invokes OpenRouter fallback', async () => {
    const normalized = makeNormalized();
    const rateLimitError = Object.assign(new Error('Rate limited'), { status: 429 });
    const mockClient = makeMockGeminiClient(null, rateLimitError);
    const output = makeGeminiOutput();

    const result = await analyseTemplate(
      { mode: 'map', sourceType: 'pdf', documentTitle: 'Test Checklist', chunk: { id: 'chunk-0', index: 0, blocks: normalized.chunk.blocks }, globalContext: {} },
      { env: baseEnv, geminiClient: mockClient, fetchImpl: makeMockOpenRouterFetch(output) },
    );
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.fallbackReason, 'rate_limited');
    assert.equal(result.providerUsed, 'openrouter');
  });

  test('Gemini RESOURCE_EXHAUSTED invokes OpenRouter fallback', async () => {
    const normalized = makeNormalized();
    const exhaustedError = Object.assign(new Error('Resource exhausted'), { code: 'RESOURCE_EXHAUSTED' });
    const mockClient = makeMockGeminiClient(null, exhaustedError);
    const output = makeGeminiOutput();

    const result = await analyseTemplate(
      { mode: 'map', sourceType: 'pdf', documentTitle: 'Test Checklist', chunk: { id: 'chunk-0', index: 0, blocks: normalized.chunk.blocks }, globalContext: {} },
      { env: baseEnv, geminiClient: mockClient, fetchImpl: makeMockOpenRouterFetch(output) },
    );
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.fallbackReason, 'rate_limited');
  });

  test('Gemini temporary 503 retries then falls back to OpenRouter', async () => {
    const normalized = makeNormalized();
    let geminiCalls = 0;
    const mockClient = {
      models: {
        generateContent: async () => { geminiCalls++; throw Object.assign(new Error('Service unavailable'), { status: 503 }); },
      },
    };
    const output = makeGeminiOutput();

    const result = await analyseTemplate(
      { mode: 'map', sourceType: 'pdf', documentTitle: 'Test Checklist', chunk: { id: 'chunk-0', index: 0, blocks: normalized.chunk.blocks }, globalContext: {} },
      { env: baseEnv, geminiClient: mockClient, fetchImpl: makeMockOpenRouterFetch(output), sleep: async () => {} },
    );
    assert.equal(geminiCalls, 2, 'Gemini should be retried once');
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.fallbackReason, 'provider_unavailable');
  });

  test('Gemini network timeout retries then falls back', async () => {
    const normalized = makeNormalized();
    let geminiCalls = 0;
    const mockClient = {
      models: {
        generateContent: async () => { geminiCalls++; const err = new Error('Timed out'); err.name = 'TimeoutError'; throw err; },
      },
    };
    const output = makeGeminiOutput();

    const result = await analyseTemplate(
      { mode: 'map', sourceType: 'pdf', documentTitle: 'Test Checklist', chunk: { id: 'chunk-0', index: 0, blocks: normalized.chunk.blocks }, globalContext: {} },
      { env: baseEnv, geminiClient: mockClient, fetchImpl: makeMockOpenRouterFetch(output), sleep: async () => {} },
    );
    assert.equal(geminiCalls, 2, 'Gemini should be retried once on timeout');
    assert.equal(result.fallbackUsed, true);
    assert.match(result.fallbackReason, /timeout/);
  });

  test('OpenRouter mocked success produces fields', async () => {
    const normalized = makeNormalized();
    const output = makeGeminiOutput();
    const rateLimitError = Object.assign(new Error('Rate limited'), { status: 429 });
    const mockClient = makeMockGeminiClient(null, rateLimitError);

    const result = await analyseTemplate(
      { mode: 'map', sourceType: 'pdf', documentTitle: 'Test Checklist', chunk: { id: 'chunk-0', index: 0, blocks: normalized.chunk.blocks }, globalContext: {} },
      { env: baseEnv, geminiClient: mockClient, fetchImpl: makeMockOpenRouterFetch(output) },
    );
    assert.ok(result.fields.length > 0, 'OpenRouter fallback must produce fields');
    assert.equal(result.providerUsed, 'openrouter');
  });
});

describe('Configuration and authentication errors', () => {
  test('missing Gemini API key returns clear configuration failure', async () => {
    const normalized = makeNormalized();
    const envWithoutKey = { ...baseEnv, GEMINI_API_KEY: '' };
    await assert.rejects(
      () => analyseWithGemini(normalized, { env: envWithoutKey }),
      (error) => {
        assert.match(error.message, /primary API key is missing/);
        assert.equal(error.reason, 'configuration_error');
        assert.equal(error.retryable, false);
        return true;
      },
    );
  });

  test('invalid Gemini authentication does not masquerade as extraction success', async () => {
    const normalized = makeNormalized();
    const authError = Object.assign(new Error('API key invalid'), { status: 401 });
    const mockClient = makeMockGeminiClient(null, authError);
    await assert.rejects(
      () => analyseTemplate(
        { mode: 'map', sourceType: 'pdf', documentTitle: 'Test', chunk: { id: 'chunk-0', index: 0, blocks: normalized.chunk.blocks }, globalContext: {} },
        { env: baseEnv, geminiClient: mockClient },
      ),
      (error) => {
        assert.equal(error.reason, 'authentication_error');
        assert.equal(error.retryable, false);
        return true;
      },
    );
  });
});

describe('classifyGeminiFailure classifications', () => {
  test('429 is rate_limited with fallback allowed', () => {
    const result = classifyGeminiFailure({ status: 429 });
    assert.equal(result.reason, 'rate_limited');
    assert.equal(result.fallbackAllowed, true);
  });

  test('RESOURCE_EXHAUSTED is rate_limited with fallback allowed', () => {
    const result = classifyGeminiFailure({ code: 'RESOURCE_EXHAUSTED' });
    assert.equal(result.reason, 'rate_limited');
    assert.equal(result.fallbackAllowed, true);
  });

  test('5xx is provider_unavailable with fallback and retry', () => {
    const result = classifyGeminiFailure({ status: 503 });
    assert.equal(result.reason, 'provider_unavailable');
    assert.equal(result.fallbackAllowed, true);
    assert.equal(result.retry, true);
  });

  test('401 is authentication_error without fallback', () => {
    const result = classifyGeminiFailure({ status: 401 });
    assert.equal(result.reason, 'authentication_error');
    assert.equal(result.fallbackAllowed, false);
  });

  test('403 is access_denied without fallback', () => {
    const result = classifyGeminiFailure({ status: 403 });
    assert.equal(result.reason, 'access_denied');
    assert.equal(result.fallbackAllowed, false);
  });

  test('unknown programmer error is application_error without fallback', () => {
    const result = classifyGeminiFailure(new TypeError('Cannot read properties of undefined'));
    assert.equal(result.reason, 'application_error');
    assert.equal(result.fallbackAllowed, false, 'programmer errors must not be hidden by fallback');
  });

  test('TimeoutError classifies as timeout with fallback', () => {
    const err = new Error('Timed out'); err.name = 'TimeoutError';
    const result = classifyGeminiFailure(err);
    assert.equal(result.reason, 'timeout');
    assert.equal(result.fallbackAllowed, true);
    assert.equal(result.retry, true);
  });

  test('network errors classify with fallback', () => {
    const result = classifyGeminiFailure({ code: 'ECONNRESET' });
    assert.equal(result.reason, 'network_error');
    assert.equal(result.fallbackAllowed, true);
  });
});

describe('Extraction quality with mocked AI', () => {
  test('Checked By (Sign) remains signature', async () => {
    const normalized = makeNormalized();
    const output = makeGeminiOutput();
    const mockClient = makeMockGeminiClient(output);
    const result = await analyseTemplate(
      { mode: 'map', sourceType: 'pdf', documentTitle: 'Test Checklist', chunk: { id: 'chunk-0', index: 0, blocks: normalized.chunk.blocks }, globalContext: {} },
      { env: baseEnv, geminiClient: mockClient },
    );
    const signField = result.fields.find(f => f.label.includes('Checked By'));
    assert.ok(signField, 'Checked By field must exist');
    assert.equal(signField.fieldType, 'signature');
  });

  test('Other Remarks remains textarea', async () => {
    const normalized = makeNormalized();
    const output = makeGeminiOutput();
    const mockClient = makeMockGeminiClient(output);
    const result = await analyseTemplate(
      { mode: 'map', sourceType: 'pdf', documentTitle: 'Test Checklist', chunk: { id: 'chunk-0', index: 0, blocks: normalized.chunk.blocks }, globalContext: {} },
      { env: baseEnv, geminiClient: mockClient },
    );
    const remarksField = result.fields.find(f => f.label.includes('Other Remarks'));
    assert.ok(remarksField, 'Other Remarks field must exist');
    assert.equal(remarksField.fieldType, 'textarea');
  });

  test('index document can correctly return zero genuine fields', async () => {
    const indexInput = normalizeAnalysisInput({
      mode: 'map', sourceType: 'pdf', documentTitle: 'D/00 INDEX TO DECK CHECKLISTS',
      chunk: { id: 'chunk-0', index: 0, blocks: [
        { id: 'block-0', globalOrder: 0, partOrder: 0, type: 'paragraph', text: 'D/00 INDEX TO DECK CHECKLISTS', metadata: {}, location: { partIndex: 0 } },
        { id: 'block-1', globalOrder: 1, partOrder: 1, type: 'table_row', text: 'S.No. Title Action Date Revision Number', metadata: {}, location: { partIndex: 0 } },
        { id: 'block-2', globalOrder: 2, partOrder: 2, type: 'table_row', text: 'D/01 Passage Planning', metadata: {}, location: { partIndex: 0 } },
      ] }, globalContext: {},
    });
    const output = makeIndexDocumentOutput();
    const mockClient = makeMockGeminiClient(output);
    const result = await analyseTemplate(
      { mode: 'map', sourceType: 'pdf', documentTitle: 'D/00 INDEX', chunk: indexInput.chunk, globalContext: {} },
      { env: baseEnv, geminiClient: mockClient },
    );
    assert.equal(result.fields.length, 0, 'Index document should produce zero fields');
  });

  test('instruction sentence does not become a field', async () => {
    const normalized = normalizeAnalysisInput({
      mode: 'map', sourceType: 'pdf', documentTitle: 'Test',
      chunk: { id: 'chunk-0', index: 0, blocks: [
        { id: 'block-0', globalOrder: 0, partOrder: 0, type: 'paragraph', text: 'No changes should be made to revision number', metadata: {}, location: { partIndex: 0 } },
      ] }, globalContext: {},
    });
    const output = {
      documentTitle: 'Test', sections: [], fields: [],
      classifications: [{ blockId: 'block-0', classification: 'instruction', reason: 'This is an instruction' }],
      notes: [], referenceData: [], warnings: [], unmappedBlocks: [],
    };
    const mockClient = makeMockGeminiClient(output);
    const result = await analyseTemplate(
      { mode: 'map', sourceType: 'pdf', documentTitle: 'Test', chunk: normalized.chunk, globalContext: {} },
      { env: baseEnv, geminiClient: mockClient },
    );
    assert.equal(result.fields.length, 0, 'Instruction should not produce fields');
  });

  test('MeOH-style checklist returns many semantic fields', async () => {
    const normalized = normalizeAnalysisInput({
      mode: 'map', sourceType: 'docx', documentTitle: 'MeOH TK Checklist',
      chunk: { id: 'chunk-0', index: 0, blocks: [
        { id: 'block-0', globalOrder: 0, partOrder: 0, type: 'table_row', text: 'No.1 MeOH TK', metadata: {}, location: { partIndex: 0 } },
        { id: 'block-1', globalOrder: 1, partOrder: 1, type: 'table_row', text: 'Tank Pressure', metadata: {}, location: { partIndex: 0 } },
        { id: 'block-2', globalOrder: 2, partOrder: 2, type: 'table_row', text: 'Tank Volume', metadata: {}, location: { partIndex: 0 } },
        { id: 'block-3', globalOrder: 3, partOrder: 3, type: 'table_row', text: 'Tank LV (Level)', metadata: {}, location: { partIndex: 0 } },
        { id: 'block-4', globalOrder: 4, partOrder: 4, type: 'table_row', text: 'Tank Temp', metadata: {}, location: { partIndex: 0 } },
      ] }, globalContext: {},
    });
    const output = {
      documentTitle: 'MeOH TK Checklist',
      sections: [{ sectionKey: 'meoh_tk_1', title: 'No.1 MeOH TK', sourceOrder: 0, evidenceRefs: ['block-0'] }],
      fields: [
        { fieldKey: 'tank_pressure', label: 'Tank Pressure', fieldType: 'number', required: false, sectionKey: 'meoh_tk_1', sourceOrder: 1, options: [], sourceText: 'Tank Pressure', evidenceRefs: ['block-1'], confidence: 0.9, warning: '' },
        { fieldKey: 'tank_volume', label: 'Tank Volume', fieldType: 'number', required: false, sectionKey: 'meoh_tk_1', sourceOrder: 2, options: [], sourceText: 'Tank Volume', evidenceRefs: ['block-2'], confidence: 0.9, warning: '' },
        { fieldKey: 'tank_level', label: 'Tank LV (Level)', fieldType: 'number', required: false, sectionKey: 'meoh_tk_1', sourceOrder: 3, options: [], sourceText: 'Tank LV (Level)', evidenceRefs: ['block-3'], confidence: 0.9, warning: '' },
        { fieldKey: 'tank_temp', label: 'Tank Temp', fieldType: 'number', required: false, sectionKey: 'meoh_tk_1', sourceOrder: 4, options: [], sourceText: 'Tank Temp', evidenceRefs: ['block-4'], confidence: 0.9, warning: '' },
      ],
      classifications: [
        { blockId: 'block-0', classification: 'section', reason: 'Section header' },
        { blockId: 'block-1', classification: 'field', reason: 'Measurement value' },
        { blockId: 'block-2', classification: 'field', reason: 'Measurement value' },
        { blockId: 'block-3', classification: 'field', reason: 'Measurement value' },
        { blockId: 'block-4', classification: 'field', reason: 'Measurement value' },
      ],
      notes: [], referenceData: [], warnings: [], unmappedBlocks: [],
    };
    const mockClient = makeMockGeminiClient(output);
    const result = await analyseTemplate(
      { mode: 'map', sourceType: 'docx', documentTitle: 'MeOH TK Checklist', chunk: normalized.chunk, globalContext: {} },
      { env: baseEnv, geminiClient: mockClient },
    );
    assert.ok(result.fields.length >= 4, `Expected at least 4 fields, got ${result.fields.length}`);
  });

  test('repeated fields under different sections survive', async () => {
    const normalized = normalizeAnalysisInput({
      mode: 'map', sourceType: 'pdf', documentTitle: 'Tank Inspection',
      chunk: { id: 'chunk-0', index: 0, blocks: [
        { id: 'block-0', globalOrder: 0, partOrder: 0, type: 'paragraph', text: 'No.1 MeOH TK', metadata: {}, location: { partIndex: 0 } },
        { id: 'block-1', globalOrder: 1, partOrder: 1, type: 'table_row', text: 'Tank Pressure', metadata: {}, location: { partIndex: 0 } },
        { id: 'block-2', globalOrder: 2, partOrder: 2, type: 'paragraph', text: 'No.2 MeOH TK', metadata: {}, location: { partIndex: 0 } },
        { id: 'block-3', globalOrder: 3, partOrder: 3, type: 'table_row', text: 'Tank Pressure', metadata: {}, location: { partIndex: 0 } },
      ] }, globalContext: {},
    });
    const output = {
      documentTitle: 'Tank Inspection',
      sections: [
        { sectionKey: 'tank_1', title: 'No.1 MeOH TK', sourceOrder: 0, evidenceRefs: ['block-0'] },
        { sectionKey: 'tank_2', title: 'No.2 MeOH TK', sourceOrder: 2, evidenceRefs: ['block-2'] },
      ],
      fields: [
        { fieldKey: 'tank_1_pressure', label: 'Tank Pressure', fieldType: 'number', required: false, sectionKey: 'tank_1', sourceOrder: 1, options: [], sourceText: 'Tank Pressure', evidenceRefs: ['block-1'], confidence: 0.9, warning: '' },
        { fieldKey: 'tank_2_pressure', label: 'Tank Pressure', fieldType: 'number', required: false, sectionKey: 'tank_2', sourceOrder: 3, options: [], sourceText: 'Tank Pressure', evidenceRefs: ['block-3'], confidence: 0.9, warning: '' },
      ],
      classifications: [
        { blockId: 'block-0', classification: 'section', reason: 'Header' },
        { blockId: 'block-1', classification: 'field', reason: 'Value' },
        { blockId: 'block-2', classification: 'section', reason: 'Header' },
        { blockId: 'block-3', classification: 'field', reason: 'Value' },
      ],
      notes: [], referenceData: [], warnings: [], unmappedBlocks: [],
    };
    const mockClient = makeMockGeminiClient(output);
    const result = await analyseTemplate(
      { mode: 'map', sourceType: 'pdf', documentTitle: 'Tank Inspection', chunk: normalized.chunk, globalContext: {} },
      { env: baseEnv, geminiClient: mockClient },
    );
    assert.equal(result.fields.length, 2, 'Both Tank Pressure fields under different sections must survive');
    const keys = result.fields.map(f => f.fieldKey);
    assert.notEqual(keys[0], keys[1], 'Field keys must be unique');
  });

  test('provenance-only labels remain rejected', () => {
    const blocks = [{ id: 'block-0', globalOrder: 0, text: 'Real data', location: {} }];
    const output = {
      sections: [{ sectionKey: 'block-0', title: 'block-0', sourceOrder: 0, evidenceRefs: ['block-0'] }],
      fields: [{ fieldKey: 'cell_a1', label: 'A1:B2', fieldType: 'text', required: false, sectionKey: 'general', sourceOrder: 0, options: [], evidenceRefs: ['block-0'], confidence: 0.5 }],
      warnings: [],
    };
    const result = validateMapping(output, blocks);
    assert.equal(result.fields.length, 0, 'Provenance-only label must be rejected');
  });

  test('local fallback does not overwrite AI fields', async () => {
    const normalized = makeNormalized();
    const output = makeGeminiOutput();
    const mockClient = makeMockGeminiClient(output);
    const result = await analyseTemplate(
      { mode: 'map', sourceType: 'pdf', documentTitle: 'Test', chunk: { id: 'chunk-0', index: 0, blocks: normalized.chunk.blocks }, globalContext: {} },
      { env: baseEnv, geminiClient: mockClient },
    );
    assert.ok(result.fields.length > 0, 'AI fields must be present');
    assert.equal(result.providerUsed, 'gemini');
    assert.equal(result.fallbackUsed, false);
  });
});

describe('System prompt includes document purpose reasoning', () => {
  test('map mode prompt includes document purpose preamble', async () => {
    const normalized = makeNormalized();
    let capturedPrompt = '';
    const mockClient = {
      models: {
        generateContent: async (params) => {
          capturedPrompt = params.config?.systemInstruction || '';
          return { text: JSON.stringify(makeGeminiOutput()) };
        },
      },
    };
    await analyseWithGemini(normalized, { env: baseEnv, geminiClient: mockClient });
    assert.ok(capturedPrompt.includes("document's primary purpose"), 'Prompt must include document purpose reasoning');
    assert.ok(capturedPrompt.includes('index or reference document'), 'Prompt must mention index documents');
    assert.ok(capturedPrompt.includes('Instruction sentences'), 'Prompt must warn about instruction sentences');
    assert.ok(capturedPrompt.includes('signature fields'), 'Prompt must mention signature fields');
    assert.ok(capturedPrompt.includes('textarea fields'), 'Prompt must mention textarea fields');
  });

  test('context mode prompt does NOT include purpose preamble', async () => {
    const contextInput = normalizeAnalysisInput({
      mode: 'context', sourceType: 'pdf', documentTitle: 'Test',
      chunk: { id: 'chunk-0', index: 0, blocks: [
        { id: 'block-0', globalOrder: 0, partOrder: 0, type: 'paragraph', text: 'Test content', metadata: {}, location: { partIndex: 0 } },
      ] }, globalContext: {},
    });
    let capturedPrompt = '';
    const output = { documentTitle: 'Test', outline: [], glossary: [], responseCodes: [], warnings: [] };
    const mockClient = {
      models: {
        generateContent: async (params) => {
          capturedPrompt = params.config?.systemInstruction || '';
          return { text: JSON.stringify(output) };
        },
      },
    };
    await analyseWithGemini(contextInput, { env: baseEnv, geminiClient: mockClient });
    assert.ok(!capturedPrompt.includes("document's primary purpose"), 'Context mode must not include purpose preamble');
  });
});
