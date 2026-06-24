/**
 * Jabiru Ventures — WhatsApp Webhook
 * Task 2: WhatsApp Cloud API Integration
 *
 * This Supabase Edge Function:
 * 1. Verifies the webhook with Meta (GET request)
 * 2. Receives incoming WhatsApp messages (POST request)
 * 3. Passes message to Claude API to extract lead details
 * 4. Saves extracted lead to Supabase
 * 5. Sends auto-reply to lead via WhatsApp
 * 6. Sends notification to owner via WhatsApp
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// ── ENV VARIABLES ─────────────────────────────────────────────────────────────
const SB_URL = Deno.env.get("SB_URL")!;
const SB_SERVICE_ROLE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY")!;
const WHATSAPP_TOKEN = Deno.env.get("WHATSAPP_TOKEN")!;
const WHATSAPP_PHONE_NUMBER_ID = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")!;
const WHATSAPP_VERIFY_TOKEN = Deno.env.get("WHATSAPP_VERIFY_TOKEN")!;
const CLAUDE_API_KEY = Deno.env.get("CLAUDE_API_KEY")!;
const OWNER_WHATSAPP = Deno.env.get("OWNER_WHATSAPP")!;

// ── HELPERS ───────────────────────────────────────────────────────────────────

/**
 * Normalise Malaysian phone numbers to 60XXXXXXXXX format.
 */
function normalisePhone(raw: string): string {
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("60")) return digits;
  if (digits.startsWith("0")) return "60" + digits.slice(1);
  return "60" + digits;
}

/**
 * Generate the next invoice number in format JV-YYYY-XXXX.
 */
async function generateInvoiceNo(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `JV-${year}-`;

  const res = await fetch(
    `${SB_URL}/rest/v1/jobs?invoice_no=like.${prefix}*&select=invoice_no&order=invoice_no.desc&limit=1`,
    {
      headers: {
        apikey: SB_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SB_SERVICE_ROLE_KEY}`,
      },
    }
  );

  if (!res.ok) throw new Error("Failed to fetch latest invoice number");

  const rows = await res.json();

  if (rows.length === 0) return `${prefix}0001`;

  const lastNo = rows[0].invoice_no;
  const lastSeq = parseInt(lastNo.split("-")[2], 10);
  const nextSeq = String(lastSeq + 1).padStart(4, "0");
  return `${prefix}${nextSeq}`;
}

/**
 * Use Claude API to extract lead details from a WhatsApp message.
 * Returns structured JSON with name, phone, property_type, city, notes.
 */
async function extractLeadWithClaude(
  message: string,
  senderPhone: string
): Promise<{
  full_name: string;
  phone: string;
  property_type: string;
  city: string;
  state: string;
  address: string;
  notes: string;
}> {
  const prompt = `You are a lead extraction assistant for Jabiru Ventures, a Malaysian house inspection company.

Extract the following details from this WhatsApp message. If a detail is not mentioned, use the default value shown.

WhatsApp message:
"${message}"

Sender's phone number: ${senderPhone}

Return ONLY a valid JSON object with these exact fields:
{
  "full_name": "extracted name or 'Unknown'",
  "phone": "${senderPhone}",
  "property_type": "Condo or Landed or Apartment or Commercial or Others",
  "city": "extracted city or 'Unknown'",
  "state": "extracted state or 'Unknown'",
  "address": "extracted address or ''",
  "notes": "any other relevant details mentioned or ''"
}

Return ONLY the JSON object. No explanation, no markdown, no backticks.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`Claude API error: ${res.status}`);

  const data = await res.json();
  const text = data.content[0].text.trim();

  // Strip any accidental markdown fences just in case
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

/**
 * Upsert customer — update if phone exists, insert if not.
 * Returns customer UUID.
 */
async function upsertCustomer(leadData: {
  full_name: string;
  phone: string;
}): Promise<string> {
  const phone = normalisePhone(leadData.phone);

  // Check if customer exists
  const lookupRes = await fetch(
    `${SB_URL}/rest/v1/customers?phone=eq.${encodeURIComponent(phone)}&select=id&limit=1`,
    {
      headers: {
        apikey: SB_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SB_SERVICE_ROLE_KEY}`,
      },
    }
  );

  if (!lookupRes.ok) throw new Error("Failed to look up customer");

  const existing = await lookupRes.json();

  if (existing.length > 0) {
    // Update existing customer
    const customerId = existing[0].id;
    await fetch(`${SB_URL}/rest/v1/customers?id=eq.${customerId}`, {
      method: "PATCH",
      headers: {
        apikey: SB_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SB_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        full_name: leadData.full_name !== "Unknown" ? leadData.full_name : undefined,
        lead_source: "WhatsApp",
      }),
    });
    return customerId;
  }

  // Insert new customer
  const insertRes = await fetch(`${SB_URL}/rest/v1/customers`, {
    method: "POST",
    headers: {
      apikey: SB_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SB_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      full_name: leadData.full_name,
      phone: phone,
      race: "Others",
      lead_source: "WhatsApp",
    }),
  });

  if (!insertRes.ok) throw new Error("Failed to insert customer");

  const newCustomer = await insertRes.json();
  return newCustomer[0].id;
}

/**
 * Insert property record linked to customer.
 * Returns property UUID.
 */
async function insertProperty(
  customerId: string,
  leadData: {
    address: string;
    city: string;
    state: string;
    property_type: string;
  }
): Promise<string> {
  const res = await fetch(`${SB_URL}/rest/v1/properties`, {
    method: "POST",
    headers: {
      apikey: SB_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SB_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      customer_id: customerId,
      address: leadData.address || "To be confirmed",
      city: leadData.city || "Unknown",
      state: leadData.state || "Unknown",
      property_type: leadData.property_type || "Others",
    }),
  });

  if (!res.ok) throw new Error("Failed to insert property");

  const property = await res.json();
  return property[0].id;
}

/**
 * Insert job record with status "Lead".
 */
async function insertJob(
  customerId: string,
  propertyId: string,
  notes: string,
  invoiceNo: string
): Promise<void> {
  const res = await fetch(`${SB_URL}/rest/v1/jobs`, {
    method: "POST",
    headers: {
      apikey: SB_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SB_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      customer_id: customerId,
      property_id: propertyId,
      status: "Lead",
      price: 0,
      invoice_no: invoiceNo,
      report_recipient: "Client",
      notes: notes || null,
    }),
  });

  if (!res.ok) throw new Error("Failed to insert job");
}

/**
 * Send a WhatsApp text message via Cloud API.
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
    throw new Error(`WhatsApp send failed: ${err}`);
  }
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  // ── GET: Webhook verification by Meta ───────────────────────────────────────
  if (req.method === "GET") {
    const url = new URL(req.url);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
      console.log("[Jabiru] ✅ Webhook verified by Meta");
      return new Response(challenge, { status: 200 });
    }

    console.warn("[Jabiru] ❌ Webhook verification failed");
    return new Response("Forbidden", { status: 403 });
  }

  // ── POST: Incoming WhatsApp message ─────────────────────────────────────────
  if (req.method === "POST") {
    let body: any;

    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    try {
      // Navigate the WhatsApp Cloud API payload structure
      const entry = body?.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const messages = value?.messages;

      // Ignore non-message events (status updates, etc.)
      if (!messages || messages.length === 0) {
        return new Response("OK", { status: 200 });
      }

      const incomingMsg = messages[0];
      const senderPhone = incomingMsg.from; // already in 60XXXXXXXXX format
      const messageText =
        incomingMsg.type === "text"
          ? incomingMsg.text?.body || ""
          : "[Non-text message received]";

      console.log(`[Jabiru] 📨 Message from ${senderPhone}: ${messageText}`);

      // ── Step 1: Extract lead details with Claude ─────────────────────────────
      let leadData;
      try {
        leadData = await extractLeadWithClaude(messageText, senderPhone);
        console.log("[Jabiru] ✅ Claude extracted:", JSON.stringify(leadData));
      } catch (err) {
        console.error("[Jabiru] ❌ Claude extraction failed:", err);
        // Fallback — use raw sender phone, unknown details
        leadData = {
          full_name: "Unknown",
          phone: senderPhone,
          property_type: "Others",
          city: "Unknown",
          state: "Unknown",
          address: "",
          notes: messageText,
        };
      }

      // ── Step 2: Save to Supabase ─────────────────────────────────────────────
      let invoiceNo = "JV-ERROR";
      try {
        invoiceNo = await generateInvoiceNo();
        const customerId = await upsertCustomer(leadData);
        const propertyId = await insertProperty(customerId, leadData);
        await insertJob(customerId, propertyId, leadData.notes, invoiceNo);
        console.log(`[Jabiru] ✅ Lead saved. Invoice: ${invoiceNo}`);
      } catch (err) {
        console.error("[Jabiru] ❌ Supabase save failed:", err);
        // Continue — still send reply even if DB fails
      }

      // ── Step 3: Send auto-reply to lead ─────────────────────────────────────
      const clientName =
        leadData.full_name !== "Unknown" ? leadData.full_name : "there";
      const autoReply =
        `Hi ${clientName}! Thank you for contacting Jabiru Ventures. ` +
        `We have received your enquiry and will get back to you shortly. ` +
        `Reference: ${invoiceNo}`;

      try {
        await sendWhatsApp(senderPhone, autoReply);
        console.log(`[Jabiru] ✅ Auto-reply sent to ${senderPhone}`);
      } catch (err) {
        console.error("[Jabiru] ❌ Auto-reply failed:", err);
      }

      // ── Step 4: Notify owner ─────────────────────────────────────────────────
      const ownerNotification =
        `🔔 New lead: ${leadData.full_name} | ${senderPhone} | ` +
        `${leadData.property_type} | ${leadData.city} | Ref: ${invoiceNo}`;

      try {
        await sendWhatsApp(OWNER_WHATSAPP, ownerNotification);
        console.log("[Jabiru] ✅ Owner notified");
      } catch (err) {
        console.error("[Jabiru] ❌ Owner notification failed:", err);
      }

      return new Response("OK", { status: 200 });
    } catch (err) {
      console.error("[Jabiru] ❌ Unhandled error:", err);
      // Always return 200 to Meta — otherwise it retries endlessly
      return new Response("OK", { status: 200 });
    }
  }

  return new Response("Method not allowed", { status: 405 });
});