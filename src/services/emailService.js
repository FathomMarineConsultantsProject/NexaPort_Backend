import nodemailer from "nodemailer";

const requiredEmailEnv = [
  "EMAIL_FROM_NAME",
  "EMAIL_FROM_ADDRESS",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASSWORD",
];

const getTransport = () => {
  const missing = requiredEmailEnv.filter((name) => !process.env[name]);
  if ((process.env.EMAIL_PROVIDER || "smtp").toLowerCase() !== "smtp" || missing.length) {
    const error = new Error("Email delivery is not configured");
    error.code = "EMAIL_NOT_CONFIGURED";
    throw error;
  }

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: String(process.env.SMTP_SECURE).toLowerCase() === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    },
  });
};

export const sendClientRegistrationOtp = async ({ email, otp }) => {
  const transport = getTransport();
  await transport.sendMail({
    from: `"${process.env.EMAIL_FROM_NAME}" <${process.env.EMAIL_FROM_ADDRESS}>`,
    to: email,
    subject: "Verify your NexaPort client registration",
    text: `Your NexaPort verification code is ${otp}. It expires in 10 minutes.`,
    html: `<p>Your NexaPort verification code is <strong>${otp}</strong>.</p><p>It expires in 10 minutes. If you did not request this code, you can ignore this email.</p>`,
  });
};
