/**
 * TEST: Simulate GHL Zelle Webhook
 * ------------------------------------
 * Run this script to simulate GHL sending Zelle payment verification
 * to your backend WITHOUT needing ngrok or production.
 *
 * USAGE:
 *   1. Start your backend: npm run dev (in /backend)
 *   2. Open this file and PASTE a real bookingId from MongoDB below
 *   3. node src/scratch/test_ghl_zelle_webhook.js
 */

const BACKEND_URL = "http://localhost:5001"; // change port if different
const GHL_SECRET = "fishndrop_zelle_secure_secret_2026"; // must match GHL_ZELLE_WEBHOOK_SECRET in .env


// ============================================================
// ✏️ EDIT THESE VALUES BEFORE RUNNING
// ============================================================
const BOOKING_ID = "6ac63f6cf08c7a5a23257a52"; // Nov 20 pending Zelle booking
const AMOUNT_PAID = 1.00;    // ← $1 test payment — GHL sends this, we accept any amount
const PAYMENT_TYPE = "deposit"; // "deposit" or "balance"
// ============================================================

async function testZelleWebhook() {
  console.log("\n🚀 Simulating GHL → Website Zelle Webhook...\n");
  console.log(`📌 Booking ID : ${BOOKING_ID}`);
  console.log(`💵 Amount     : $${AMOUNT_PAID}`);
  console.log(`🏷️  Type       : ${PAYMENT_TYPE}`);
  console.log(`🔗 Target URL : ${BACKEND_URL}/api/payments/zelle-webhook\n`);

  // Payload that mimics what GHL sends
  const payload = {
    bookingId: BOOKING_ID,
    amount: AMOUNT_PAID,
    status: "verified",
    paymentType: PAYMENT_TYPE,
    transactionId: `TEST-GHL-ZEL-${Date.now()}`,
    notes: "Test: Simulated GHL Zelle verification from local script"
  };

  console.log("📦 Payload being sent:");
  console.log(JSON.stringify(payload, null, 2));
  console.log("\n⏳ Sending...\n");

  try {
    const res = await fetch(`${BACKEND_URL}/api/payments/zelle-webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-ghl-secret": GHL_SECRET
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();

    console.log(`📡 HTTP Status: ${res.status}`);
    console.log("📬 Response from backend:");
    console.log(JSON.stringify(data, null, 2));

    if (data.success) {
      console.log("\n✅ SUCCESS! Booking was confirmed.");
      console.log(`   status           : ${data.booking?.status}`);
      console.log(`   paymentStatus    : ${data.booking?.paymentStatus}`);
      console.log(`   depositAmount    : $${data.booking?.depositAmount}`);
      console.log(`   remainingAmount  : $${data.booking?.remainingAmount}`);
      console.log(`   zelleVerStatus   : ${data.booking?.zelleVerificationStatus}`);
      console.log("\n📨 Confirmation email + GHL booking_confirmed event fired automatically.");
    } else {
      console.log("\n⚠️  Booking was NOT confirmed — check the response above.");
      console.log("   Possible reasons: amount mismatch, wrong bookingId, already confirmed");
    }

  } catch (err) {
    console.error("❌ Request failed:", err.message);
    console.error("   → Is your backend running at", BACKEND_URL, "?");
  }
}

testZelleWebhook();
