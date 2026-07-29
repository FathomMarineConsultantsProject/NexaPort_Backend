import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createPresignedGetUrl } from "../src/utils/s3Presign.js";

const source = (relativePath) =>
  readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

test("consultant detail preserves the registration, account, photo, CV, and collection contract", async () => {
  const controller = await source("src/controllers/expertController.js");
  const detail = controller.slice(
    controller.indexOf("const getExpertFullData"),
    controller.indexOf("const canAccessExpert")
  );

  assert.match(detail, /LEFT JOIN users u ON u\.id = e\.user_id/);
  assert.match(
    detail,
    /SELECT \* FROM expert_registration_details WHERE expert_id = \$1 LIMIT 1/
  );
  assert.match(detail, /registration_details: registrationRow \? safeRegistrationDetails : null/);
  assert.match(detail, /photo_url: photo\?\.url \|\| null/);
  assert.match(detail, /has_cv: Boolean\(cvS3Key\)/);
  for (const field of [
    "specialties",
    "certifications",
    "vessel_types",
    "languages",
    "ports",
    "flag_services",
  ]) {
    assert.match(detail, new RegExp(`${field}:`));
  }
  assert.doesNotMatch(detail, /registration_details: registrationRow[^]*photo_s3_key/);
});

test("consultant list keeps optional registration rows and signs photos", async () => {
  const controller = await source("src/controllers/expertController.js");
  const list = controller.slice(
    controller.indexOf("export const getAllExperts"),
    controller.indexOf("export const getExpertById")
  );

  assert.match(list, /LEFT JOIN expert_registration_details erd ON erd\.expert_id = e\.id/);
  assert.match(list, /erd\.company_name/);
  assert.match(list, /createPresignedGetUrl\(\{ key: photoS3Key \}\)/);
  assert.match(list, /photo_url: photo\?\.url \|\| null/);
  assert.match(list, /data: experts/);
});

test("profile updates persist registration fields and validated media keys", async () => {
  const controller = await source("src/controllers/expertController.js");
  const update = controller.slice(
    controller.indexOf("export const updateExpert ="),
    controller.indexOf("export const deleteExpert")
  );

  assert.match(update, /registration_details,/);
  assert.match(update, /photo_s3_key,/);
  assert.match(update, /cv_s3_key,/);
  assert.match(update, /validateExpertMediaKey\(photo_s3_key, "photo", id\)/);
  assert.match(update, /validateExpertMediaKey\(cv_s3_key, "cv", id\)/);
  assert.match(update, /UPDATE expert_registration_details/);
  assert.match(update, /await updateRegistrationDetails\(client, id, registration_details\)/);
  assert.match(update, /await validateCanonicalPorts\(client, ports\)/);
});

test("expert identity mapping remains user-owned while quotations remain expert-keyed", async () => {
  const [expert, quotation] = await Promise.all([
    source("src/controllers/expertController.js"),
    source("src/controllers/quotationController.js"),
  ]);

  assert.match(expert, /WHERE e\.user_id = \$1/);
  assert.match(expert, /Number\(expert\.user_id\) === Number\(user\.id\)/);
  assert.match(quotation, /WHERE user_id = \$1/);
  assert.match(quotation, /q\.expert_id = \$\$\{values\.length\}/);
  assert.match(quotation, /q\.expert_user_id = \$\$\{values\.length\}/);
  assert.match(quotation, /Number\(row\.expert_user_id\) === Number\(user\.id\)/);
});

test("quotation and maritime directory routes do not depend on expertController", async () => {
  const [quotationRoutes, directoryRoutes, quotationController] =
    await Promise.all([
      source("src/routes/quotationRoutes.js"),
      source("src/routes/maritimeDirectoryRoutes.js"),
      source("src/controllers/quotationController.js"),
    ]);

  assert.doesNotMatch(quotationRoutes, /expertController/);
  assert.doesNotMatch(directoryRoutes, /expertController/);
  assert.match(quotationController, /data: result\.rows\.map/);
  assert.match(quotationController, /count: result\.rows\.length/);
});

test("photo keys become short-lived S3 URLs without exposing the key", () => {
  const previous = {
    region: process.env.AWS_REGION,
    bucket: process.env.AWS_S3_BUCKET,
    accessKey: process.env.AWS_ACCESS_KEY_ID,
    secret: process.env.AWS_SECRET_ACCESS_KEY,
  };

  process.env.AWS_REGION = "ap-south-1";
  process.env.AWS_S3_BUCKET = "nexaport-test";
  process.env.AWS_ACCESS_KEY_ID = "test-access";
  process.env.AWS_SECRET_ACCESS_KEY = "test-secret";

  try {
    const signed = createPresignedGetUrl({
      key: "consultant-registrations/photos/7/example.img",
    });
    assert.match(
      signed.url,
      /^https:\/\/nexaport-test\.s3\.ap-south-1\.amazonaws\.com\/consultant-registrations\/photos\/7\/example\.img\?/
    );
    assert.match(signed.url, /X-Amz-Signature=/);
    assert.ok(Date.parse(signed.expiresAt) > Date.now());
  } finally {
    const restore = (name, value) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore("AWS_REGION", previous.region);
    restore("AWS_S3_BUCKET", previous.bucket);
    restore("AWS_ACCESS_KEY_ID", previous.accessKey);
    restore("AWS_SECRET_ACCESS_KEY", previous.secret);
  }
});
