import nodemailer from "nodemailer";

console.log("SMTP_HOST:", process.env.SMTP_HOST);
console.log("SMTP_PORT:", process.env.SMTP_PORT);
console.log("SMTP_USER:", process.env.SMTP_USER);
console.log("SMTP_FROM_EMAIL:", process.env.SMTP_FROM_EMAIL);
console.log("SMTP_PASSWORD Exists:", !!process.env.SMTP_PASSWORD);
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE).toLowerCase() === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD,
  },
});

export const sendPasswordResetOtp = async ({
  email,
  fullName,
  otp,
}) => {
  const expiryMinutes = Number(
    process.env.PASSWORD_RESET_OTP_EXPIRY_MINUTES || 10
  );

  await transporter.sendMail({
    from: {
      name: process.env.SMTP_FROM_NAME || "NexaPort",
      address:
        process.env.SMTP_FROM_EMAIL ||
        process.env.SMTP_USER,
    },

    to: email,

    subject: "NexaPort Password Reset OTP",

    text: `
Hello ${fullName || "User"},

Your NexaPort password reset OTP is ${otp}.

This OTP expires in ${expiryMinutes} minutes.

If you did not request a password reset, ignore this email.

NexaPort Team
    `.trim(),

    html: `
      <div style="font-family: Arial, sans-serif; max-width: 550px; margin: auto;">
        <h2>NexaPort Password Reset</h2>

        <p>Hello ${fullName || "User"},</p>

        <p>Your password reset OTP is:</p>

        <div style="
          font-size: 30px;
          font-weight: bold;
          letter-spacing: 8px;
          padding: 18px;
          background: #f2f4f7;
          text-align: center;
          border-radius: 8px;
        ">
          ${otp}
        </div>

        <p>
          This OTP will expire in
          <strong>${expiryMinutes} minutes</strong>.
        </p>

        <p>
          If you did not request this password reset, ignore this email.
        </p>

        <p>NexaPort Team</p>
      </div>
    `,
  });
};