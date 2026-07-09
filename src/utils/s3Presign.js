import crypto from "crypto";

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";

const hmac = (key, value, encoding) =>
  crypto.createHmac("sha256", key).update(value).digest(encoding);

const sha256Hex = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

const encodeRfc3986 = (value) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );

const getSigningKey = (secretAccessKey, dateStamp, region) => {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, SERVICE);
  return hmac(kService, "aws4_request");
};

export function getS3UploadConfig() {
  const region = process.env.AWS_REGION;
  const bucket = process.env.AWS_S3_BUCKET;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  if (!region || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error("S3 upload environment is not configured");
  }

  return { region, bucket, accessKeyId, secretAccessKey };
}

export function createPresignedPutUrl({
  key,
  contentType,
  expiresIn = 300,
}) {
  const { region, bucket, accessKeyId, secretAccessKey } = getS3UploadConfig();
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;
  const credential = `${accessKeyId}/${credentialScope}`;
  const host = `${bucket}.s3.${region}.amazonaws.com`;
  const canonicalUri = `/${key.split("/").map(encodeRfc3986).join("/")}`;
  const signedHeaders = "content-type;host";

  const queryParams = {
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": credential,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresIn),
    "X-Amz-SignedHeaders": signedHeaders,
  };

  const canonicalQueryString = Object.keys(queryParams)
    .sort()
    .map((name) => `${encodeRfc3986(name)}=${encodeRfc3986(queryParams[name])}`)
    .join("&");

  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\n`;
  const canonicalRequest = [
    "PUT",
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    ALGORITHM,
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = getSigningKey(secretAccessKey, dateStamp, region);
  const signature = hmac(signingKey, stringToSign, "hex");

  return `https://${host}${canonicalUri}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
}

export function createPresignedGetUrl({
  key,
  expiresInSeconds = 3600,
}) {
  const { region, bucket, accessKeyId, secretAccessKey } = getS3UploadConfig();
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;
  const credential = `${accessKeyId}/${credentialScope}`;
  const host = `${bucket}.s3.${region}.amazonaws.com`;
  const canonicalUri = `/${key.split("/").map(encodeRfc3986).join("/")}`;
  const signedHeaders = "host";

  const queryParams = {
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": credential,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresInSeconds),
    "X-Amz-SignedHeaders": signedHeaders,
  };

  const canonicalQueryString = Object.keys(queryParams)
    .sort()
    .map((name) => `${encodeRfc3986(name)}=${encodeRfc3986(queryParams[name])}`)
    .join("&");

  const canonicalHeaders = `host:${host}\n`;
  const canonicalRequest = [
    "GET",
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    ALGORITHM,
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = getSigningKey(secretAccessKey, dateStamp, region);
  const signature = hmac(signingKey, stringToSign, "hex");
  const url = `https://${host}${canonicalUri}?${canonicalQueryString}&X-Amz-Signature=${signature}`;

  return {
    url,
    expiresAt: new Date(now.getTime() + expiresInSeconds * 1000).toISOString(),
  };
}
