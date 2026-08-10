import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';
import { normalizeMappingEvidence, mapFieldsWithOpenRouter } from '../src/services/openRouterTemplateService.js';

const source = async (file) => readFile(new URL(file, import.meta.url), "utf8");
const env = { OPENROUTER_API_KEY: "test", OPENROUTER_TEMPLATE_MODEL: "test/model" };

describe('Extraction Quality Tests - Backend', () => {
    test('Structured metadata passes through normalization', () => {
        const input = {
            documentTitle: 'Test Document',
            sourceType: 'xlsx',
            pagesOrSheets: [{ name: 'Sheet 1', lines: [
                { text: 'Hull condition Good Fair Poor', blockType: 'checklist_row', sheetIndex: 0, rowIndex: 1, isHeading: false, isInstruction: false, cells: ['Hull condition', 'Good', 'Fair', 'Poor'] }
            ]}]
        };
        const normalized = normalizeMappingEvidence(input);
        const line = normalized.pagesOrSheets[0].lines[0];

        assert.equal(line.text, 'Hull condition Good Fair Poor');
        assert.equal(line.blockType, 'checklist_row');
        assert.equal(line.sheetIndex, 0);
        assert.equal(line.rowIndex, 1);
        assert.equal(line.isHeading, false);
        assert.equal(line.isInstruction, false);
        assert.ok(Array.isArray(line.cells));
    });

    test('System prompt includes XLSX/DOCX instructions', async () => {
        const code = await source('../src/services/openRouterTemplateService.js');
        assert.ok(code.includes('cell coordinate labels'), 'missing coordinate labels instruction');
        assert.ok(code.includes('abbreviation'), 'missing abbreviation instruction');
        assert.ok(code.includes('instructional'), 'missing instructional instruction');
        assert.ok(code.includes('concatenate'), 'missing concatenate instruction');
        assert.ok(code.includes('date serial'), 'missing date serial instruction');
        assert.ok(code.includes('textarea'), 'missing textarea instruction');
    });

    test('Evidence validation still rejects forbidden keys', () => {
        assert.throws(
            () => normalizeMappingEvidence({ documentTitle: 'Test', sourceType: 'pdf', pagesOrSheets: [{ name: 'Page 1', lines: [{ text: 'Valid' }] }], bytes: [1, 2] }),
            /bytes and files/
        );
        assert.throws(
            () => normalizeMappingEvidence({ documentTitle: 'Test', sourceType: 'pdf', pagesOrSheets: [{ name: 'Page 1', lines: [{ text: 'Valid' }] }], base64: 'AA==' }),
            /bytes and files/
        );
    });

    test('AI mapping with structured metadata works end-to-end', async () => {
        const input = {
            documentTitle: 'Test Document',
            sourceType: 'xlsx',
            pagesOrSheets: [{ name: 'Sheet 1', lines: [
                { text: 'Hull condition Good Fair Poor', blockType: 'checklist_row', cells: ['Hull condition', 'Good', 'Fair', 'Poor'] }
            ]}]
        };

        const mappedOutput = {
            sections: [{ sectionKey: 'inspection', title: 'Inspection', sortOrder: 1 }],
            fields: [{ fieldKey: 'hull_condition', label: 'Hull condition', fieldType: 'select', required: false, sectionKey: 'inspection', sortOrder: 1, options: ['Good', 'Fair', 'Poor'], sourceText: 'Hull condition Good Fair Poor' }]
        };

        let requestBody;
        const fetchImpl = async (_url, options) => {
            requestBody = JSON.parse(options.body);
            return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(mappedOutput) } }] }) };
        };

        const result = await mapFieldsWithOpenRouter(input, { fetchImpl, env });
        assert.equal(result.sections.length, 1);
        assert.equal(result.fields.length, 1);
        assert.equal(result.fields[0].fieldType, 'select');
        // Verify structured metadata was sent in the evidence
        const sent = JSON.parse(requestBody.messages[1].content);
        assert.equal(sent.pagesOrSheets[0].lines[0].blockType, 'checklist_row');
    });

    test('Mocked mapping preserves field sourceText evidence', async () => {
        const input = {
            documentTitle: 'Dock Check',
            sourceType: 'pdf',
            pagesOrSheets: [{ name: 'Page 1', lines: [{ text: 'Decking in good condition? Yes No' }] }]
        };

        const mappedOutput = {
            sections: [{ sectionKey: 'dock', title: 'Dock', sortOrder: 1 }],
            fields: [{ fieldKey: 'decking_good', label: 'Decking in good condition?', fieldType: 'yes_no', required: false, sectionKey: 'dock', sortOrder: 1, options: ['Yes', 'No'], sourceText: 'Decking in good condition? Yes No' }]
        };

        const result = await mapFieldsWithOpenRouter(input, {
            fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(mappedOutput) } }] }) }),
            env
        });
        assert.equal(result.fields[0].sourceText, 'Decking in good condition? Yes No');
    });

    test('drops an ungrounded AI field without losing grounded fields', async () => {
        const input = { documentTitle: 'Checklist', sourceType: 'docx', pagesOrSheets: [{ name: 'Document', lines: [{ text: 'Are emergency fire pumps operable? Yes No', order: 4, blockType: 'checklist_row', tableIndex: 0, rowIndex: 2 }] }] };
        const output = { sections: [{ sectionKey: 'part_b2', title: 'Part B2', sortOrder: 99 }], fields: [
            { fieldKey: 'fire_pumps', label: 'Are emergency fire pumps operable?', fieldType: 'yes_no', required: false, sectionKey: 'part_b2', sortOrder: 99, options: ['Yes', 'No'], sourceText: 'Are emergency fire pumps operable? Yes No', sourceBlockOrder: 4, tableIndex: 0, rowIndex: 2 },
            { fieldKey: 'invented', label: 'Invented field', fieldType: 'text', required: false, sectionKey: 'part_b2', sortOrder: 0, options: [], sourceText: 'not present' }
        ] };
        const result = await mapFieldsWithOpenRouter(input, { fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(output) } }] }) }), env });
        assert.deepEqual(result.fields.map((field) => field.fieldKey), ['fire_pumps']);
        assert.equal(result.fields[0].sourceBlockOrder, 4);
    });

    test('Large PDF limit message test', async () => {
        const code = await source('../../NexaPort_Frontend/src/pages/TemplateEditorPage.jsx').catch(() => '');
        if (code) {
            assert.ok(code.toLowerCase().includes('limit') || code.toLowerCase().includes('pages'), 'page limit should be documented');
        }
    });

    test('normalizeMappingEvidence requires sourceType', () => {
        assert.throws(
            () => normalizeMappingEvidence({ documentTitle: 'Test', pagesOrSheets: [{ name: 'Page 1', lines: [{ text: 'Valid' }] }] }),
            /Source type/
        );
    });

    test('normalizeMappingEvidence requires pagesOrSheets', () => {
        assert.throws(
            () => normalizeMappingEvidence({ documentTitle: 'Test', sourceType: 'pdf' }),
            /evidence/
        );
    });
});
