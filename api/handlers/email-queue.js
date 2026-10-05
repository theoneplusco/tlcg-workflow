// api/handlers/email-queue.js — Decoupled email queue
// Approval handlers insert rows here; a background worker sends them via Resend.
// The approver sees "Approved ✓" in <50ms — email sends in the background.
import pool from '../../db/pool.js';

/**
 * Queue one or more emails for background sending.
 * Called from approval/submit handlers — never blocks the response.
 */
export async function queueEmail(toEmail, subject, bodyHtml = '', bodyText = '') {
  if (!toEmail || !subject) return;
  try {
    await pool.query(
      `INSERT INTO email_queue (to_email, subject, body_html, body_text, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [toEmail, subject, bodyHtml, bodyText]
    );
  } catch (err) {
    console.error('[EmailQueue] Failed to queue email (non-fatal):', err.message);
  }
}

/**
 * Queue multiple emails at once.
 */
export async function queueEmails(emails) {
  for (const email of emails) {
    await queueEmail(email.to, email.subject, email.html, email.text);
  }
}

/**
 * Background worker — processes the email queue every 5 seconds.
 * Uses SELECT FOR UPDATE SKIP LOCKED so multiple PM2 workers don't conflict.
 * Called from server.js on startup.
 */
export async function processEmailQueue() {
  const client = await pool.connect();
  try {
    // Claim up to 10 pending emails atomically
    const claim = await client.query(
      `UPDATE email_queue
       SET status = 'sending', attempts = attempts + 1
       WHERE id IN (
         SELECT id FROM email_queue
         WHERE status = 'pending'
         LIMIT 10
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`
    );

    for (const email of claim.rows) {
      try {
        await sendViaResend(email);
        await client.query(
          `UPDATE email_queue SET status = 'sent', sent_at = NOW() WHERE id = $1`,
          [email.id]
        );
      } catch (err) {
        const failed = email.attempts >= 3;
        await client.query(
          `UPDATE email_queue SET status = $1, error = $2 WHERE id = $3`,
          [failed ? 'failed' : 'pending', err.message.slice(0, 500), email.id]
        );
        console.error(`[EmailQueue] Send failed (${email.to_email}):`, err.message);
      }
    }
  } catch (err) {
    console.error('[EmailQueue] Worker error:', err.message);
  } finally {
    client.release();
  }
}

/** Send immediately (OTP / time-sensitive). Falls back to the queue on failure. */
export async function sendEmailNow(toEmail, subject, bodyHtml = '', bodyText = '') {
  if (!toEmail || !subject) return false;
  try {
    await sendViaResend({ to_email: toEmail, subject, body_html: bodyHtml, body_text: bodyText });
    return true;
  } catch (err) {
    console.error('[EmailQueue] Immediate send failed, queueing:', err.message);
    await queueEmail(toEmail, subject, bodyHtml, bodyText);
    return false;
  }
}

async function sendViaResend(email) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY not set');

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || 'TLC Group Workflow <noreply@tl-c.us>',
      to: [email.to_email],
      subject: email.subject,
      html: email.body_html,
      text: email.body_text || '',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Resend API ${response.status}: ${text}`);
  }
}

/**
 * Start the background email worker.
 * Runs in every PM2 worker — SKIP LOCKED prevents conflicts.
 */
let workerInterval = null;

export function startEmailWorker() {
  if (workerInterval) return;
  workerInterval = setInterval(processEmailQueue, 5000);
  console.log('[EmailQueue] Background worker started (5s interval)');
}
