import crypto from "crypto";

export const generateOtp = () => {
  return crypto.randomInt(100000, 1000000).toString();
};

export const hashOtp = (otp) => {
  return crypto
    .createHash("sha256")
    .update(String(otp))
    .digest("hex");
};

export const verifyOtpHash = (otp, storedHash) => {
  const enteredHash = hashOtp(otp);

  const enteredBuffer = Buffer.from(enteredHash, "hex");
  const storedBuffer = Buffer.from(storedHash, "hex");

  if (enteredBuffer.length !== storedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    enteredBuffer,
    storedBuffer
  );
};