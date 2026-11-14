/**
 * End-to-end test of booking from a DM (real DB + Groq + Stripe TEST mode, GHL disabled).
 * Creates a hold, prints the payment link, then releases the hold so nothing stays blocked.
 *   npx ts-node src/scripts/testAiBooking.ts
 */
import dotenv from "dotenv";
dotenv.config();
process.env.GHL_WEBHOOKS_ENABLED = "false";
process.env.GHL_API_TOKEN = "";
import mongoose from "mongoose";
import connectDB from "../config/db";
import AiConversation from "../models/AiConversation";
import Booking from "../models/Booking";
import SlotLock from "../models/SlotLock";
import { processInboundMessage } from "../ai/assistant.service";
import { cancelAiHold } from "../ai/aiBooking";

const run = async () => {
  await connectDB();
  const contactId = `cli-book-${Date.now()}`;
  const say = async (text: string) => {
    const r = await processInboundMessage({
      contactId,
      channel: "instagram",
      text,
      contactName: "Maria Lopez",
      contactEmail: "maria.lopez.test@example.com"
    });
    console.log(`\nCUSTOMER: ${text}\nAI: ${r.reply}\n   [${r.status} · ${r.stage} · tools=${(r.toolsUsed || []).join(",") || "-"}]`);
  };

  const msgs = process.argv.slice(2).length
    ? process.argv.slice(2)
    : [
        "Hi can I book the venue on February 10 2027 at 7pm for 20 people?",
        "yes book it for me",
        "my number is 917 555 0142",
        "yes lock it in"
      ];
  for (const m of msgs) await say(m);

  const conv: any = await AiConversation.findOne({ contactId }).lean();
  console.log("\nHOLD:", JSON.stringify(conv?.hold || null));
  if (conv?.hold?.bookingId) {
    const b: any = await Booking.findById(conv.hold.bookingId).lean();
    const locks = await SlotLock.countDocuments({ eventId: b._id });
    console.log(
      `BOOKING: ${b.status}/${b.paymentStatus} ${b.bookingDate.toISOString().slice(0, 10)} ${b.bookingTime} ${b.durationHours}h guests=${b.partySize} total=$${b.totalAmount} deposit=$${b.depositAmount} holdUntil=${b.aiHoldExpiresAt?.toISOString()} slotLocks=${locks} utm=${b.utmSource}/${b.utmMedium}`
    );
    await cancelAiHold(conv.hold.bookingId, "Automated test cleanup");
    const after: any = await Booking.findById(conv.hold.bookingId).lean();
    console.log(`CLEANUP: booking now ${after.status}, slotLocks=${await SlotLock.countDocuments({ eventId: b._id })}`);
    await Booking.deleteOne({ _id: b._id });
  }
  await AiConversation.deleteOne({ contactId });
  await mongoose.disconnect();
  process.exit(0);
};
run().catch((e) => {
  console.error(e);
  process.exit(1);
});
