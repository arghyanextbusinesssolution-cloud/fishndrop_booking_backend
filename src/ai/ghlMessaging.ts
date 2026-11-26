import logger from "../config/logger";
import { dispatchToGHL } from "../integrations/ghl/client";
import { getWebhookUrl } from "../integrations/ghl/config";

/**
 * Talking back to GHL.
 *
 * - sendSocialReply: posts the AI reply into the contact's Instagram / Facebook conversation via the
 *   GHL Conversations API. Needs GHL_API_TOKEN (Private Integration token with conversations/message
 *   write + contacts write scopes). Without a token, replies are returned in the webhook response
 *   instead and a GHL workflow sends them.
 * - notifyGHL: posts AI inquiry events (stage changes, human handoff) to the booking-sync webhook so a
 *   GHL workflow can tag the contact, move the pipeline stage and alert staff.
 */

const API = "https://services.leadconnectorhq.com";

export const hasGhlApi = () => Boolean(process.env.GHL_API_TOKEN?.trim());

const ghlFetch = async (path: string, body: unknown) => {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GHL_API_TOKEN?.trim()}`,
      Version: "2021-04-15",
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GHL ${res.status}: ${text.slice(0, 300)}`);
  return text;
};

/** GHL message type for the channel the customer wrote on. */
export const ghlMessageType = (channel: string): "IG" | "FB" | null => {
  const c = channel.toLowerCase();
  if (c.includes("insta") || c === "ig") return "IG";
  if (c.includes("face") || c.includes("messenger") || c === "fb") return "FB";
  return null;
};

/**
 * When the webhook doesn't say which app the customer wrote on, ask GHL: the contact's most recent
 * conversation tells us if the last message was Facebook or Instagram. Returns null if unknown.
 */
export const lookupContactChannel = async (contactId: string): Promise<"facebook" | "instagram" | null> => {
  if (!hasGhlApi() || !contactId) return null;
  try {
    const url = new URL(`${API}/conversations/search`);
    url.searchParams.set("contactId", contactId);
    if (process.env.GHL_LOCATION_ID?.trim()) url.searchParams.set("locationId", process.env.GHL_LOCATION_ID.trim());
    url.searchParams.set("limit", "5");
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.GHL_API_TOKEN?.trim()}`, Version: "2021-04-15", Accept: "application/json" }
    });
    if (!res.ok) {
      console.log(`[AI] ⚠️ Channel lookup failed: HTTP ${res.status}`);
      return null;
    }
    const data: any = await res.json();
    const convs: any[] = Array.isArray(data?.conversations) ? data.conversations : [];
    // Newest first; look at the last message type of each conversation
    convs.sort((a, b) => Number(b.lastMessageDate || 0) - Number(a.lastMessageDate || 0));
    for (const c of convs) {
      const t = String(c.lastMessageType || c.type || "").toUpperCase();
      if (t.includes("FACEBOOK") || t === "FB") return "facebook";
      if (t.includes("INSTAGRAM") || t === "IG") return "instagram";
    }
    return null;
  } catch (err: any) {
    console.log("[AI] ⚠️ Channel lookup error:", err?.message);
    return null;
  }
};

/** Instagram / Messenger cap a DM at ~1000 characters — long replies (e.g. two menus) go out as several messages. */
const MAX_DM = 950;
export const splitForDm = (text: string, max = MAX_DM): string[] => {
  const t = text.trim();
  if (t.length <= max) return [t];
  // Lines (very long lines broken at word boundaries), then packed into messages — never split mid-line or mid-word
  const lines = t.split("\n").flatMap((line) => {
    if (line.length <= max) return [line];
    const out: string[] = [];
    let cur = "";
    for (const word of line.split(" ")) {
      if (cur && (cur + " " + word).length > max) {
        out.push(cur);
        cur = word;
      } else cur = cur ? `${cur} ${word}` : word;
    }
    if (cur) out.push(cur);
    return out;
  });
  const parts: string[] = [];
  let cur = "";
  for (const line of lines) {
    const next = cur ? `${cur}\n${line}` : line;
    if (next.length > max && cur.trim()) {
      parts.push(cur.trim());
      cur = line;
    } else cur = next;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
};

export const sendSocialReply = async (contactId: string, channel: string, message: string): Promise<boolean> => {
  const type = ghlMessageType(channel);
  if (!hasGhlApi() || !type) {
    console.log(`[AI] ❌ Not sent via GHL API — ${!hasGhlApi() ? "GHL_API_TOKEN missing" : `unknown channel "${channel}"`}`);
    return false;
  }
  const chunks = splitForDm(message);
  for (const [i, chunk] of chunks.entries()) {
    const body = { type, contactId, message: chunk };
    console.log(`\n[AI] ➡️  SENDING reply${chunks.length > 1 ? ` (part ${i + 1}/${chunks.length})` : ""} via GHL API (POST /conversations/messages):`);
    console.log(JSON.stringify(body, null, 2));
    try {
      const text = await ghlFetch("/conversations/messages", body);
      console.log("[AI] ⬅️  GHL API RESPONSE: OK", text.slice(0, 500));
    } catch (err: any) {
      console.log("[AI] ❌ GHL API RESPONSE: FAILED", err?.message);
      logger.error("[AI] GHL send reply failed", { contactId, channel, part: i + 1, error: err?.message });
      return false;
    }
  }
  return true;
};

/**
 * Default delivery: post the AI reply to the GHL "AI reply" inbound webhook; the GHL workflow
 * behind it sends {{reply}} to the contact on the channel they wrote from.
 */
export const sendReplyToWebhook = async (p: {
  contactId: string;
  channel: string;
  contactName?: string;
  reply: string;
  stage?: string;
  handoff: boolean;
  inboundMessage: string;
  /** Booking ID the AI created in this chat (TRP-XXXXXX), when there is one. */
  bookingId?: string;
  checkoutUrl?: string;
  paymentStatus?: string;
  /** Plain-text summary for staff: event details, quote, booking ID, payment, callback. */
  notes?: string;
}): Promise<boolean> => {
  // Long replies → one webhook call per DM-sized part (the GHL workflow sends each as its own message)
  const chunks = splitForDm(p.reply);
  if (chunks.length > 1) {
    for (const [i, chunk] of chunks.entries()) {
      const ok = await sendReplyToWebhook({ ...p, reply: chunk, ...(i > 0 ? { handoff: false } : {}) });
      if (!ok) return false;
    }
    return true;
  }
  const type = ghlMessageType(p.channel);
  const payload = {
    bookingId: p.bookingId || "",
    checkoutUrl: p.checkoutUrl || "",
    paymentStatus: p.paymentStatus || "",
    notes: p.notes || "",
    event: "ai_reply",
    contactId: p.contactId,
    contact_id: p.contactId,
    channel: p.channel,
    messageType: type || "",
    contactName: p.contactName || "",
    reply: p.reply,
    message: p.reply,
    stage: p.stage || "",
    handoff: p.handoff,
    handoffText: p.handoff ? "yes" : "no",
    customerMessage: p.inboundMessage,
    sentAt: new Date().toISOString()
  };
  const url = getWebhookUrl("aiReply");
  console.log("\n[AI] ➡️  SENDING reply to GHL webhook:", url);
  console.log(JSON.stringify(payload, null, 2));

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const text = await res.text();
      console.log(`[AI] ⬅️  GHL webhook RESPONSE (attempt ${attempt}): HTTP ${res.status}`, text.slice(0, 500));
      if (res.ok) return true;
      if (res.status < 500 && res.status !== 429) return false;
    } catch (err: any) {
      console.log(`[AI] ❌ GHL webhook request FAILED (attempt ${attempt}):`, err?.message);
    }
  }
  return false;
};

/** Sends a message we start ourselves (e.g. "You're booked!") using the configured delivery mode. */
export const deliverReply = async (contactId: string, channel: string, message: string): Promise<boolean> => {
  const mode = (process.env.AI_REPLY_MODE || "webhook").toLowerCase();
  if (mode === "api") return sendSocialReply(contactId, channel, message);
  return sendReplyToWebhook({ contactId, channel, reply: message, handoff: false, inboundMessage: "" });
};

/** Adds a note to the GHL contact (shows in the contact's Notes tab). Needs GHL_API_TOKEN with contacts write. */
export const addContactNote = async (contactId: string, body: string): Promise<boolean> => {
  if (!hasGhlApi() || !body.trim()) return false;
  try {
    const res = await fetch(`${API}/contacts/${encodeURIComponent(contactId)}/notes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GHL_API_TOKEN?.trim()}`,
        Version: "2021-07-28",
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({ body: body.slice(0, 5000) })
    });
    const text = await res.text();
    console.log(`[AI] 📝 GHL contact note → HTTP ${res.status}`, res.ok ? "" : text.slice(0, 300));
    return res.ok;
  } catch (err: any) {
    logger.warn("[AI] GHL contact note failed", { contactId, error: err?.message });
    return false;
  }
};

export const addContactTags = async (contactId: string, tags: string[]) => {
  if (!hasGhlApi()) return;
  try {
    await ghlFetch(`/contacts/${encodeURIComponent(contactId)}/tags`, { tags });
  } catch (err: any) {
    logger.warn("[AI] GHL add tags failed", { contactId, error: err?.message });
  }
};

/** Saves the call-back number on the GHL contact so a call / transfer can be made to it. */
export const updateContactPhone = async (contactId: string, phone: string): Promise<boolean> => {
  if (!hasGhlApi()) return false;
  try {
    const res = await fetch(`${API}/contacts/${encodeURIComponent(contactId)}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${process.env.GHL_API_TOKEN?.trim()}`,
        Version: "2021-07-28",
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({ phone })
    });
    const text = await res.text();
    console.log(`[AI] 📞 GHL contact phone update → HTTP ${res.status}`, res.ok ? phone : text.slice(0, 300));
    return res.ok;
  } catch (err: any) {
    logger.warn("[AI] GHL contact phone update failed", { contactId, error: err?.message });
    return false;
  }
};

export type AiCrmEvent = "ai_inquiry_update" | "ai_handoff_requested" | "ai_human_call_requested";

export const notifyGHL = async (event: AiCrmEvent, payload: Record<string, unknown>) => {
  const body = { event, source: "tropica_ai_assistant", sentAt: new Date().toISOString(), ...payload };
  if (event !== "ai_inquiry_update") {
    console.log(`\n[AI] 🙋 SENDING ${event} to GHL webhook:`, getWebhookUrl("aiHandoff"));
    console.log(JSON.stringify(body, null, 2));
  }
  // Human / call requests → AI webhook (5bd6e536…); routine stage updates stay on booking-sync
  const r = await dispatchToGHL({ webhook: event === "ai_inquiry_update" ? "bookingSync" : "aiHandoff", event, ref: String(payload.contactId || "").slice(0, 8), payload: body }).catch(
    () => undefined
  );
  if (event !== "ai_inquiry_update") console.log(`[AI] ⬅️  GHL handoff webhook RESPONSE: ${r?.ok ? "OK" : "FAILED"} (HTTP ${r?.status ?? "-"})`);
  return r;
};
