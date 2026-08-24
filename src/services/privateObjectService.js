import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getS3UploadConfig } from "../utils/s3Presign.js";

let client;
const getClient = () => {
  if (client) return client;
  const { region, accessKeyId, secretAccessKey } = getS3UploadConfig();
  client = new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
  return client;
};

export const setPrivateObjectClientForTests = (value) => { client = value; };

const objectConfig = () => {
  const { bucket } = getS3UploadConfig();
  return { Bucket: bucket };
};

export async function readPrivateObject(key, maxBytes = 12 * 1024 * 1024) {
  const response = await getClient().send(new GetObjectCommand({ ...objectConfig(), Key: key }));
  const length = Number(response.ContentLength);
  if (length && length > maxBytes) throw new Error("Private source file exceeds the supported size.");
  if (!response.Body) throw new Error("Private source file could not be read.");
  const bytes = Buffer.from(await response.Body.transformToByteArray());
  if (bytes.length > maxBytes) throw new Error("Private source file exceeds the supported size.");
  return bytes;
}

export async function deletePrivateObject(key) {
  await getClient().send(new DeleteObjectCommand({ ...objectConfig(), Key: key }));
}

export async function writePrivateObject(key, contentType, bytes) {
  await getClient().send(new PutObjectCommand({ ...objectConfig(), Key: key, ContentType: contentType, Body: bytes }));
}
