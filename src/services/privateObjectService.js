import { createPresignedDeleteUrl, createPresignedGetUrl, createPresignedPutUrl } from "../utils/s3Presign.js";

export async function readPrivateObject(key, maxBytes = 12 * 1024 * 1024) {
  const { url } = createPresignedGetUrl({ key, expiresInSeconds: 120 });
  const response = await fetch(url);
  if (!response.ok) throw new Error("Private source file could not be read.");
  const length = Number(response.headers.get("content-length"));
  if (length && length > maxBytes) throw new Error("Private source file exceeds the supported size.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error("Private source file exceeds the supported size.");
  return bytes;
}

export async function deletePrivateObject(key) {
  const response = await fetch(createPresignedDeleteUrl({ key } ), { method: "DELETE" });
  if (!response.ok && response.status !== 404) throw new Error("Temporary source file could not be deleted.");
}

export async function writePrivateObject(key, contentType, bytes) {
  const uploadUrl = createPresignedPutUrl({ key, contentType, expiresIn: 120 });
  const response = await fetch(uploadUrl, { method: "PUT", headers: { "content-type": contentType }, body: bytes });
  if (!response.ok) throw new Error("Generated report could not be stored.");
}
