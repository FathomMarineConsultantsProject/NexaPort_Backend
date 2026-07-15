const PREFIXES = {
  consultant_photo: "consultant-registrations/photos/",
  consultant_cv: "consultant-registrations/cvs/",
  client_verification_document: "client-verifications/",
};

export const enqueueS3Cleanup = async (queryable, objectKind, objectKey) => {
  if (!objectKey) return false;
  const prefix = PREFIXES[objectKind];
  if (!prefix || !String(objectKey).startsWith(prefix) || String(objectKey).includes("..")) {
    throw Object.assign(new Error("Database-owned S3 key has an invalid cleanup prefix"), { status: 409 });
  }
  await queryable.query(
    `
    INSERT INTO public.s3_cleanup_jobs (object_key, object_kind)
    VALUES ($1, $2)
    ON CONFLICT (object_key) DO NOTHING
    `,
    [objectKey, objectKind]
  );
  return true;
};
