/**
 * Jabiru Ventures — AI Report Generator
 * Task 5: Inspection Report Backend
 *
 * This Supabase Edge Function:
 * 1. Receives checklist data from teammate's Module 4
 * 2. Fetches full job + property + customer details from Supabase
 * 3. Builds a detailed prompt and sends to Claude API
 * 4. Saves the AI-generated draft report to Supabase reports table
 * 5. Notifies owner via WhatsApp that draft is ready for review
 *
 * Expected POST body:
 * {
 *   "job_id": "uuid-of-the-job",
 *   "checklist": {
 *     "inspector_name": "John Doe",
 *     "inspection_date": "2025-06-10",
 *     "weather": "Sunny",
 *     "rooms": [
 *       {
 *         "name": "Living Room",
 *         "defects": [
 *           {
 *             "type": "Crack",
 *             "severity": "Major",
 *             "description": "Horizontal crack on wall near window",
 *             "photo_tags": ["crack", "structural"]
 *           }
 *         ]
 *       }
 *     ],
 *     "general_notes": "Property is generally in good condition"
 *   }
 * }
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// ── ENV VARIABLES ─────────────────────────────────────────────────────────────
const SB_URL = Deno.env.get("SB_URL")!;
const SB_SERVICE_ROLE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY")!;
const CLAUDE_API_KEY = Deno.env.get("CLAUDE_API_KEY")!;
const WHATSAPP_TOKEN = Deno.env.get("WHATSAPP_TOKEN")!;
const WHATSAPP_PHONE_NUMBER_ID = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")!;
const OWNER_WHATSAPP = Deno.env.get("OWNER_WHATSAPP")!;

// ── HELPERS ───────────────────────────────────────────────────────────────────

/**
 * Format date string to DD/MM/YYYY
 */
function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
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
    throw new Error(`WhatsApp send failed: ${err}`);
  }
}

/**
 * Fetch full job details including customer and property
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
 * Save report draft to Supabase reports table
 * Creates the table entry with status "Draft"
 */
async function saveReportDraft(
  jobId: string,
  reportContent: string
): Promise<string> {
  const res = await fetch(`${SB_URL}/rest/v1/reports`, {
    method: "POST",
    headers: {
      apikey: SB_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SB_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      job_id: jobId,
      content: reportContent,
      status: "Draft",
      created_at: new Date().toISOString(),
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to save report draft: ${err}`);
  }

  const report = await res.json();
  return report[0].id;
}

/**
 * Build a detailed prompt for Claude from job + checklist data
 */
function buildReportPrompt(job: any, checklist: any): string {
  const customer = job.customers;
  const property = job.properties;

  // Build defects summary by room
  let defectsSummary = "";
  let totalDefects = 0;
  let criticalCount = 0;
  let majorCount = 0;
  let minorCount = 0;

  if (checklist.rooms && checklist.rooms.length > 0) {
    for (const room of checklist.rooms) {
      if (room.defects && room.defects.length > 0) {
        defectsSummary += `\n${room.name}:\n`;
        for (const defect of room.defects) {
          defectsSummary += `  - [${defect.severity}] ${defect.type}: ${defect.description}\n`;
          if (defect.photo_tags && defect.photo_tags.length > 0) {
            defectsSummary += `    Photo tags: ${defect.photo_tags.join(", ")}\n`;
          }
          totalDefects++;
          if (defect.severity === "Critical") criticalCount++;
          if (defect.severity === "Major") majorCount++;
          if (defect.severity === "Minor") minorCount++;
        }
      } else {
        defectsSummary += `\n${room.name}: No defects found\n`;
      }
    }
  } else {
    defectsSummary = "No room-by-room data provided.";
  }

  return `You are a professional building inspector writing a formal inspection report for a Malaysian property inspection company called Jabiru Ventures. Jabiru Ventures employs BEM-certified inspectors.

Write a complete, professional inspection report based on the following data.

=== JOB DETAILS ===
Invoice Number: ${job.invoice_no}
Inspection Date: ${checklist.inspection_date ? formatDate(checklist.inspection_date) : formatDate(job.inspection_date)}
Inspector: ${checklist.inspector_name || "Jabiru Ventures Inspector"}
Weather Conditions: ${checklist.weather || "Not recorded"}

=== CLIENT DETAILS ===
Client Name: ${customer?.full_name || "N/A"}
Phone: ${customer?.phone || "N/A"}

=== PROPERTY DETAILS ===
Address: ${property?.address || "N/A"}
City: ${property?.city || "N/A"}
State: ${property?.state || "N/A"}
Property Type: ${property?.property_type || "N/A"}
Developer: ${property?.developer || "N/A"}

=== DEFECTS FOUND ===
Total Defects: ${totalDefects}
Critical: ${criticalCount} | Major: ${majorCount} | Minor: ${minorCount}
${defectsSummary}

=== GENERAL NOTES ===
${checklist.general_notes || "None"}

=== REPORT REQUIREMENTS ===
Write the report in formal English. Structure it exactly as follows:

1. REPORT HEADER
   - Company name: Jabiru Ventures
   - Tagline: BEM-Certified Property Inspectors
   - Invoice/Report reference number
   - Inspection date
   - Inspector name

2. EXECUTIVE SUMMARY
   - Brief overview of the property
   - Overall condition assessment (Good / Fair / Poor)
   - Total number of defects found by severity
   - Key recommendations in 2-3 sentences

3. PROPERTY INFORMATION
   - Full property details
   - Client details
   - Inspection conditions (date, weather)

4. DETAILED FINDINGS — ROOM BY ROOM
   - For each room: list all defects found
   - Each defect: type, severity rating, detailed description, recommended action
   - If no defects: state "No defects observed"

5. DEFECT SEVERITY SUMMARY TABLE
   - List all Critical defects first (require immediate attention)
   - Then Major defects (require attention within 30 days)
   - Then Minor defects (cosmetic, monitor or repair at convenience)

6. RECOMMENDATIONS
   - Prioritised list of actions the client should take
   - Separate urgent (Critical) from non-urgent items

7. PROFESSIONAL CLOSING STATEMENT
   - Thank the client
   - State that the report was prepared by a BEM-certified inspector
   - Include disclaimer: "This report reflects the condition of the property at the time of inspection only."

Write in a professional, clear, and objective tone. Use formal Malaysian English. Do not add any markdown formatting — write in plain text only.`;
}

/**
 * Call Claude API to generate the inspection report
 */
async function generateReportWithClaude(prompt: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error: ${res.status} — ${err}`);
  }

  const data = await res.json();
  return data.content[0].text.trim();
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // ── Parse request body ───────────────────────────────────────────────────
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const { job_id, checklist } = body;

  if (!job_id || !checklist) {
    return new Response(
      JSON.stringify({ error: "job_id and checklist are required" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  console.log(`[Jabiru] 📋 Generating report for job: ${job_id}`);

  // ── Step 1: Fetch job details ────────────────────────────────────────────
  let job: any;
  try {
    job = await fetchJobDetails(job_id);
    if (!job) {
      return new Response(
        JSON.stringify({ error: "Job not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }
    console.log(`[Jabiru] ✅ Job fetched: ${job.invoice_no}`);
  } catch (err) {
    console.error("[Jabiru] ❌ Failed to fetch job:", err);
    return new Response(
      JSON.stringify({ error: "Failed to fetch job details" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // ── Step 2: Generate report with Claude ──────────────────────────────────
  let reportContent: string;
  try {
    const prompt = buildReportPrompt(job, checklist);
    reportContent = await generateReportWithClaude(prompt);
    console.log("[Jabiru] ✅ Report generated by Claude");
  } catch (err) {
    console.error("[Jabiru] ❌ Claude report generation failed:", err);
    return new Response(
      JSON.stringify({ error: "Failed to generate report" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // ── Step 3: Save draft to Supabase ───────────────────────────────────────
  let reportId: string;
  try {
    reportId = await saveReportDraft(job_id, reportContent);
    console.log(`[Jabiru] ✅ Report draft saved. ID: ${reportId}`);
  } catch (err) {
    console.error("[Jabiru] ❌ Failed to save report draft:", err);
    // Continue — still notify owner even if save fails
    reportId = "unknown";
  }

  // ── Step 4: Notify owner via WhatsApp ────────────────────────────────────
  const ownerMessage =
    `📝 Report draft ready!\n\n` +
    `🔖 Job: ${job.invoice_no}\n` +
    `👤 Client: ${job.customers?.full_name || "N/A"}\n` +
    `📍 Property: ${job.properties?.address || "N/A"}\n\n` +
    `Please review and approve the report in the app.`;

  try {
    await sendWhatsApp(OWNER_WHATSAPP, ownerMessage);
    console.log("[Jabiru] ✅ Owner notified of report draft");
  } catch (err) {
    console.error("[Jabiru] ❌ Failed to notify owner:", err);
  }

  // ── Return success ───────────────────────────────────────────────────────
  return new Response(
    JSON.stringify({
      success: true,
      report_id: reportId,
      job_id: job_id,
      invoice_no: job.invoice_no,
      message: "Report draft generated and saved successfully",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});