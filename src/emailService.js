const nodemailer = require('nodemailer');

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
const isConfigured = !!(SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS);

let transporter = null;
if (isConfigured) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

// Fire-and-forget email send. Silently does nothing if SMTP isn't configured
// in .env, so the app never breaks or blocks on missing email credentials —
// same fallback pattern used for the Gemini AI features.
async function sendNotificationEmail(toEmail, toName, text) {
  if (!isConfigured || !toEmail) return;

  try {
    await transporter.sendMail({
      from: SMTP_FROM || SMTP_USER,
      to: toEmail,
      subject: 'Smart AI Bug Tracker — new notification',
      text: `Hi ${toName || ''},\n\n${text}\n\nOpen the app to view details.`,
      html: `<p>Hi ${toName || ''},</p><p>${text}</p><p>Open the app to view details.</p>`,
    });
  } catch (err) {
    console.error('Failed to send notification email:', err.message);
  }
}

module.exports = { sendNotificationEmail, isEmailConfigured: isConfigured };
