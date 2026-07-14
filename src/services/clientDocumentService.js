import crypto from "crypto";
import jwt from "jsonwebtoken";
import { createPresignedPutUrl } from "../utils/s3Presign.js";

export const DOCUMENT_CATEGORIES = [
  "company_registration_certificate",
  "authorisation_letter",
  "company_identification_or_tax_certificate",
];

export const DOCUMENT_MIME_EXTENSIONS = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export const MAX_DOCUMENT_SIZE = 5 * 1024 * 1024;

export const validateDocumentInput = ({ category, contentType, size, originalFilename }) => {
  const byteSize = Number(size);
  if (!DOCUMENT_CATEGORIES.includes(category)) return "Invalid document category";
  if (!DOCUMENT_MIME_EXTENSIONS[contentType]) return "Invalid document type";
  if (!Number.isInteger(byteSize) || byteSize <= 0 || byteSize > MAX_DOCUMENT_SIZE) {
    return "Document must be 5 MB or less";
  }
  if (!String(originalFilename || "").trim() || String(originalFilename).length > 255) {
    return "A valid original filename is required";
  }
  return null;
};

export const createDocumentUpload = ({ ownerType, ownerId, category, contentType, size, originalFilename }) => {
  const extension = DOCUMENT_MIME_EXTENSIONS[contentType];
  const key = `client-verifications/${ownerType}/${ownerId}/${category}/${crypto.randomUUID()}.${extension}`;
  return {
    key,
    uploadUrl: createPresignedPutUrl({ key, contentType, expiresIn: 300 }),
    expiresIn: 300,
    metadata: {
      category,
      contentType,
      size: Number(size),
      originalFilename: String(originalFilename).trim(),
    },
  };
};

export const keyBelongsToOwner = ({ key, ownerType, ownerId, category, contentType }) => {
  const extension = DOCUMENT_MIME_EXTENSIONS[contentType];
  const prefix = `client-verifications/${ownerType}/${ownerId}/${category}/`;
  return Boolean(
    extension &&
      typeof key === "string" &&
      !key.includes("..") &&
      !key.includes("\\") &&
      key.startsWith(prefix) &&
      key.toLowerCase().endsWith(`.${extension}`)
  );
};

const documentTokenSecret = () => {
  const secret = process.env.CLIENT_REGISTRATION_TOKEN_SECRET;
  if (!secret) throw new Error("Client registration token service is not configured");
  return secret;
};

export const createDocumentConfirmationToken = (payload) =>
  jwt.sign({ ...payload, purpose: "client-document-confirmation" }, documentTokenSecret(), { expiresIn: "60m" });

export const verifyDocumentConfirmationToken = (token) => {
  const decoded = jwt.verify(token, documentTokenSecret());
  if (decoded.purpose !== "client-document-confirmation") throw new Error("Invalid document confirmation");
  return decoded;
};

export const publicDocument = (row) => ({
  id: row.id,
  document_category: row.document_category,
  original_filename: row.original_filename,
  mime_type: row.mime_type,
  size_bytes: row.size_bytes,
  is_current: row.is_current,
  uploaded_at: row.uploaded_at,
});
