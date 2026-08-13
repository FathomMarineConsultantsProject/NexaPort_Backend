import { parseOffice } from "officeparser";

const SUPPORTED_TYPES = new Set(["docx", "pdf"]);

export const documentParseFailure = (message, status = 422, cause = null) =>
  Object.assign(new Error(message), { status, code: "DOCUMENT_PARSE_FAILED", cause });

const plainJson = (value) => JSON.parse(JSON.stringify(value, (key, nested) => {
  if (["attachments", "rawContent"].includes(key) || typeof nested === "function") return undefined;
  return nested;
}));

function flattenContent(content = []) {
  const blocks = [];
  const visit = (nodes, parents = [], inheritedLocation = {}) => {
    for (const node of nodes || []) {
      if (!node || typeof node !== "object") continue;
      const metadata = node.metadata && typeof node.metadata === "object" ? node.metadata : {};
      const location = {
        ...inheritedLocation,
        ...(Number.isInteger(metadata.pageNumber) ? { pageNumber: metadata.pageNumber } : {}),
        ...(Number.isInteger(metadata.page) ? { pageNumber: metadata.page } : {}),
        ...(Number.isInteger(metadata.row) ? { rowIndex: metadata.row } : {}),
        ...(Number.isInteger(metadata.col) ? { columnIndex: metadata.col } : {}),
      };
      const text = String(node.text || "").replace(/\r\n?/g, "\n").trim();
      if (text && node.type !== "text") {
        const globalOrder = blocks.length;
        blocks.push({
          id: `block-${globalOrder}`,
          globalOrder,
          partOrder: globalOrder,
          type: String(node.type || "unknown"),
          text,
          metadata: plainJson({ ...metadata, formatting: node.formatting || undefined, parentTypes: parents }),
          location: plainJson(location),
        });
      }
      const nextParents = [...parents, String(node.type || "unknown")];
      visit(node.children, nextParents, location);
      visit(node.notes, [...nextParents, "notes"], location);
      visit(node.comments, [...nextParents, "comments"], location);
    }
  };
  visit(content);
  return blocks;
}

export async function parseDocumentToJson(file, { sourceType, signal, parser = parseOffice } = {}) {
  const type = String(sourceType || "").toLowerCase();
  if (!SUPPORTED_TYPES.has(type)) throw documentParseFailure("Only DOCX and PDF documents can be analysed.", 400);
  if (!file?.buffer?.length) throw documentParseFailure("A document file is required.", 400);
  try {
    const ast = await parser(file.buffer, {
      fileType: type,
      extractAttachments: false,
      includeRawContent: false,
      abortSignal: signal,
    });
    const structure = plainJson(ast);
    const blocks = flattenContent(structure.content);
    if (!blocks.length) throw documentParseFailure("The uploaded document contains no readable structured content.");
    return {
      fileName: String(file.originalname || `document.${type}`),
      fileType: type,
      mimeType: String(file.mimetype || ""),
      metadata: structure.metadata || {},
      content: structure.content || [],
      auxiliary: structure.auxiliary || {},
      blocks,
      parser: { package: "officeparser", sourceFormat: structure.type || type },
    };
  } catch (error) {
    if (error?.code === "DOCUMENT_PARSE_FAILED" || error?.name === "AbortError") throw error;
    throw documentParseFailure("The uploaded document could not be converted to structured JSON.", 422, error);
  }
}

export const supportedDocumentTypes = SUPPORTED_TYPES;
