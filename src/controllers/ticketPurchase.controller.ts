import { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import Event from "../models/Event";
import TicketOrder, { generateOrderNumber } from "../models/TicketOrder";
import Ticket, { generateTicketCode, generateQrCodeToken } from "../models/Ticket";
import User from "../models/User";
import SystemSettings from "../models/SystemSettings";
import { getStripe } from "../utils/stripe.utils";
import { sendGHLTicketPurchasedEvent } from "../integrations/ghl";
import logger from "../config/logger";
import { SALES_CLOSE_MINUTES, isSalesClosed } from "../utils/eventTime.utils";
import crypto from "crypto";

const sanitizeString = (value: unknown): string =>
  typeof value === "string" ? value.trim().replace(/<[^>]*>/g, "") : "";

const getFrontendBaseUrl = (): string => {
  return process.env.FRONTEND_BASE_URL || "http://localhost:3000";
};

/**
 * POST /api/tickets/checkout
 * Public checkout endpoint to purchase event tickets.
 * Atomically reserves inventory and generates Stripe Checkout session.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const createTicketCheckout = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, code: "AUTH_REQUIRED", message: "Please sign in to book tickets" });
      return;
    }

    // Buyer identity comes from the OTP-verified account, never from free-form input
    const buyer = await User.findById(req.user._id);
    if (!buyer || !buyer.phone || !buyer.isPhoneVerified) {
      res.status(403).json({
        success: false,
        code: "PHONE_VERIFICATION_REQUIRED",
        message: "Please verify your mobile number to book tickets"
      });
      return;
    }

    const bodyName = sanitizeString(req.body.customerName);
    const bodyEmail = sanitizeString(req.body.customerEmail).toLowerCase();
    const savedName = buyer.name && buyer.name !== "Guest User" ? buyer.name : "";

    const customerName = bodyName || savedName;
    const customerEmail = bodyEmail || (buyer.email || "").toLowerCase();
    const customerPhone = buyer.phone;

    if (!customerName || !customerEmail) {
      res.status(400).json({
        success: false,
        code: "PROFILE_INCOMPLETE",
        message: "Please add your name and email so we can deliver your tickets"
      });
      return;
    }
    if (!EMAIL_RE.test(customerEmail)) {
      res.status(400).json({ success: false, message: "Please enter a valid email address" });
      return;
    }

    // Keep the buyer profile filled in for next time
    let profileChanged = false;
    if (bodyName && bodyName !== buyer.name) {
      buyer.name = bodyName;
      profileChanged = true;
    }
    if (bodyEmail && !buyer.email) {
      buyer.email = bodyEmail;
      profileChanged = true;
    }
    if (profileChanged) {
      await buyer.save().catch((err: any) => logger.warn("Could not update buyer profile", { error: err.message }));
    }

    const eventId = sanitizeString(req.body.eventId);
    const rawTiers = Array.isArray(req.body.selectedTiers) ? req.body.selectedTiers : [];

    if (!eventId) {
      res.status(400).json({ success: false, message: "Event ID is required" });
      return;
    }

    if (rawTiers.length === 0) {
      res.status(400).json({ success: false, message: "Please select at least one ticket" });
      return;
    }

    const event = await Event.findById(eventId).populate("promoter");
    if (!event) {
      res.status(404).json({ success: false, message: "Event not found" });
      return;
    }

    if (event.status !== "published") {
      res.status(400).json({ success: false, message: "Tickets are not currently on sale for this event" });
      return;
    }

    if (isSalesClosed(event)) {
      res.status(400).json({
        success: false,
        code: "SALES_CLOSED",
        message: `Ticket sales for this event closed ${SALES_CLOSE_MINUTES} minutes before the start time.`
      });
      return;
    }

    const promoter = event.promoter as any;

    // Validate inventory and prepare order items
    const orderItems: Array<{
      tierId: mongoose.Types.ObjectId;
      tierName: string;
      quantity: number;
      unitPrice: number;
      subtotal: number;
    }> = [];

    let totalTicketsCount = 0;
    let subtotal = 0;

    for (const reqTier of rawTiers) {
      const requestedQty = Math.floor(Number(reqTier.quantity) || 0);
      if (requestedQty <= 0) continue;

      const tier = event.ticketTiers.find((t: any) => t._id.toString() === String(reqTier.tierId));
      if (!tier) {
        res.status(400).json({ success: false, message: `Ticket tier not found` });
        return;
      }

      if (tier.salesDeadline && new Date() > new Date(tier.salesDeadline)) {
        res.status(400).json({ success: false, message: `Sales for tier '${tier.name}' have ended` });
        return;
      }

      const available = tier.quantity - tier.sold - tier.reserved;
      if (requestedQty > available) {
        res.status(400).json({
          success: false,
          message: `Only ${Math.max(0, available)} ticket(s) remaining for '${tier.name}'`
        });
        return;
      }

      const itemSubtotal = tier.price * requestedQty;
      subtotal += itemSubtotal;
      totalTicketsCount += requestedQty;

      orderItems.push({
        tierId: tier._id as mongoose.Types.ObjectId,
        tierName: tier.name,
        quantity: requestedQty,
        unitPrice: tier.price,
        subtotal: itemSubtotal
      });
    }

    if (orderItems.length === 0) {
      res.status(400).json({ success: false, message: "No valid tickets selected" });
      return;
    }

    // Atomically reserve inventory for each tier
    for (const item of orderItems) {
      // MongoDB only allows $expr at the top level (not inside $elemMatch), so the
      // availability check looks up the tier with $filter. `"ticketTiers._id"` in the
      // same filter drives the positional `$` in the update. Single atomic operation:
      // two buyers can never both take the last seats.
      const updateResult = await Event.updateOne(
        {
          _id: event._id,
          "ticketTiers._id": item.tierId,
          $expr: {
            $gte: [
              {
                $let: {
                  vars: {
                    tier: {
                      $arrayElemAt: [
                        { $filter: { input: "$ticketTiers", as: "t", cond: { $eq: ["$$t._id", item.tierId] } } },
                        0
                      ]
                    }
                  },
                  in: {
                    $subtract: [
                      { $ifNull: ["$$tier.quantity", 0] },
                      { $add: [{ $ifNull: ["$$tier.sold", 0] }, { $ifNull: ["$$tier.reserved", 0] }] }
                    ]
                  }
                }
              },
              item.quantity
            ]
          }
        },
        { $inc: { "ticketTiers.$.reserved": item.quantity } }
      );

      if (updateResult.modifiedCount === 0) {
        // Rollback any earlier reservations in this loop
        for (const prev of orderItems) {
          if (prev.tierId.toString() === item.tierId.toString()) break;
          await Event.updateOne(
            { _id: event._id, "ticketTiers._id": prev.tierId },
            { $inc: { "ticketTiers.$.reserved": -prev.quantity } }
          );
        }
        res.status(409).json({
          success: false,
          message: `Tickets for '${item.tierName}' were just reserved by another customer. Please retry.`
        });
        return;
      }
    }

    // Calculate Platform Service Fee
    const settings = await (SystemSettings as any).getSettings();
    const feePercent = event.feeOverridePercent ?? promoter?.platformFeeOverride ?? settings.platformFeePercent ?? 3.0;
    const fixedFee = event.fixedFeeOverride ?? settings.platformFixedFee ?? 0.0;
    const feeMode = event.feeModeOverride ?? settings.feeMode ?? "customer_paid";

    const platformFee = Math.round(((subtotal * feePercent) / 100 + fixedFee * totalTicketsCount) * 100) / 100;
    const totalAmount = feeMode === "customer_paid" ? Math.round((subtotal + platformFee) * 100) / 100 : subtotal;

    const orderNumber = generateOrderNumber();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15-minute hold

    const order = await TicketOrder.create({
      orderNumber,
      event: event._id,
      promoter: event.promoter,
      user: buyer._id,
      customerName,
      customerEmail,
      customerPhone,
      items: orderItems,
      subtotal,
      platformFee,
      totalAmount,
      status: "pending",
      expiresAt
    });

    const stripe = getStripe();
    const baseUrl = getFrontendBaseUrl();

    const orderPayload = {
      orderId: order._id.toString(),
      orderNumber: order.orderNumber,
      subtotal,
      platformFee,
      totalAmount,
      expiresAt: expiresAt.toISOString()
    };

    if (!stripe) {
      // In dev simulator mode if Stripe is not set
      res.status(200).json({
        success: true,
        ...orderPayload,
        checkoutUrl: `${baseUrl}/tickets/success?order_id=${order._id}&simulated=true`,
        isSimulated: true
      });
      return;
    }

    // Embedded Stripe payment (same flow as venue booking): PaymentIntent + PaymentElement
    const eventDateLabel = new Date(event.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const intentParams: any = {
      amount: Math.round(totalAmount * 100),
      currency: "usd",
      automatic_payment_methods: { enabled: true },
      receipt_email: customerEmail,
      description: `${event.title} (${eventDateLabel}) — ${totalTicketsCount} ticket(s) — ${order.orderNumber}`,
      metadata: {
        type: "event_ticket",
        orderId: order._id.toString(),
        orderNumber: order.orderNumber,
        eventId: event._id.toString(),
        customerName,
        customerPhone
      }
    };

    // Stripe Connect fee routing: funds go to the promoter, Tropica keeps the platform fee.
    // Ask Stripe live: the cached DB flag can lag behind onboarding (webhook / status-page sync).
    let promoterCanReceive = Boolean(promoter?.chargesEnabled);
    if (promoter?.stripeConnectAccountId && !String(promoter.stripeConnectAccountId).startsWith("acct_test_")) {
      try {
        const acct = await stripe.accounts.retrieve(promoter.stripeConnectAccountId);
        promoterCanReceive = Boolean(acct.charges_enabled && acct.capabilities?.transfers === "active");
        if (promoterCanReceive !== Boolean(promoter.chargesEnabled) || acct.payouts_enabled !== promoter.payoutsEnabled) {
          await User.updateOne(
            { _id: promoter._id },
            {
              $set: {
                chargesEnabled: promoterCanReceive,
                payoutsEnabled: acct.payouts_enabled,
                stripeConnectOnboarded: acct.details_submitted
              }
            }
          );
        }
      } catch (err: any) {
        logger.warn("Could not verify promoter Stripe account; using cached status", {
          account: promoter.stripeConnectAccountId,
          error: err.message
        });
      }
    }
    if (!promoterCanReceive) {
      logger.warn(
        `[TICKET CHECKOUT] Promoter Stripe account not ready; full payment for ${order.orderNumber} stays with the platform`,
        { promoterId: String(promoter?._id || ""), account: promoter?.stripeConnectAccountId || null }
      );
    }
    if (promoter?.stripeConnectAccountId && promoterCanReceive) {
      intentParams.application_fee_amount = Math.round(platformFee * 100);
      intentParams.transfer_data = { destination: promoter.stripeConnectAccountId };
      order.stripeConnectAccountId = promoter.stripeConnectAccountId;
    }

    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.create(intentParams, {
        idempotencyKey: `ticket-order-${order._id}`
      });
    } catch (stripeErr: any) {
      // Don't leave seats on hold for 15 minutes if Stripe rejected the request
      await releaseOrderReservation(order._id.toString(), "failed");
      throw stripeErr;
    }

    order.stripePaymentIntentId = paymentIntent.id;
    await order.save();

    console.log(
      `🛒 [TICKET CHECKOUT STARTED] ${order.orderNumber} | ${event.title} | ${customerName} (${customerPhone}) | ` +
        `${totalTicketsCount} ticket(s) | $${totalAmount.toFixed(2)} | status=PENDING | hold until ${expiresAt.toISOString()}`
    );

    res.status(200).json({
      success: true,
      ...orderPayload,
      clientSecret: paymentIntent.client_secret
    });
  } catch (error: any) {
    logger.error("Ticket checkout session error", { error: error.message });
    next(new Error(`Failed to create ticket checkout session: ${error.message}`));
  }
};

/**
 * Helper to fulfill a verified ticket order, update inventory, and issue individual QR tickets.
 * Guaranteed idempotent.
 */
/**
 * Atomically moves a PENDING order to `status` and gives its held seats back to inventory.
 * Safe to call repeatedly / concurrently — only the caller that flips the status releases seats.
 */
export const releaseOrderReservation = async (
  orderId: string,
  status: "failed" | "cancelled"
): Promise<boolean> => {
  const order = await TicketOrder.findOneAndUpdate(
    { _id: orderId, status: "pending" },
    { $set: { status } },
    { returnDocument: "after" }
  );
  if (!order) return false;
  for (const item of order.items) {
    await Event.updateOne(
      { _id: order.event, "ticketTiers._id": item.tierId },
      { $inc: { "ticketTiers.$.reserved": -item.quantity } }
    );
  }
  logger.info(`[Tickets] Released hold for order ${order.orderNumber} (${status})`);
  return true;
};

/**
 * POST /api/tickets/cancel-order
 * Buyer closed the payment popup — release the held seats and cancel the PaymentIntent.
 */
export const cancelTicketOrder = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const orderId = sanitizeString(req.body.orderId);
    if (!req.user || !/^[a-f0-9]{24}$/i.test(orderId)) {
      res.status(400).json({ success: false, message: "Valid orderId is required" });
      return;
    }

    const order = await TicketOrder.findById(orderId);
    if (!order || String(order.user) !== req.user._id.toString()) {
      res.status(404).json({ success: false, message: "Order not found" });
      return;
    }
    if (order.status !== "pending") {
      res.status(200).json({ success: true, status: order.status });
      return;
    }

    const stripe = getStripe();
    if (stripe && order.stripePaymentIntentId) {
      const intent = await stripe.paymentIntents.retrieve(order.stripePaymentIntentId);
      if (intent.status === "succeeded") {
        // Paid moments before closing — fulfil instead of cancelling
        await fulfillTicketOrder(orderId, intent.id);
        res.status(200).json({ success: true, status: "paid" });
        return;
      }
      if (intent.status !== "canceled" && intent.status !== "processing") {
        await stripe.paymentIntents.cancel(intent.id).catch((e: any) =>
          logger.warn("Could not cancel PaymentIntent", { error: e.message })
        );
      }
    }

    await releaseOrderReservation(orderId, "cancelled");
    res.status(200).json({ success: true, status: "cancelled" });
  } catch (error: any) {
    next(new Error(`Failed to cancel ticket order: ${error.message}`));
  }
};

/** Prints a clear payment receipt in the backend console (visible in every log level). */
const logPaymentCompleted = (order: any, event: any, tickets: any[], txnId?: string) => {
  const line = "═".repeat(64);
  const statusCounts = tickets.reduce((acc: Record<string, number>, t: any) => {
    acc[t.status] = (acc[t.status] || 0) + 1;
    return acc;
  }, {});
  console.log(`\n${line}`);
  console.log(`✅ [TICKET PAYMENT COMPLETED]`);
  console.log(`   Order        : ${order.orderNumber} (${order._id})`);
  console.log(`   Event        : ${event?.title} — ${event?.date ? new Date(event.date).toDateString() : ""}`);
  console.log(`   Buyer        : ${order.customerName} | ${order.customerPhone} | ${order.customerEmail}`);
  for (const item of order.items) {
    console.log(`   Tier         : ${item.tierName} × ${item.quantity} @ $${Number(item.unitPrice).toFixed(2)} = $${Number(item.subtotal).toFixed(2)}`);
  }
  console.log(`   Subtotal     : $${Number(order.subtotal).toFixed(2)}`);
  console.log(`   Service fee  : $${Number(order.platformFee).toFixed(2)}`);
  console.log(`   AMOUNT PAID  : $${Number(order.totalAmount).toFixed(2)} ${String(order.currency || "usd").toUpperCase()}`);
  console.log(`   Payment ref  : ${txnId || order.stripePaymentIntentId || "n/a"}`);
  console.log(`   Order status : ${order.status.toUpperCase()}`);
  console.log(`   Tickets      : ${tickets.length} issued — ${Object.entries(statusCounts).map(([s, n]) => `${n} ${s}`).join(", ")}`);
  for (const t of tickets) {
    console.log(`     • ${t.ticketCode} [${t.tierName}] status=${t.status} checkedIn=${t.checkedIn}`);
  }
  console.log(`${line}\n`);
};

export const fulfillTicketOrder = async (orderId: string, txnId?: string): Promise<any> => {
  const existing = await TicketOrder.findById(orderId);
  if (!existing) throw new Error("Order not found");

  // Atomic state transition: only ONE caller (Stripe webhook or success page) may fulfil.
  const previousStatus = existing.status;
  const order = await TicketOrder.findOneAndUpdate(
    { _id: existing._id, status: { $in: ["pending", "failed"] } },
    {
      $set: {
        status: "paid",
        paidAt: new Date(),
        ...(txnId ? { stripePaymentIntentId: txnId } : {})
      }
    },
    { returnDocument: "after" }
  );

  if (!order) {
    // Already fulfilled (or refunded/cancelled) by another caller. If that caller is still
    // issuing tickets right now, wait briefly so the success page never shows an empty pass list.
    const current = await TicketOrder.findById(orderId).populate("event");
    const expected = (current?.items || []).reduce((sum, i) => sum + i.quantity, 0);
    let existingTickets = await Ticket.find({ order: orderId });
    for (let i = 0; current?.status === "paid" && existingTickets.length < expected && i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      existingTickets = await Ticket.find({ order: orderId });
    }
    return { order: current, tickets: existingTickets };
  }

  const event = await Event.findById(order.event);
  if (!event) throw new Error("Event not found");

  // Inventory: pending orders hold a reservation; "failed" (expired) orders already released theirs.
  const releaseReservation = previousStatus === "pending";
  for (const item of order.items) {
    await Event.updateOne(
      { _id: event._id, "ticketTiers._id": item.tierId },
      {
        $inc: {
          "ticketTiers.$.sold": item.quantity,
          ...(releaseReservation ? { "ticketTiers.$.reserved": -item.quantity } : {})
        }
      }
    );
  }

  // Create individual Ticket records with unique codes & QR tokens
  const createdTickets = [];
  for (const item of order.items) {
    for (let i = 0; i < item.quantity; i++) {
      const ticket = await Ticket.create({
        ticketCode: generateTicketCode(),
        order: order._id,
        event: event._id,
        promoter: event.promoter,
        user: order.user,
        tierId: item.tierId,
        tierName: item.tierName,
        price: item.unitPrice,
        customerName: order.customerName,
        customerEmail: order.customerEmail,
        customerPhone: order.customerPhone,
        qrCodeToken: generateQrCodeToken(),
        status: "valid",
        checkedIn: false
      });
      createdTickets.push(ticket);
    }
  }

  logPaymentCompleted(order, event, createdTickets, txnId);
  logger.info(`Issued ${createdTickets.length} QR ticket(s) for order ${order.orderNumber}`);

  // GHL: customer confirmation + promoter & admin sale alerts (fire-and-forget)
  void (async () => {
    const [promoter, admins, fresh] = await Promise.all([
      User.findById(order.promoter || event?.promoter).select("name email phone companyName").lean(),
      User.find({ role: { $in: ["admin", "owner"] } }).select("name email phone").sort({ createdAt: 1 }).lean(),
      Event.findById(order.event).select("ticketTiers").lean()
    ]);
    const tiers: any[] = (fresh as any)?.ticketTiers || [];
    await sendGHLTicketPurchasedEvent(order, event, createdTickets, {
      promoter,
      admins,
      eventTicketsSold: tiers.reduce((s, t) => s + (t.sold || 0), 0),
      eventCapacity: tiers.reduce((s, t) => s + (t.quantity || 0), 0)
    });
  })().catch((err) => logger.error("[GHL] ticket_purchased context failed", { error: err.message }));

  await order.populate("event");
  return { order, tickets: createdTickets };
};

/**
 * POST /api/tickets/verify-order
 * Verified checkout confirmation called by the success landing page.
 */
export const verifyTicketOrder = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const orderId = sanitizeString(req.body.orderId);
    const sessionId = sanitizeString(req.body.sessionId);

    if (!orderId) {
      res.status(400).json({ success: false, message: "orderId is required" });
      return;
    }

    const order = await TicketOrder.findById(orderId).populate("event");
    if (!order) {
      res.status(404).json({ success: false, message: "Order not found" });
      return;
    }

    const stripe = getStripe();
    let isPaymentVerified = false;
    let paymentIntentId = "";

    const expectedCents = Math.round(order.totalAmount * 100);

    if (order.status === "paid") {
      isPaymentVerified = true;
    } else if (stripe && order.stripePaymentIntentId && !order.stripeCheckoutSessionId) {
      // Embedded payment: trust only the PaymentIntent stored server-side for THIS order
      const intent = await stripe.paymentIntents.retrieve(order.stripePaymentIntentId);
      if (
        intent.status === "succeeded" &&
        intent.metadata?.orderId === order._id.toString() &&
        intent.amount_received >= expectedCents
      ) {
        isPaymentVerified = true;
        paymentIntentId = intent.id;
      } else if (intent.status === "processing") {
        res.status(202).json({ success: false, code: "PAYMENT_PROCESSING", message: "Your payment is processing. Tickets will be issued as soon as it clears." });
        return;
      }
    } else if (stripe && sessionId) {
      // Legacy hosted Checkout orders
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session && session.payment_status === "paid" && session.metadata?.orderId === order._id.toString()) {
        isPaymentVerified = true;
        paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.id;
      }
    } else if (!stripe && process.env.NODE_ENV !== "production") {
      // Dev simulator only: no Stripe keys configured and not running in production.
      // (Previously `simulated=true` from the client issued free tickets even in production.)
      isPaymentVerified = true;
      paymentIntentId = `sim_pi_${orderId.slice(-8)}`;
    }

    if (!isPaymentVerified) {
      res.status(400).json({
        success: false,
        message: "Payment could not be verified yet. Please check again in a few moments."
      });
      return;
    }

    const { tickets } = await fulfillTicketOrder(order._id.toString(), paymentIntentId);
    const pass = await TicketOrder.findById(order._id).select("qrMode groupQrToken").lean();

    res.status(200).json({
      success: true,
      message: "Payment verified and tickets issued successfully",
      order: {
        orderId: order._id,
        orderNumber: order.orderNumber,
        customerName: order.customerName,
        customerEmail: order.customerEmail,
        totalAmount: order.totalAmount,
        status: "paid",
        qrMode: pass?.qrMode || null,
        groupQrToken: pass?.qrMode === "group" ? pass.groupQrToken : null
      },
      event: order.event,
      tickets: tickets.map((t: any) => ({
        ticketCode: t.ticketCode,
        tierName: t.tierName,
        customerName: t.customerName,
        qrCodeToken: t.qrCodeToken,
        status: t.status,
        checkedIn: t.checkedIn
      }))
    });
  } catch (error: any) {
    logger.error("Ticket verification error", { error: error.message });
    next(new Error(`Failed to verify ticket order: ${error.message}`));
  }
};

/**
 * GET /api/tickets/qr/:qrToken
 * Public endpoint to fetch ticket details for customer's digital pass or QR verification.
 */
export const getTicketByQrToken = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const qrToken = sanitizeString(req.params.qrToken);
    const ticket = await Ticket.findOne({ qrCodeToken: qrToken }).populate("event");

    if (!ticket) {
      res.status(404).json({ success: false, message: "Ticket not found or invalid QR code" });
      return;
    }

    res.status(200).json({ success: true, ticket });
  } catch (error: any) {
    next(new Error(`Failed to fetch ticket: ${error.message}`));
  }
};


/**
 * GET /api/tickets/my
 * Tickets owned by the signed-in buyer (linked via account, or matching their verified phone).
 */
export const getMyTickets = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }
    const me = await User.findById(req.user._id).select("phone isPhoneVerified").lean();
    const or: any[] = [{ user: req.user._id }];
    if (me?.phone && me.isPhoneVerified) or.push({ customerPhone: me.phone });

    const tickets = await Ticket.find({ $or: or, status: { $in: ["valid", "used"] } })
      .populate("event", "title slug date startTime endTime venueName venueAddress flyerUrl status")
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    const orders = await TicketOrder.find({ _id: { $in: [...new Set(tickets.map((t: any) => String(t.order)))] } })
      .select("orderNumber qrMode groupQrToken")
      .lean();
    const orderById = new Map(orders.map((o: any) => [String(o._id), o]));

    res.status(200).json({
      success: true,
      tickets: tickets.map((t: any) => ({
        orderId: String(t.order),
        orderNumber: orderById.get(String(t.order))?.orderNumber,
        qrMode: orderById.get(String(t.order))?.qrMode || "individual",
        groupQrToken:
          orderById.get(String(t.order))?.qrMode === "group" ? orderById.get(String(t.order))?.groupQrToken : null,
        _id: t._id,
        ticketCode: t.ticketCode,
        tierName: t.tierName,
        price: t.price,
        customerName: t.customerName,
        qrCodeToken: t.qrCodeToken,
        status: t.status,
        checkedIn: t.checkedIn,
        checkedInAt: t.checkedInAt,
        createdAt: t.createdAt,
        event: t.event
      }))
    });
  } catch (error: any) {
    next(new Error(`Failed to fetch your tickets: ${error.message}`));
  }
};

const generateGroupQrToken = () => `grp_${crypto.randomBytes(24).toString("hex")}`;

/**
 * POST /api/tickets/orders/:orderId/qr-mode   { mode: "individual" | "group" }
 * Buyer chooses one group QR for the whole order or a separate QR per ticket.
 * Either way each ticket keeps its own check-in state, so nobody can be admitted twice.
 */
export const setOrderQrMode = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, message: "Please sign in" });
      return;
    }
    const orderId = sanitizeString(req.params.orderId);
    const mode = req.body.mode === "group" ? "group" : req.body.mode === "individual" ? "individual" : null;
    if (!/^[a-f0-9]{24}$/i.test(orderId) || !mode) {
      res.status(400).json({ success: false, message: "Invalid request" });
      return;
    }

    const order = await TicketOrder.findById(orderId);
    if (!order || order.status !== "paid") {
      res.status(404).json({ success: false, message: "Paid order not found" });
      return;
    }
    const me = await User.findById(req.user._id).select("phone isPhoneVerified").lean();
    const owns =
      String(order.user || "") === String(req.user._id) ||
      (!!me?.isPhoneVerified && !!me.phone && me.phone === order.customerPhone);
    if (!owns) {
      res.status(403).json({ success: false, message: "This order belongs to another account" });
      return;
    }

    order.qrMode = mode;
    if (mode === "group" && !order.groupQrToken) order.groupQrToken = generateGroupQrToken();
    await order.save();

    res.status(200).json({
      success: true,
      qrMode: order.qrMode,
      groupQrToken: order.qrMode === "group" ? order.groupQrToken : null
    });
  } catch (error: any) {
    next(new Error(`Failed to update QR preference: ${error.message}`));
  }
};

/**
 * GET /api/tickets/group/:token
 * Public group pass: one QR that admits every ticket in the order.
 */
export const getGroupPass = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const token = sanitizeString(req.params.token);
    if (!/^grp_[a-f0-9]{48}$/.test(token)) {
      res.status(404).json({ success: false, message: "Group pass not found" });
      return;
    }
    const order = await TicketOrder.findOne({ groupQrToken: token, status: "paid" })
      .populate("event", "title slug date startTime endTime venueName venueAddress venueType venueLat venueLng flyerUrl")
      .lean();
    if (!order || order.qrMode !== "group") {
      res.status(404).json({ success: false, message: "Group pass not found or switched to individual QR codes" });
      return;
    }
    const tickets = await Ticket.find({ order: order._id, status: { $in: ["valid", "used"] } })
      .select("ticketCode tierName checkedIn checkedInAt")
      .lean();

    res.status(200).json({
      success: true,
      pass: {
        groupQrToken: token,
        orderNumber: order.orderNumber,
        customerName: order.customerName,
        event: order.event,
        total: tickets.length,
        checkedIn: tickets.filter((t) => t.checkedIn).length,
        tickets: tickets.map((t) => ({ ticketCode: t.ticketCode, tierName: t.tierName, checkedIn: t.checkedIn, checkedInAt: t.checkedInAt }))
      }
    });
  } catch (error: any) {
    next(new Error(`Failed to load group pass: ${error.message}`));
  }
};
