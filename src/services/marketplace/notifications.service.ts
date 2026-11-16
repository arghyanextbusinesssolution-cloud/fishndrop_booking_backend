import nodemailer from "nodemailer";
import logger from "../../config/logger";
import { getFrontendBaseUrl } from "../../utils/siteUrl";
import type { IMarketplaceBooking } from "../../models/MarketplaceBooking";
import type { IPartnerVenue } from "../../models/PartnerVenue";

/**
 * Marketplace emails (Gmail SMTP, same credentials as utils/email.utils.ts).
 * Every send is fire-and-forget: failures are logged, never thrown to the request.
 */

let transporter: nodemailer.Transporter | null = null;
const getTransporter = () => {
  if (!process.env.GMAIL_NAME || !process.env.GMAIL_PASSWORD) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: process.env.GMAIL_NAME, pass: process.env.GMAIL_PASSWORD }
    });
  }
  return transporter;
};

const escape = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const money = (n: number) => `$${(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const layout = (venue: { name: string; theme?: { primary?: string } }, title: string, body: string, cta?: { label: string; url: string }) => {
  const accent = venue.theme?.primary || "#C8A96A";
  return `<!DOCTYPE html><html><body style="margin:0;background:#f4f4f2;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1c1b">
  <table align="center" width="100%" style="max-width:600px;margin:32px auto;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e6e4df">
    <tr><td style="padding:24px 28px;border-top:6px solid ${accent}">
      <p style="margin:0;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:#777">Tropica NYC · ${escape(venue.name)}</p>
      <h1 style="margin:8px 0 0;font-size:22px">${escape(title)}</h1>
    </td></tr>
    <tr><td style="padding:0 28px 24px;font-size:14px;line-height:22px">${body}
      ${cta ? `<p style="text-align:center;margin:28px 0 8px"><a href="${cta.url}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;font-weight:700;padding:12px 28px;border-radius:40px">${escape(cta.label)}</a></p>` : ""}
    </td></tr>
  </table></body></html>`;
};

const detailsTable = (b: IMarketplaceBooking) => `
  <table style="width:100%;border-collapse:collapse;margin:12px 0;font-size:14px">
    <tr><td style="padding:4px 0;color:#777">Request</td><td style="text-align:right">${escape(b.bookingNumber)}</td></tr>
    <tr><td style="padding:4px 0;color:#777">Date</td><td style="text-align:right">${escape(b.date)}</td></tr>
    <tr><td style="padding:4px 0;color:#777">Time</td><td style="text-align:right">${escape(b.startTime)} – ${escape(b.endTime)} (${b.durationHours}h)</td></tr>
    <tr><td style="padding:4px 0;color:#777">Guests</td><td style="text-align:right">${b.guests}</td></tr>
    ${b.packageName ? `<tr><td style="padding:4px 0;color:#777">Package</td><td style="text-align:right">${escape(b.packageName)}</td></tr>` : ""}
    ${b.occasion ? `<tr><td style="padding:4px 0;color:#777">Occasion</td><td style="text-align:right">${escape(b.occasion)}</td></tr>` : ""}
  </table>`;

const send = async (to: string | undefined, subject: string, html: string) => {
  if (!to) return;
  const t = getTransporter();
  if (!t) {
    logger.warn(`[MARKETPLACE EMAIL] SMTP not configured — would send "${subject}" to ${to}`);
    return;
  }
  try {
    await t.sendMail({ from: `"Tropica NYC" <${process.env.GMAIL_NAME}>`, to, subject, html });
  } catch (err: any) {
    logger.error(`[MARKETPLACE EMAIL] Failed "${subject}" → ${to}`, { error: err.message });
  }
};

const staffInbox = () => process.env.MARKETPLACE_ADMIN_EMAIL || process.env.ADMIN_EMAIL;

/** New request → venue owner (must respond), customer (receipt), Sarah (FYI). */
export const notifyRequestCreated = (booking: IMarketplaceBooking, venue: IPartnerVenue) => {
  const base = getFrontendBaseUrl();
  void send(
    venue.ownerEmail,
    `New booking request ${booking.bookingNumber} — please confirm availability`,
    layout(
      venue,
      "New booking request",
      `<p>${escape(booking.customerName)} would like to book <strong>${escape(venue.name)}</strong>.</p>${detailsTable(booking)}
       <p>Your payout for this booking: <strong>${money(booking.venuePayout)}</strong>.</p>
       <p>Please confirm or decline this request in your partner portal.</p>`,
      { label: "Review request", url: `${base}/partner-portal/requests` }
    )
  );
  void send(
    booking.customerEmail,
    `We received your request for ${venue.name}`,
    layout(
      venue,
      "Request received",
      `<p>Hi ${escape(booking.customerName)}, thanks for your request. We're checking availability with ${escape(venue.name)}.
       Once it's confirmed you'll get a payment link to secure your date.</p>${detailsTable(booking)}
       <p>Estimated total: <strong>${money(booking.customerPrice)}</strong> (deposit ${money(booking.depositAmount)}).</p>`,
      { label: "View my request", url: `${base}/user/marketplace-bookings` }
    )
  );
  void send(
    staffInbox(),
    `[Marketplace] New request ${booking.bookingNumber} — ${venue.name}`,
    layout(venue, "New marketplace request (FYI)", `<p>Awaiting the venue owner's response.</p>${detailsTable(booking)}`, {
      label: "Open requests",
      url: `${base}/admin/marketplace/requests`
    })
  );
};

/** Login details for a venue owner (new account or password reset). */
export const sendVenueOwnerCredentialsEmail = async (p: {
  ownerName: string;
  ownerEmail: string;
  password: string;
  venueName: string;
  isReset?: boolean;
}) => {
  const loginUrl = `${getFrontendBaseUrl()}/partner-login`;
  logger.info(`[MARKETPLACE] Venue owner login ${p.isReset ? "reset" : "created"} for ${p.ownerEmail} (${p.venueName})`);
  await send(
    p.ownerEmail,
    p.isReset ? `Your new Tropica partner login — ${p.venueName}` : `Welcome to Tropica NYC — your ${p.venueName} partner account`,
    layout(
      { name: p.venueName },
      p.isReset ? "Your password was reset" : `Welcome, ${p.ownerName}!`,
      `<p>${
        p.isReset
          ? "Here are your new login details for the Tropica partner portal."
          : `${escape(p.venueName)} is now set up on Tropica NYC. Customers will be able to discover and request your venue once it goes live.`
      }</p>
       <p>In your partner portal you can confirm booking requests, connect Stripe to get paid, and choose your venue's colors, logo and photos.</p>
       <table style="width:100%;margin:12px 0;font-size:14px;background:#f7f6f2;border-radius:10px;padding:12px">
         <tr><td style="padding:4px 8px;color:#777">Portal</td><td style="padding:4px 8px"><a href="${loginUrl}">${loginUrl}</a></td></tr>
         <tr><td style="padding:4px 8px;color:#777">Email</td><td style="padding:4px 8px">${escape(p.ownerEmail)}</td></tr>
         <tr><td style="padding:4px 8px;color:#777">Temporary password</td><td style="padding:4px 8px"><code>${escape(p.password)}</code></td></tr>
       </table>
       <p style="color:#777;font-size:12px">Please change your password after your first login.</p>`,
      { label: "Log in to partner portal", url: loginUrl }
    )
  );
};

/** Owner confirmed availability → customer gets the payment link. */
export const notifyRequestConfirmed = (booking: IMarketplaceBooking, venue: IPartnerVenue) => {
  const base = getFrontendBaseUrl();
  const expires = booking.paymentLinkExpiresAt
    ? booking.paymentLinkExpiresAt.toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" })
    : "";
  void send(
    booking.customerEmail,
    `Good news — ${venue.name} is available! Secure your date`,
    layout(
      venue,
      "Your date is available",
      `<p>Hi ${escape(booking.customerName)}, ${escape(venue.name)} confirmed they can host you.</p>${detailsTable(booking)}
       <p>Total: <strong>${money(booking.customerPrice)}</strong>. Pay <strong>${money(booking.depositAmount)}</strong> now to lock it in${
         booking.remainingAmount > 0 ? ` (balance of ${money(booking.remainingAmount)} due before your event)` : ""
       }.</p>
       ${expires ? `<p style="color:#b45309">This payment link expires ${escape(expires)} (New York time).</p>` : ""}`,
      { label: "Pay & confirm booking", url: `${base}/user/marketplace-bookings?pay=${booking._id}` }
    )
  );
  void send(
    staffInbox(),
    `[Marketplace] ${venue.name} confirmed ${booking.bookingNumber}`,
    layout(venue, "Venue confirmed availability (FYI)", `<p>The customer has been sent a payment link.</p>${detailsTable(booking)}`)
  );
};

/** Owner declined → customer is told and invited to pick another venue/date. */
export const notifyRequestDeclined = (booking: IMarketplaceBooking, venue: IPartnerVenue) => {
  const base = getFrontendBaseUrl();
  void send(
    booking.customerEmail,
    `${venue.name} isn't available for your date`,
    layout(
      venue,
      "This date isn't available",
      `<p>Hi ${escape(booking.customerName)}, unfortunately ${escape(venue.name)} can't host this booking.</p>${detailsTable(booking)}
       ${booking.declineReason ? `<p><em>“${escape(booking.declineReason)}”</em></p>` : ""}
       <p>Nothing was charged. Other Tropica venues may be free on your date.</p>`,
      { label: "See other venues", url: `${base}/book-venue` }
    )
  );
};

/** First payment succeeded → booking confirmed. Customer, venue owner and Sarah all hear about it. */
export const notifyBookingConfirmed = (booking: IMarketplaceBooking, venue: IPartnerVenue) => {
  const base = getFrontendBaseUrl();
  const balance =
    booking.remainingAmount > 0
      ? `<p>Paid today: <strong>${money(booking.amountPaid)}</strong>. Balance of <strong>${money(booking.remainingAmount)}</strong> is due before your event.</p>`
      : `<p>Paid in full: <strong>${money(booking.amountPaid)}</strong>.</p>`;
  void send(
    booking.customerEmail,
    `You're booked at ${venue.name}! 🎉`,
    layout(
      venue,
      "Your booking is confirmed",
      `<p>Hi ${escape(booking.customerName)}, ${escape(venue.name)} is reserved for you.</p>${detailsTable(booking)}${balance}
       <p>Address: ${escape(venue.address)}</p>
       <p><strong>Invite your guests:</strong> share your party link so everyone gets their own entry pass. Manage your guest list any time under <em>Celebrations</em>.</p>`,
      { label: "Invite your guests", url: `${base}/user/celebrations/${booking._id}?share=1` }
    )
  );
  void send(
    venue.ownerEmail,
    `Confirmed booking ${booking.bookingNumber} — ${booking.date}`,
    layout(
      venue,
      "A booking is confirmed",
      `<p>${escape(booking.customerName)} has paid and the time is now blocked on your calendar.</p>${detailsTable(booking)}
       <p>Customer: ${escape(booking.customerName)} · ${escape(booking.customerPhone)} · ${escape(booking.customerEmail)}</p>
       <p>Your payout for this booking: <strong>${money(booking.venuePayout)}</strong>.</p>`,
      { label: "Open bookings", url: `${base}/partner-portal/bookings` }
    )
  );
  void send(
    staffInbox(),
    `[Marketplace] Paid: ${booking.bookingNumber} — ${venue.name} (${money(booking.amountPaid)})`,
    layout(
      venue,
      "Marketplace booking paid",
      `${detailsTable(booking)}<p>Customer paid ${money(booking.amountPaid)} of ${money(booking.customerPrice)}. Tropica commission on this booking: ${money(booking.commission)}. Venue payout: ${money(booking.venuePayout)}.</p>`
    )
  );
};

/** Balance payment received. */
export const notifyBalancePaid = (booking: IMarketplaceBooking, venue: IPartnerVenue) => {
  void send(
    booking.customerEmail,
    `Balance received — ${venue.name} is fully paid`,
    layout(venue, "You're paid in full", `<p>Thanks ${escape(booking.customerName)} — nothing more to pay.</p>${detailsTable(booking)}`)
  );
  void send(
    venue.ownerEmail,
    `${booking.bookingNumber} is now paid in full`,
    layout(venue, "Booking paid in full", `${detailsTable(booking)}<p>Your payout: <strong>${money(booking.venuePayout)}</strong>.</p>`)
  );
};

/** Two customers paid for the same slot in the same moment — the later one is refunded. */
export const notifySlotLostRefund = (booking: IMarketplaceBooking, venue: IPartnerVenue) => {
  const base = getFrontendBaseUrl();
  void send(
    booking.customerEmail,
    `Sorry — ${venue.name} was just booked. You've been refunded`,
    layout(
      venue,
      "This time was just taken",
      `<p>Hi ${escape(booking.customerName)}, another customer completed their booking for this time moments before you. Your payment has been refunded in full (it can take 5–10 days to show).</p>${detailsTable(booking)}`,
      { label: "Pick another time", url: `${base}/book-venue` }
    )
  );
  void send(
    staffInbox(),
    `[Marketplace] Auto-refund: ${booking.bookingNumber} lost its slot`,
    layout(venue, "Double-booking prevented", `<p>Payment refunded automatically — please double-check in Stripe.</p>${detailsTable(booking)}`)
  );
};
