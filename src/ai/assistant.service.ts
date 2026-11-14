import crypto from "crypto";
import logger from "../config/logger";
import AiConversation, { AiInquiryStage, IAiConversation } from "../models/AiConversation";
import { ChatMessage, ChatTool, groqChat, isGroqConfigured } from "./groq.client";
import { buildKnowledge, CONTACT, getPricing, siteLinks } from "./knowledge";
import { isValidYmd, normalizeTime, nyToday, prettyDate, to12h, upcomingCalendar, weekday } from "./dates";
import {
  buildBookingLink,
  checkTableAvailability,
  checkVenueAvailability,
  findOpenVenueDates,
  priceQuote
} from "./availability";
import { addContactTags, ghlMessageType, notifyGHL, updateContactPhone } from "./ghlMessaging";

/** US-first phone normalisation → E.164 ("+19175550142"), or null if it isn't a usable number. */
const normalizePhone = (raw: string): string | null => {
  const hasPlus = raw.trim().startsWith("+");
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (hasPlus && d.length >= 11 && d.length <= 15) return `+${d}`;
  return null;
};

/** "+19175550142" → "(917) 555-0142"; other countries stay in E.164. */
const formatPhone = (e164: string): string => {
  const d = e164.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return e164;
};
import { cancelAiHold, checkAiHoldPayment, createAiVenueHold } from "./aiBooking";

/**
 * Tropica AI booking assistant — turns one inbound social message into one reply.
 *
 * The model (Groq) handles language; every fact about availability and price comes from tools that
 * call the real booking engine / settings. Conversation memory lives in MongoDB (AiConversation).
 */

export interface InboundMessage {
  contactId: string;
  channel: string;
  text: string;
  messageId?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
}

export interface AssistantResult {
  reply: string | null;
  status: "replied" | "paused" | "duplicate" | "ignored" | "fallback";
  handoff: boolean;
  stage?: AiInquiryStage;
  conversationId?: string;
  toolsUsed?: string[];
}

const HISTORY_LIMIT = 14;
const STORED_MESSAGES_LIMIT = 120;
const MAX_TOOL_ROUNDS = 5;

// ---------------------------------------------------------------------------------------------
// Tool definitions (what the model may call)
// ---------------------------------------------------------------------------------------------

const TOOLS: ChatTool[] = [
  {
    type: "function",
    function: {
      name: "check_venue_availability",
      description:
        "LIVE check of the private venue buyout for one date. Call it every time before saying a date/time is open or taken. Without start_time it returns every open start time that day.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "YYYY-MM-DD (New York)" },
          start_time: { type: "string", description: "24h HH:MM, e.g. 20:00. Omit to list open start times." },
          duration_hours: { type: "integer", description: "5-12, default 5" },
          guests: { type: "integer" }
        },
        required: ["date"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "find_open_venue_dates",
      description:
        "LIVE search for alternative dates when the requested one is taken, or when the customer is flexible (e.g. 'any Saturday in December').",
      parameters: {
        type: "object",
        properties: {
          from_date: { type: "string", description: "YYYY-MM-DD to start searching from" },
          days: { type: "integer", description: "How many days to scan, 1-21 (default 7)" },
          duration_hours: { type: "integer" },
          start_time: { type: "string", description: "Only dates where this 24h start time is open" },
          weekdays_only: { type: "array", items: { type: "string" }, description: "e.g. [\"Fri\",\"Sat\"]" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "check_table_availability",
      description: "LIVE check of regular table reservations (groups under 10, or no buyout wanted).",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "YYYY-MM-DD" },
          guests: { type: "integer" },
          time: { type: "string", description: "24h HH:MM (optional)" }
        },
        required: ["date", "guests"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_price_quote",
      description: "Exact private venue price from current settings. Use for any price/deposit question with a guest count.",
      parameters: {
        type: "object",
        properties: {
          guests: { type: "integer" },
          duration_hours: { type: "integer" },
          dj: { type: "boolean" },
          photographer: { type: "boolean" },
          photographer_hours: { type: "integer" }
        },
        required: ["guests"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_booking_link",
      description: "The website link where the customer completes the booking and pays the deposit. Paste the returned url exactly.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["venue", "table", "tour", "events"] },
          date: { type: "string" },
          start_time: { type: "string" },
          guests: { type: "integer" },
          duration_hours: { type: "integer" }
        },
        required: ["type"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "save_details",
      description: "Remember booking details the customer just gave (call when they share any detail, even before checking).",
      parameters: {
        type: "object",
        properties: {
          booking_type: { type: "string", enum: ["venue", "table", "event", "unknown"] },
          date: { type: "string" },
          start_time: { type: "string" },
          guests: { type: "integer" },
          duration_hours: { type: "integer" },
          occasion: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "request_human_help",
      description:
        "Hand the customer to the Tropica team for a phone call: they ask for a person/agent/manager/call, are upset, want a discount or custom deal, ask about an existing booking, change, cancellation, refund or payment problem, or ask something not in the approved facts. FIRST get their mobile number (ask, or confirm the one on file) and pass it as phone. Only if they refuse to share a number, call it without phone.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Short summary for staff of what they need" },
          phone: { type: "string", description: "Mobile number the team should call (as the customer gave it)" },
          best_time: { type: "string", description: "When they'd like the call, if they said (e.g. 'after 5 PM', 'now')" },
          declined_phone: { type: "boolean", description: "true ONLY if the customer refused to share a phone number" },
          urgent: { type: "boolean" }
        },
        required: ["reason"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_booking_hold",
      description:
        "BOOK the private venue for the customer: creates the reservation, holds the slot for 30 minutes and returns a secure deposit payment link. Only call after the customer clearly said YES to your recap, and you have date, start time, guests, full name, email and phone.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "YYYY-MM-DD" },
          start_time: { type: "string", description: "24h HH:MM" },
          duration_hours: { type: "integer" },
          guests: { type: "integer" },
          full_name: { type: "string" },
          email: { type: "string" },
          phone: { type: "string" },
          occasion: { type: "string" },
          dj: { type: "boolean" },
          photographer: { type: "boolean" }
        },
        required: ["date", "start_time", "guests", "full_name", "email", "phone"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "cancel_booking_hold",
      description: "Release the unpaid slot you are holding for this customer (they changed their mind). Never for paid bookings.",
      parameters: { type: "object", properties: { reason: { type: "string" } } }
    }
  }
];

// ---------------------------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------------------------

const knownDetails = (c: IAiConversation): string => {
  const i = c.inquiry || {};
  const bits: string[] = [];
  if (i.bookingType && i.bookingType !== "unknown") bits.push(`type: ${i.bookingType}`);
  if (i.date) bits.push(`date: ${prettyDate(i.date)} (${i.date})`);
  if (i.startTime) bits.push(`start: ${to12h(i.startTime)}`);
  if (i.durationHours) bits.push(`duration: ${i.durationHours}h`);
  if (i.guests) bits.push(`guests: ${i.guests}`);
  if (i.occasion) bits.push(`occasion: ${i.occasion}`);
  return bits.length ? bits.join(" · ") : "nothing yet";
};

/**
 * Booking inside the DM (hold + Stripe deposit link) is built but OFF for now: customers are sent to
 * the website to book. Turn it on with AI_DM_BOOKING_ENABLED=true in .env.
 */
const DM_BOOKING_ENABLED = (process.env.AI_DM_BOOKING_ENABLED || "false").toLowerCase() === "true";

const WEBSITE_BOOKING_RULES = (deposit: number) => `
SENDING THEM TO BOOK (you cannot book, reserve or take payment in the chat)
- Once a slot is open and priced, or whenever they say yes / how do I book / want to reserve, call get_booking_link and send it with a one-line recap of what to pick, e.g. "Perfect! Book Sat, Dec 12 at 8 PM for 25 guests right here: <url> — just pick that date and time, the $${deposit} deposit locks it in."
- Put the link on its own at the end of the message, exactly as returned. Share it once; re-share only if they ask.
- If they ask you to book it for them: kindly say bookings are completed on the website (it takes about 2 minutes and shows live availability), and send the link.
- Never say you booked, reserved or held anything.
`;

const DM_BOOKING_RULES = (deposit: number) => `
- Once a slot is open and priced, offer: "Want me to book it for you now?" (or the website link if they prefer).

BOOKING FOR THEM (private venue)
- You CAN book: create_booking_hold reserves the slot for 30 minutes and gives a secure deposit link.
- Before booking you need: date, start time, guests, duration (default 5h), full name (first + last), email and phone. Use CONTACT ON FILE when known; ask only for what's missing, one at a time.
- Then send ONE short recap and ask for a yes, e.g. "Booking Sat, Dec 12, 8 PM–1 AM for 25 guests under Maria Lopez (maria@x.com, 917…). Total $1,250, $${deposit} deposit now. Shall I lock it in?" Only after a clear yes, call create_booking_hold.
- After it succeeds: share the paymentUrl exactly as returned, say the slot is held for 30 minutes and the booking is confirmed as soon as the deposit is paid. Do NOT say it's confirmed yet.
- If it fails because the slot was taken, apologise and offer the other open times (check again).
- If BOOKING HOLD shows awaiting payment and they ask, re-share that same link (still valid until it expires). If it shows confirmed, congratulate them and give the booking number. If expired, offer to check the slot again and make a new hold.
- If they change date/time/guests after a hold, just create a new hold (the old one is released automatically). If they cancel before paying, call cancel_booking_hold.
- Prefer the website instead? Use get_booking_link. Tables, tours and event tickets are always booked through get_booking_link.
`;

/** Tools the model sees — the booking tools only when DM booking is switched on. */
const activeTools = (): ChatTool[] =>
  DM_BOOKING_ENABLED ? TOOLS : TOOLS.filter((t) => !["create_booking_hold", "cancel_booking_hold"].includes(t.function.name));

const holdLine = (c: IAiConversation): string => {
  const h = c.hold;
  if (!h?.bookingId) return "none";
  const mins = Math.max(0, Math.round((new Date(h.expiresAt).getTime() - Date.now()) / 60000));
  switch (h.status) {
    case "awaiting_payment":
      return `#${h.ref} AWAITING PAYMENT — held ${mins} more min. Total $${h.total}, deposit $${h.deposit}. Payment link: ${h.paymentUrl}`;
    case "confirmed":
      return `#${h.ref} CONFIRMED — deposit paid. Total $${h.total}, balance $${h.total - h.deposit} due 72h before.`;
    case "expired":
      return `#${h.ref} EXPIRED — not paid in time, slot released.`;
    case "paid_needs_review":
      return `#${h.ref} paid late — staff are handling it.`;
    default:
      return `#${h.ref} cancelled.`;
  }
};

const buildSystemPrompt = async (c: IAiConversation): Promise<string> => {
  const pricing = await getPricing();
  const today = nyToday();
  const last = c.lastCheck?.summary
    ? `${c.lastCheck.summary} (checked ${Math.round((Date.now() - new Date(c.lastCheck.checkedAt).getTime()) / 60000)} min ago — re-check before repeating it)`
    : "none";
  const firstName = (c.contactName || "").trim().split(/\s+/)[0];

  return `You are the booking assistant for Tropica NYC, replying to customers in ${c.channel === "facebook" ? "Facebook Messenger" : "Instagram DMs"}.

TODAY: ${weekday(today)}, ${today} (New York time).
CALENDAR (use it for "Friday", "next Saturday", "this weekend" — never compute weekdays yourself): ${upcomingCalendar(35)}
DATES BEYOND THE CALENDAR are fine (bookings open up to 12 months ahead): just pass the exact YYYY-MM-DD to the tools — the tool result gives you the weekday. Never hand off or refuse because a date is far away; always run the check.
CUSTOMER: ${firstName || "unknown name"}
KNOWN DETAILS (don't ask again): ${knownDetails(c)}
LAST AVAILABILITY CHECK: ${last}
LINK ALREADY SHARED: ${c.linkSharedAt ? "yes" : "no"}
PHONE ON FILE: ${c.contactPhone ? formatPhone(c.contactPhone) : "none"}
${
    DM_BOOKING_ENABLED
      ? `CONTACT ON FILE (use, don't re-ask; confirm once before booking): name ${c.contactName || "unknown"} · email ${c.contactEmail || "unknown"} · phone ${c.contactPhone || "unknown"}
BOOKING HOLD: ${holdLine(c)}
`
      : ""
  }
HOW TO WRITE
- Sound like a warm, confident host texting — natural, never robotic or salesy. Plain text only: no markdown, no bullet lists, no bold.
- Keep it short: 1–3 sentences, under ~60 words. A DM, not an email.
- First answer exactly what they asked, then move the booking one step forward with ONE clear question or next step.
- Ask for only ONE missing detail at a time, in this order for a venue buyout: date → start time → number of guests. Duration is 5 hours (included) unless they want longer.
- Friendly formats only: "Sat, Dec 12", "8 PM". Never show YYYY-MM-DD or 24-hour times.
- Reply in the customer's language. Greet by first name ONLY in your first message of the chat — later messages go straight to the point. Max one emoji, only if natural.
- When listing open times, give at most 4 and summarise ("anytime from 2 PM to 6 PM").

HOW TO BOOK
- Party of ${10}+ wanting the place to themselves → private venue buyout. Under 10 guests → suggest a table reservation and use check_table_availability.
- As soon as you know a date, call check_venue_availability (with start_time if known). With date + time + guests you can also quote the price.
- "8" / "8 at night" = 20:00. Vague times ("evening") → show the open evening start times from the tool.
- If the requested slot is taken: say so kindly, then offer the other open times that day from the tool result; if none fit, call find_open_venue_dates and offer up to 3 real alternatives.
${DM_BOOKING_ENABLED ? DM_BOOKING_RULES(pricing.minDepositAmount) : WEBSITE_BOOKING_RULES(pricing.minDepositAmount)}
TRUTH RULES (most important)
- Never say a date/time is open, available, free or taken unless a tool told you so in this turn. If anything changed (date, time, guests, hours), check again.
- Say "it's open right now" / "showing available" — never "confirmed", "reserved" or "booked"${DM_BOOKING_ENABLED ? " unless BOOKING HOLD says CONFIRMED" : ""}. Nothing is secured until the deposit is paid.
- Never assume a guest count, time or duration the customer didn't give — don't quote a price until you know the guests.
- Never invent prices, fees, policies, menu items, addresses, hours or discounts. Use the facts below and get_price_quote. Don't know → say you'll have the team confirm and call request_human_help.
- Never suggest an alternative date/time that a tool didn't return.
- If a tool fails, say you can't verify availability right this second, share the booking page (live availability is there) and offer a team member.
- Existing bookings, changes, cancellations, refunds, payment issues, complaints, discounts, custom deals → follow HUMAN / CALL REQUESTS.

HUMAN / CALL REQUESTS ("can I talk to someone", "call me", "real person", "agent", "manager", or anything you must hand off)
- Step 1: get the best mobile number for a call. If PHONE ON FILE is known, confirm it: "Sure! Should our team call you at (917) 555-0142?" Otherwise: "Of course! What's the best mobile number for our team to call you?" Don't call the tool yet.
- Step 2: once they give or confirm a number (and a time if they mention one), call request_human_help with phone (and best_time). If the tool says the number is invalid, ask again politely.
- Step 3: reply: "Thanks! A Tropica team member will call you at <number> shortly." Add the time if they gave one. Nothing else to ask.
- If they refuse to share a number: call request_human_help without phone and say a team member will reply here in the chat. Urgent: they can call ${CONTACT.phone}.
- Never promise an exact callback time.
- Never mention other customers or why a slot is taken.
- Use save_details whenever they give a detail.

${buildKnowledge(pricing)}`;
};

// ---------------------------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------------------------

interface TurnState {
  conv: IAiConversation;
  stage?: AiInquiryStage;
  handoff?: { reason: string; urgent: boolean; phone?: string; bestTime?: string };
  toolsUsed: string[];
}

const rememberDetails = (conv: IAiConversation, a: Record<string, any>) => {
  const inq: any = conv.inquiry || {};
  if (a.booking_type) inq.bookingType = a.booking_type;
  if (isValidYmd(a.date)) inq.date = a.date;
  const t = normalizeTime(a.start_time ?? a.time);
  if (t) inq.startTime = t;
  if (Number(a.guests) > 0) inq.guests = Math.round(Number(a.guests));
  if (Number(a.duration_hours) > 0) inq.durationHours = Math.round(Number(a.duration_hours));
  if (typeof a.occasion === "string" && a.occasion.trim()) inq.occasion = a.occasion.trim().slice(0, 80);
  conv.inquiry = inq;
  conv.markModified("inquiry");
};

const runTool = async (name: string, rawArgs: string, st: TurnState): Promise<unknown> => {
  let args: Record<string, any> = {};
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return { ok: false, error: "Arguments were not valid JSON" };
  }
  st.toolsUsed.push(name);
  const { conv } = st;

  try {
    switch (name) {
      case "check_venue_availability": {
        rememberDetails(conv, { ...args, booking_type: "venue" });
        const r: any = await checkVenueAvailability(args);
        if (r.ok) {
          conv.lastCheck = {
            kind: "venue",
            date: r.date,
            startTime: normalizeTime(args.start_time) || undefined,
            durationHours: r.durationHours,
            guests: r.guests,
            available: Boolean(r.requestedAvailable ?? r.openStartTimes.length),
            summary: r.summary,
            checkedAt: new Date()
          };
          st.stage = "availability_checked";
        }
        return r;
      }
      case "find_open_venue_dates":
        return await findOpenVenueDates(args);
      case "check_table_availability": {
        rememberDetails(conv, { ...args, booking_type: "table" });
        const r: any = await checkTableAvailability(args);
        if (r.ok) {
          conv.lastCheck = {
            kind: "table",
            date: r.date,
            startTime: normalizeTime(args.time) || undefined,
            guests: r.guests,
            available: Boolean(r.requestedAvailable ?? r.openTimes.length),
            summary: r.summary,
            checkedAt: new Date()
          };
          st.stage = "availability_checked";
        }
        return r;
      }
      case "get_price_quote": {
        const p = await getPricing();
        const guests = Math.round(Number(args.guests));
        if (!(guests > 0)) return { ok: false, error: "guests required" };
        rememberDetails(conv, { guests, duration_hours: args.duration_hours });
        const q = priceQuote(p, guests, Math.min(12, Math.max(5, Number(args.duration_hours) || 5)), Boolean(args.dj), Boolean(args.photographer), Math.max(2, Number(args.photographer_hours) || 2));
        const notes: string[] = [];
        if (guests < 10) notes.push("Under the 10-guest minimum for a buyout — suggest a table reservation.");
        if (guests > p.maxGuestCapacity) notes.push(`Over the ${p.maxGuestCapacity}-guest capacity.`);
        return { ok: true, ...q, notes };
      }
      case "get_booking_link": {
        const i = conv.inquiry || {};
        const r = buildBookingLink({
          type: args.type,
          date: args.date || i.date,
          start_time: args.start_time || i.startTime,
          guests: args.guests || i.guests,
          duration_hours: args.duration_hours || i.durationHours,
          channel: conv.channel
        });
        conv.linkSharedAt = new Date();
        st.stage = "link_shared";
        return r;
      }
      case "save_details":
        rememberDetails(conv, args);
        if (conv.stage === "new") st.stage = "collecting_details";
        return { ok: true, known: knownDetails(conv) };
      case "create_booking_hold": {
        if (!DM_BOOKING_ENABLED) return { ok: false, error: "Booking in chat is off — send get_booking_link instead." };
        const i = conv.inquiry || {};
        rememberDetails(conv, { ...args, booking_type: "venue" });
        const r: any = await createAiVenueHold({
          contactId: conv.contactId,
          channel: conv.channel,
          fullName: args.full_name || conv.contactName,
          email: args.email || conv.contactEmail,
          phone: args.phone || conv.contactPhone,
          date: args.date || i.date,
          startTime: args.start_time || i.startTime,
          durationHours: args.duration_hours || i.durationHours,
          guests: args.guests || i.guests,
          occasion: args.occasion || i.occasion,
          dj: args.dj,
          photographer: args.photographer
        });
        if (r.ok) {
          const fresh: any = await AiConversation.findOne({ contactId: conv.contactId }).select("hold contactEmail contactPhone").lean();
          if (fresh?.hold) conv.hold = fresh.hold;
          if (fresh?.contactEmail) conv.contactEmail = fresh.contactEmail;
          if (fresh?.contactPhone) conv.contactPhone = fresh.contactPhone;
          if (args.full_name) conv.contactName = args.full_name;
          conv.linkSharedAt = new Date();
          st.stage = "link_shared";
        }
        return r;
      }
      case "cancel_booking_hold": {
        if (!conv.hold?.bookingId || conv.hold.status !== "awaiting_payment") return { ok: false, error: "No unpaid hold to cancel" };
        const done = await cancelAiHold(conv.hold.bookingId, String(args.reason || "Customer cancelled in DM"));
        if (done) {
          conv.hold.status = "cancelled";
          conv.markModified("hold");
        }
        return { ok: done };
      }
      case "request_human_help": {
        const reason = String(args.reason || "Customer needs help").slice(0, 300);
        let phone: string | undefined;
        if (args.phone) {
          phone = normalizePhone(String(args.phone)) || undefined;
          if (!phone) return { ok: false, error: "That doesn't look like a valid mobile number (need 10 digits, US). Ask again politely." };
          conv.contactPhone = phone;
        } else if (!args.declined_phone) {
          // Don't hand off yet — the chat would pause before the customer can answer
          return {
            ok: false,
            notYet: true,
            error: conv.contactPhone
              ? `Not sent yet. First ask them to confirm the number on file ${formatPhone(conv.contactPhone)} (or give another), then call again with phone.`
              : "Not sent yet. First ask for their best mobile number, wait for their reply, then call again with phone."
          };
        }
        const bestTime = args.best_time ? String(args.best_time).slice(0, 80) : undefined;
        conv.callback = { phone, reason, bestTime, requestedAt: new Date(), status: phone ? "requested" : "chat_only" };
        conv.markModified("callback");
        st.handoff = { reason, urgent: Boolean(args.urgent), phone, bestTime };
        st.stage = "human_required";
        return {
          ok: true,
          callScheduled: Boolean(phone),
          phone: phone ? formatPhone(phone) : undefined,
          bestTime,
          note: phone
            ? `Team notified to call this number. Thank them and confirm the number${bestTime ? ` and that they'll be called ${bestTime}` : ""}. AI replies pause after this message.`
            : "Team notified to reply in the chat. AI replies pause after this message."
        };
      }
      default:
        return { ok: false, error: `Unknown tool ${name}` };
    }
  } catch (err: any) {
    logger.error("[AI] tool failed", { tool: name, error: err?.message });
    return { ok: false, error: "Live system unavailable right now" };
  }
};

// ---------------------------------------------------------------------------------------------
// Reply cleanup
// ---------------------------------------------------------------------------------------------

const cleanReply = (text: string): string =>
  text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$2") // markdown links → bare url (IG doesn't render markdown)
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 950);

const fallbackReply = () =>
  `Sorry, I'm having trouble pulling up live availability this second. You can see open dates and book here: ${siteLinks().venue} — or I can have a team member message you. Just say "team".`;

// ---------------------------------------------------------------------------------------------
// Conversation loading + de-duplication
// ---------------------------------------------------------------------------------------------

const messageKey = (m: InboundMessage) =>
  m.messageId?.trim() ||
  crypto
    .createHash("sha1")
    .update(`${m.contactId}|${m.text}|${Math.floor(Date.now() / 60000)}`)
    .digest("hex");

/** Atomically records the message id. Returns null if this message was already processed. */
const claimMessage = async (m: InboundMessage, key: string): Promise<IAiConversation | null> => {
  const setOnInsert: Record<string, unknown> = { channel: m.channel, stage: "new", aiPaused: false };
  const set: Record<string, unknown> = { lastInboundAt: new Date() };
  if (m.contactName) set.contactName = m.contactName;
  if (m.contactEmail && m.contactEmail.includes("@")) set.contactEmail = m.contactEmail.toLowerCase();
  if (m.contactPhone && m.contactPhone.replace(/\D/g, "").length >= 10) set.contactPhone = m.contactPhone;
  try {
    return await AiConversation.findOneAndUpdate(
      { contactId: m.contactId, processedMessageIds: { $ne: key } },
      { $setOnInsert: setOnInsert, $set: set, $push: { processedMessageIds: { $each: [key], $slice: -60 } } },
      { upsert: true, returnDocument: "after" }
    );
  } catch (err: any) {
    if (err?.code === 11000) return null; // exists and already has this id
    throw err;
  }
};

// One message at a time per contact, so replies never cross.
const queues = new Map<string, Promise<unknown>>();
const serialize = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  queues.set(key, next);
  next.finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  }).catch(() => undefined);
  return next;
};

// ---------------------------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------------------------

export const processInboundMessage = (m: InboundMessage): Promise<AssistantResult> =>
  serialize(m.contactId, () => handle(m));

const handle = async (m: InboundMessage): Promise<AssistantResult> => {
  const text = (m.text || "").trim().slice(0, 2000);
  if (!text) return { reply: null, status: "ignored", handoff: false };

  const key = messageKey(m);
  const conv = await claimMessage(m, key);
  if (!conv) return { reply: null, status: "duplicate", handoff: false };

  // Echo protection: GHL can send our own outbound message back as an event
  const lastAssistant = [...conv.messages].reverse().find((x) => x.role === "assistant");
  if (lastAssistant && lastAssistant.content.trim() === text) {
    return { reply: null, status: "ignored", handoff: false, conversationId: String(conv._id) };
  }

  conv.messages.push({ role: "user", content: text, at: new Date(), messageId: m.messageId });

  // An AI handoff (waiting for the team) times out so the customer is never stuck with a silent bot
  const pauseHours = Number(process.env.AI_PAUSE_HOURS) || 12;
  if (conv.aiPaused && conv.pausedBy === "ai" && conv.pausedAt && Date.now() - new Date(conv.pausedAt).getTime() > pauseHours * 3600 * 1000) {
    conv.aiPaused = false;
    conv.pausedReason = undefined;
    conv.pausedAt = undefined;
    conv.pausedBy = undefined;
    conv.stage = "collecting_details";
  }

  if (conv.aiPaused) {
    // Staff took over → stay silent. Waiting for our callback → acknowledge + remind staff (max every 30 min)
    const waitingForTeam = conv.pausedBy === "ai";
    const lastNudge = conv.callback?.lastFollowUpAt || conv.callback?.requestedAt || conv.pausedAt;
    const canNudge = waitingForTeam && (!lastNudge || Date.now() - new Date(lastNudge).getTime() > 30 * 60 * 1000);
    let ack: string | null = null;

    if (canNudge) {
      const phone = conv.callback?.phone;
      ack = phone
        ? `Our team has your request and will call you at ${formatPhone(phone)} as soon as possible. Need it sooner? Call us at ${CONTACT.phone}.`
        : `Our team has your message and will reply here as soon as possible. Need it sooner? Call us at ${CONTACT.phone}.`;
      conv.messages.push({ role: "assistant", content: ack, at: new Date() });
      conv.lastReplyAt = new Date();
      conv.callback = { ...(conv.callback || {}), lastFollowUpAt: new Date() };
      conv.markModified("callback");
    }
    trimAndSave(conv);
    await conv.save();

    if (canNudge) {
      const wantsCall = Boolean(conv.callback?.phone);
      void notifyGHL(wantsCall ? "ai_human_call_requested" : "ai_handoff_requested", {
        ...crmPayload(conv),
        action: wantsCall ? "human_call_requested" : "human_chat_requested",
        actionLabel: wantsCall ? "Human call requested (follow-up — customer asked again)" : "Human reply requested (follow-up)",
        followUp: true,
        humanRequested: "yes",
        callRequested: wantsCall ? "yes" : "no",
        callbackPhone: conv.callback?.phone || "",
        callbackPhoneFormatted: conv.callback?.phone ? formatPhone(conv.callback.phone) : "",
        callbackBestTime: conv.callback?.bestTime || "",
        callbackReason: conv.callback?.reason || conv.pausedReason || "",
        urgent: false,
        requestedAt: new Date().toISOString(),
        lastCustomerMessage: text,
        messageType: ghlMessageType(conv.channel) || "",
        reply: ack || "",
        handoff: true,
        handoffText: "yes"
      });
    }
    return { reply: ack, status: ack ? "replied" : "paused", handoff: true, stage: conv.stage, conversationId: String(conv._id) };
  }

  // Refresh the payment status of an open hold so the AI answers from the real state
  if (conv.hold?.bookingId && conv.hold.status === "awaiting_payment") {
    try {
      const status = await checkAiHoldPayment(conv.hold.bookingId);
      if (status !== conv.hold.status) {
        conv.hold.status = status;
        conv.markModified("hold");
      }
    } catch (err: any) {
      logger.warn("[AI] hold refresh failed", { error: err?.message });
    }
  }

  const st: TurnState = { conv, toolsUsed: [] };
  let reply: string | null = null;
  let status: AssistantResult["status"] = "replied";

  if (!isGroqConfigured()) {
    reply = fallbackReply();
    status = "fallback";
  } else {
    try {
      reply = await runModel(conv, st);
    } catch (err: any) {
      logger.error("[AI] model failed", { contactId: conv.contactId, error: err?.message });
      reply = fallbackReply();
      status = "fallback";
    }
  }

  const prevStage = conv.stage;
  if (st.stage) conv.stage = st.stage;
  else if (prevStage === "new") conv.stage = "collecting_details";

  if (st.handoff) {
    conv.aiPaused = true;
    conv.pausedReason = st.handoff.reason;
    conv.pausedAt = new Date();
    conv.pausedBy = "ai";
  }

  if (reply) {
    conv.messages.push({ role: "assistant", content: reply, at: new Date() });
    conv.lastReplyAt = new Date();
  }
  trimAndSave(conv);
  await conv.save();

  // CRM + staff notifications (fire-and-forget)
  if (st.handoff) {
    const h = st.handoff;
    const wantsCall = Boolean(h.phone);
    void (async () => {
      // Save the number on the GHL contact first, so the call workflow dials the right phone
      if (h.phone) await updateContactPhone(conv.contactId, h.phone);
      await addContactTags(conv.contactId, ["AI Handoff", ...(wantsCall ? ["Call Requested"] : []), ...(h.urgent ? ["Urgent"] : [])]);
      await notifyGHL(wantsCall ? "ai_human_call_requested" : "ai_handoff_requested", {
        ...crmPayload(conv),
        // ---- the fields the GHL workflow branches on
        action: wantsCall ? "human_call_requested" : "human_chat_requested",
        actionLabel: wantsCall ? "Human call requested" : "Human reply requested (chat)",
        humanRequested: "yes",
        callRequested: wantsCall ? "yes" : "no",
        callbackPhone: h.phone || "",
        callbackPhoneFormatted: h.phone ? formatPhone(h.phone) : "",
        callbackBestTime: h.bestTime || "",
        callbackReason: h.reason,
        urgent: h.urgent,
        requestedAt: new Date().toISOString(),
        lastCustomerMessage: text,
        // same shape as the AI reply payload on this webhook
        messageType: ghlMessageType(conv.channel) || "",
        reply: reply || "",
        handoff: true,
        handoffText: "yes"
      });
    })().catch((err) => logger.error("[AI] handoff notify failed", { error: err?.message }));
  } else if (conv.stage !== prevStage) {
    void notifyGHL("ai_inquiry_update", crmPayload(conv));
  }

  return {
    reply,
    status,
    handoff: Boolean(st.handoff),
    stage: conv.stage,
    conversationId: String(conv._id),
    toolsUsed: st.toolsUsed
  };
};

const trimAndSave = (conv: IAiConversation) => {
  if (conv.messages.length > STORED_MESSAGES_LIMIT) {
    conv.messages.splice(0, conv.messages.length - STORED_MESSAGES_LIMIT);
  }
};

const STAGE_LABELS: Record<AiInquiryStage, string> = {
  new: "New Social Inquiry",
  collecting_details: "Booking Details Being Collected",
  availability_checked: "Availability Checked",
  link_shared: "Booking Link Shared",
  human_required: "Human Assistance Required",
  closed: "Closed"
};

const crmPayload = (conv: IAiConversation) => {
  const i = conv.inquiry || {};
  return {
    contactId: conv.contactId,
    channel: conv.channel,
    contactName: conv.contactName || "",
    stage: conv.stage,
    stageLabel: STAGE_LABELS[conv.stage],
    inquiryType: i.bookingType || "",
    inquiryDate: i.date || "",
    inquiryDateFormatted: i.date ? prettyDate(i.date) : "",
    inquiryTime: i.startTime ? to12h(i.startTime) : "",
    inquiryGuests: i.guests || "",
    inquiryHours: i.durationHours || "",
    inquiryOccasion: i.occasion || "",
    lastAvailability: conv.lastCheck?.summary || "",
    inquirySummary: `Social inquiry (${conv.channel}): ${knownDetails(conv)}. Stage: ${STAGE_LABELS[conv.stage]}.${conv.lastCheck?.summary ? ` Last check: ${conv.lastCheck.summary}` : ""}`
  };
};

const AVAILABILITY_CLAIM =
  /\b(is|are|it's|it is|still|looks|showing|currently)\s+(wide\s+)?(open|available|free|booked|taken|unavailable)\b|\b(is free|have availability|not available|fully booked|we can do (?:that|it))\b|\b(?:that|this) (?:time |date |slot )?works\b(?! for you)|\b\d{1,2}(:\d{2})?\s*(am|pm)\b[^.?!]{0,25}\b(works|is fine|is good|is perfect)\b/i;
const claimsAvailability = (text: string) => AVAILABILITY_CLAIM.test(text);
const checkedThisTurn = (st: TurnState) =>
  st.toolsUsed.some((t) => t === "check_venue_availability" || t === "check_table_availability" || t === "find_open_venue_dates");

const runModel = async (conv: IAiConversation, st: TurnState): Promise<string> => {
  const history: ChatMessage[] = conv.messages.slice(-HISTORY_LIMIT).map((x) =>
    x.role === "user"
      ? { role: "user", content: x.content }
      : { role: "assistant", content: x.role === "staff" ? `(Tropica team member wrote:) ${x.content}` : x.content }
  );
  const messages: ChatMessage[] = [{ role: "system", content: await buildSystemPrompt(conv) }, ...history];

  let guardUsed = false;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await groqChat(messages, activeTools());
    if (!res.toolCalls.length) {
      const text = cleanReply(res.content || "");
      if (!text) break;
      // Hard guard: a claim about availability must come from a live check made in this turn
      if (claimsAvailability(text) && !checkedThisTurn(st) && !guardUsed) {
        guardUsed = true;
        messages.push({ role: "assistant", content: text });
        messages.push({
          role: "user",
          content:
            "[SYSTEM, not the customer] Your draft states availability without a live check this turn. Rewrite: call check_venue_availability / check_table_availability first, or if the date is unknown just ask for it. Do not assume a guest count. Reply with the corrected message only."
        });
        continue;
      }
      return text;
    }
    messages.push({ role: "assistant", content: res.content ?? null, tool_calls: res.toolCalls });
    for (const call of res.toolCalls) {
      const out = await runTool(call.function.name, call.function.arguments, st);
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(out) });
    }
  }

  // Out of tool rounds (or empty answer): ask once more without tools for a final message
  const final = await groqChat(messages, undefined, { maxTokens: 1200 });
  const text = cleanReply(final.content || "");
  if (!text) throw new Error("Empty model reply");
  return text;
};

// ---------------------------------------------------------------------------------------------
// Staff controls
// ---------------------------------------------------------------------------------------------

export const setAiPaused = async (contactId: string, paused: boolean, by = "staff", reason?: string) => {
  const conv = await AiConversation.findOneAndUpdate(
    { contactId },
    paused
      ? { $set: { aiPaused: true, pausedAt: new Date(), pausedBy: by, pausedReason: reason || "Staff took over", stage: "human_required" } }
      : { $set: { aiPaused: false, stage: "collecting_details" }, $unset: { pausedAt: 1, pausedBy: 1, pausedReason: 1 } },
    { returnDocument: "after", upsert: paused }
  );
  return conv;
};

/** Record a message a staff member sent manually, so the AI has that context when it resumes. */
export const recordStaffMessage = async (contactId: string, text: string) => {
  await AiConversation.updateOne(
    { contactId },
    { $push: { messages: { $each: [{ role: "staff", content: text.slice(0, 2000), at: new Date() }], $slice: -STORED_MESSAGES_LIMIT } } }
  );
};
