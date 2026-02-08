import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY || "dummy_key");
const FROM_EMAIL = process.env.FROM_EMAIL || "VKart <onboarding@resend.dev>";

export async function sendEmail({ to, subject, html }) {
  if (!to) return;
  try {
    await resend.emails.send({ from: FROM_EMAIL, to, subject, html });
  } catch (err) {
    console.warn("Email send failed:", err?.message || err);
  }
}

export function emailTemplate({ title, body, ctaLabel, ctaUrl }) {
  return `
  <div style="font-family:Arial,sans-serif;background:#f6f7fb;padding:24px">
    <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #eef0f4">
      <div style="padding:20px 24px;background:#111;color:#fff;font-weight:bold;font-size:18px;letter-spacing:0.5px">
        VKart
      </div>
      <div style="padding:24px">
        <h2 style="margin:0 0 12px;color:#111">${title}</h2>
        <p style="color:#444;line-height:1.6;margin:0 0 16px">${body}</p>
        ${
          ctaUrl
            ? `<a href="${ctaUrl}" style="background:#111;color:#fff;text-decoration:none;padding:10px 16px;border-radius:10px;display:inline-block;font-weight:600">${ctaLabel ||
                "Open"}</a>`
            : ""
        }
      </div>
      <div style="padding:16px 24px;color:#777;font-size:12px;background:#fafbff;border-top:1px solid #eef0f4">
        Thanks for shopping with VKart.
      </div>
    </div>
  </div>
  `;
}
