// Quick test - run with: node test-emailjs.js
const EMAILJS_SERVICE_ID = "service_ar3n8ua";
const EMAILJS_TEMPLATE_ID = "template_dkjbkjx";
const EMAILJS_PUBLIC_KEY = "UHhDHPjsoUXe4-fx2";
const EMAILJS_PRIVATE_KEY = "f4JCSmWIwB8m4cy0xRbOo";
const EMAILJS_URL = "https://api.emailjs.com/api/v1.0/email/send";

async function test() {
    const payload = {
        service_id: EMAILJS_SERVICE_ID,
        template_id: EMAILJS_TEMPLATE_ID,
        user_id: EMAILJS_PUBLIC_KEY,
        accessToken: EMAILJS_PRIVATE_KEY,
        template_params: {
            email: "arghyasamanta1786@gmail.com",   // <-- change to your email
            guestName: "Test Guest",
            hostelName: "Tropica Sanctuary",
            bookingId: "TEST-001",
            checkIn: "July 1st, 2026 at 19:00",
            checkOut: "July 1st, 2026 at 23:00",
            roomType: "Private Venue Buyout",
            totalAmount: 1000,
            paidAmount: 200,
            remainingAmount: 800,
            paymentLink: "http://localhost:3000/user/venue-bookings",
            supportEmail: "support@tropica.nyc",
            supportPhone: "+1-555-0000",
            year: 2026
        }
    };

    console.log("Sending to EmailJS...");
    console.log("Service:", EMAILJS_SERVICE_ID, "| Template:", EMAILJS_TEMPLATE_ID);

    try {
        const response = await fetch(EMAILJS_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        const text = await response.text();
        if (response.ok) {
            console.log("✅ SUCCESS:", response.status, text);
        } else {
            console.error("❌ FAILED:", response.status, text);
        }
    } catch (err) {
        console.error("❌ Network error:", err.message);
    }
}

test();
