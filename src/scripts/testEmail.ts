import "../config/loadEnv";
import { sendPaymentEmails } from "../utils/email.utils";
import { IBooking } from "../models/Booking";

const mockBooking = {
  customerName: "Test User",
  customerEmail: process.env.ADMIN_EMAIL || "test@example.com", // Send to admin email for testing
  customerPhone: "1234567890",
  partySize: 4,
  bookingDate: new Date(),
  bookingTime: "19:00",
  occasion: "birthday",
  totalAmount: 150,
} as unknown as IBooking;

const runTest = async () => {
  console.log("Starting email test...");
  console.log(`Using SENDER_EMAIL: ${process.env.SENDER_EMAIL}`);
  console.log(`Using ADMIN_EMAIL: ${process.env.ADMIN_EMAIL}`);
  
  await sendPaymentEmails(mockBooking);
  
  console.log("Test complete. Check your inbox (and spam folder).");
  process.exit(0);
};

runTest().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
