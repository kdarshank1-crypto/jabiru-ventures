/**
 * Jabiru Ventures — Booking Reminders
 * Task 4: Booking Confirmation + Daily Reminders
 *
 * This Supabase Edge Function handles two triggers:
 *
 * Trigger A — POST /booking-confirmation
 * Called when a job status changes to "Booked"
 * Sends WhatsApp confirmation to client
 *
 * Trigger B — POST /daily-reminders
 * Called by a daily cron job at 9am
 * Sends WhatsApp reminders for tomorrow's inspections
 * Sends full day schedule to owner
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// ── ENV VARIABLES ─────────────────────────────────────────────────────────────
const SB_URL = Deno.env.get("SB_URL")!;
const SB_SERVICE_ROLE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY")!;
const WHATSAPP_TOKEN = Deno.env.get("WHATSAPP_TOKEN")!;
const WHATSAPP_PHONE_NUMBER_ID = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")!;
const OWNER_WHATSAPP = Deno.env.get("OWNER_WHATSAPP")!;

// ── HELPERS ───────────────────────────────────────────────────────────────────

/**
 * Format a date string to DD/MM/YYYY (Malaysian format)
 */
function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}

/**
 * Get tomorrow's date in YYYY-MM-DD format for Supabase query
 */
function getTomorrowDate(): string {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow.toISOString().split("T")[0];
}

/**
 * Send a WhatsApp text message via Cloud API
 */
async function sendWhatsApp(to: string, message: string): Promise<void> {
  const res = await fetch(
    `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: to,
        type: "text",
        text: { body: message },
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`WhatsApp send failed to ${to}: ${err}`);
  }
}

/**
 * Fetch full job details including customer and property
 * Returns null if job not found
 */
async function fetchJobDetails(jobId: string): Promise<any> {
  const res = await fetch(
    `${SB_URL}/rest/v1/jobs?id=eq.${jobId}&select=*,customers(*),properties(*)&limit=1`,
    {
      headers: {
        apikey: SB_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SB_SERVICE_ROLE_KEY}`,
      },
    }
  );

  if (!res.ok) throw new Error("Failed to fetch job details");

  const rows = await res.json();
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Fetch all jobs scheduled for tomorrow
 * Returns array of job objects with customer and property data
 */
async function fetchTomorrowJobs(): Promise<any[]> {
  const tomorrow = getTomorrowDate();

  const res = await fetch(
    `${SB_URL}/rest/v1/jobs?inspection_date=eq.${tomorrow}&status=eq.Booked&select=*,customers(*),properties(*)`,
    {
      headers: {
        apikey: SB_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SB_SERVICE_ROLE_KEY}`,
      },
    }
  );

  if (!res.ok) throw new Error("Failed to fetch tomorrow's jobs");

  return await res.json();
}

// ── TRIGGER A: BOOKING CONFIRMATION ──────────────────────────────────────────

/**
 * Send booking confirmation WhatsApp to client
 * Called when job status changes to "Booked"
 *
 * Expected POST body:
 * { "job_id": "uuid-of-the-job" }
 */
async function handleBookingConfirmation(body: any): Promise<Response> {
  const { job_id } = body;

  if (!job_id) {
    return new Response(
      JSON.stringify({ error: "job_id is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Fetch full job details
  let job: any;
  try {
    job = await fetchJobDetails(job_id);
    if (!job) {
      return new Response(
        JSON.stringify({ error: "Job not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }
  } catch (err) {
    console.error("[Jabiru] ❌ Failed to fetch job:", err);
    return new Response(
      JSON.stringify({ error: "Failed to fetch job details" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const customer = job.customers;
  const property = job.properties;

  const clientName = customer?.full_name || "Valued Customer";
  const clientPhone = customer?.phone;
  const address = property?.address || "To be confirmed";
  const city = property?.city || "";
  const inspectionDate = job.inspection_date
    ? formatDate(job.inspection_date)
    : "To be confirmed";
  const invoiceNo = job.invoice_no;

  // ── Send confirmation to client ──────────────────────────────────────────
  if (clientPhone) {
    const clientMessage =
      `Hi ${clientName}, your inspection is confirmed! 🏠\n\n` +
      `📅 Date: ${inspectionDate}\n` +
      `📍 Property: ${address}${city ? ", " + city : ""}\n` +
      `🔖 Reference: ${invoiceNo}\n\n` +
      `Please ensure access to the property is available on the day. ` +
      `If you need to reschedule, please contact us as soon as possible.\n\n` +
      `— Jabiru Ventures`;

    try {
      await sendWhatsApp(clientPhone, clientMessage);
      console.log(`[Jabiru] ✅ Booking confirmation sent to client ${clientPhone}`);
    } catch (err) {
      console.error("[Jabiru] ❌ Failed to send client confirmation:", err);
    }
  } else {
    console.warn("[Jabiru] ⚠️ No client phone number found for job:", job_id);
  }

  // ── Send notification to owner ───────────────────────────────────────────
  const ownerMessage =
    `📋 Booking confirmed!\n\n` +
    `👤 Client: ${clientName}\n` +
    `📞 Phone: ${clientPhone || "N/A"}\n` +
    `📅 Date: ${inspectionDate}\n` +
    `📍 Property: ${address}${city ? ", " + city : ""}\n` +
    `🏠 Type: ${property?.property_type || "N/A"}\n` +
    `🔖 Ref: ${invoiceNo}`;

  try {
    await sendWhatsApp(OWNER_WHATSAPP, ownerMessage);
    console.log("[Jabiru] ✅ Owner notified of booking");
  } catch (err) {
    console.error("[Jabiru] ❌ Failed to notify owner:", err);
  }

  return new Response(
    JSON.stringify({ success: true, message: "Booking confirmation sent" }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

// ── TRIGGER B: DAILY REMINDERS ────────────────────────────────────────────────

/**
 * Send reminders for all jobs scheduled for tomorrow
 * Called by daily cron job at 9am
 *
 * No body required — just POST to /booking-reminders/daily-reminders
 */
async function handleDailyReminders(): Promise<Response> {
  let jobs: any[];

  try {
    jobs = await fetchTomorrowJobs();
    console.log(`[Jabiru] 📅 Found ${jobs.length} job(s) for tomorrow`);
  } catch (err) {
    console.error("[Jabiru] ❌ Failed to fetch tomorrow's jobs:", err);
    return new Response(
      JSON.stringify({ error: "Failed to fetch jobs" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  if (jobs.length === 0) {
    console.log("[Jabiru] ✅ No jobs tomorrow — no reminders needed");
    return new Response(
      JSON.stringify({ success: true, message: "No jobs tomorrow" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  // ── Send reminder to each client ─────────────────────────────────────────
  for (const job of jobs) {
    const customer = job.customers;
    const property = job.properties;

    const clientName = customer?.full_name || "Valued Customer";
    const clientPhone = customer?.phone;
    const address = property?.address || "To be confirmed";
    const city = property?.city || "";
    const inspectionDate = job.inspection_date
      ? formatDate(job.inspection_date)
      : "tomorrow";
    const invoiceNo = job.invoice_no;

    if (!clientPhone) {
      console.warn("[Jabiru] ⚠️ No phone for job:", job.id);
      continue;
    }

    const clientReminder =
      `Hi ${clientName}! 👋\n\n` +
      `This is a reminder that your Jabiru Ventures inspection is ` +
      `tomorrow, ${inspectionDate}.\n\n` +
      `📍 Property: ${address}${city ? ", " + city : ""}\n` +
      `🔖 Reference: ${invoiceNo}\n\n` +
      `Please ensure access is available. ` +
      `Questions? Reply to this message.\n\n` +
      `— Jabiru Ventures`;

    try {
      await sendWhatsApp(clientPhone, clientReminder);
      console.log(`[Jabiru] ✅ Reminder sent to ${clientPhone}`);
    } catch (err) {
      console.error(`[Jabiru] ❌ Failed to send reminder to ${clientPhone}:`, err);
    }
  }

  // ── Send full day schedule to owner ──────────────────────────────────────
  const tomorrow = getTomorrowDate();
  const tomorrowFormatted = formatDate(tomorrow);

  let scheduleMessage = `📅 Tomorrow's Schedule — ${tomorrowFormatted}\n`;
  scheduleMessage += `Total inspections: ${jobs.length}\n\n`;

  jobs.forEach((job: any, index: number) => {
    const customer = job.customers;
    const property = job.properties;

    scheduleMessage +=
      `${index + 1}. ${customer?.full_name || "Unknown"}\n` +
      `   📞 ${customer?.phone || "N/A"}\n` +
      `   📍 ${property?.address || "N/A"}${property?.city ? ", " + property.city : ""}\n` +
      `   🏠 ${property?.property_type || "N/A"}\n` +
      `   🔖 ${job.invoice_no}\n\n`;
  });

  scheduleMessage += `— Jabiru Ventures System`;

  try {
    await sendWhatsApp(OWNER_WHATSAPP, scheduleMessage);
    console.log("[Jabiru] ✅ Daily schedule sent to owner");
  } catch (err) {
    console.error("[Jabiru] ❌ Failed to send schedule to owner:", err);
  }

  return new Response(
    JSON.stringify({
      success: true,
      message: `Reminders sent for ${jobs.length} job(s)`,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const url = new URL(req.url);
  const path = url.pathname;

  // Route: /booking-reminders (booking confirmation)
  if (path.endsWith("booking-reminders") || path.endsWith("booking-confirmation")) {
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    return await handleBookingConfirmation(body);
  }

  // Route: /booking-reminders/daily-reminders (cron job)
  if (path.endsWith("daily-reminders")) {
    return await handleDailyReminders();
  }

  return new Response("Not found", { status: 404 });
});