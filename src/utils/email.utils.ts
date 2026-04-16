import nodemailer from "nodemailer";
import { IBooking } from "../models/Booking";
import logger from "../config/logger";

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.GMAIL_NAME || "",
    pass: process.env.GMAIL_PASSWORD || "",
  },
});

const SENDER_EMAIL = process.env.GMAIL_NAME || "admin@fishndrop.com";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@fishndrop.com";
const BANNER_URL = "https://res.cloudinary.com/dxx54fccl/image/upload/v1776120802/fishndrop_assets/email_banner.jpg";

export const sendPaymentEmails = async (booking: IBooking) => {
  try {
    if (!process.env.GMAIL_NAME || !process.env.GMAIL_PASSWORD) {
      logger.error("GMAIL credentials missing. Emails not sent.");
      return;
    }

    // 1. Send Confirmation to Customer

    const customerHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Booking Confirmed</title>
        <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Inter:wght@300;400;600&display=swap" rel="stylesheet">
      </head>
      <body style="margin: 0; padding: 0; background-color: #050505; font-family: 'Inter', Helvetica, Arial, sans-serif; color: #ffffff;">
        <table align="center" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; margin: 40px auto; background-color: #111111; border-radius: 16px; overflow: hidden; border: 1px solid #222222;">
          <!-- Header Image -->
          <tr>
            <td>
              <img src="${BANNER_URL}" alt="Fish & Drop" width="600" style="display: block; width: 100%; height: auto;">
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 48px 40px;">
              <h1 style="font-family: 'Playfair Display', serif; font-size: 32px; color: #d4af37; margin: 0 0 24px 0; font-weight: 700; text-align: center; letter-spacing: 1px;">Reservation Confirmed</h1>
              
              <p style="font-size: 16px; line-height: 28px; color: #cccccc; margin: 0 0 32px 0; text-align: center;">
                Dear ${booking.customerName}, your table at Fish & Drop is waiting for you. We are preparing an exceptional dining experience for your arrival.
              </p>

              <!-- Reservation Details Box -->
              <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #1a1a1a; border-radius: 12px; border: 1px solid #333333; margin-bottom: 32px;">
                <tr>
                  <td style="padding: 24px;">
                    <table border="0" cellpadding="0" cellspacing="0" width="100%">
                      <tr>
                        <td width="50%" style="padding-bottom: 20px;">
                          <p style="margin: 0; font-size: 12px; text-transform: uppercase; color: #888888; letter-spacing: 2px; font-weight: 600;">Date</p>
                          <p style="margin: 4px 0 0 0; font-size: 16px; color: #ffffff; font-weight: 600;">${new Date(booking.bookingDate).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p>
                        </td>
                        <td width="50%" style="padding-bottom: 20px;">
                          <p style="margin: 0; font-size: 12px; text-transform: uppercase; color: #888888; letter-spacing: 2px; font-weight: 600;">Time</p>
                          <p style="margin: 4px 0 0 0; font-size: 16px; color: #ffffff; font-weight: 600;">${booking.bookingTime}</p>
                        </td>
                      </tr>
                      <tr>
                        <td width="50%">
                          <p style="margin: 0; font-size: 12px; text-transform: uppercase; color: #888888; letter-spacing: 2px; font-weight: 600;">Guests</p>
                          <p style="margin: 4px 0 0 0; font-size: 16px; color: #ffffff; font-weight: 600;">${booking.partySize} People</p>
                        </td>
                        <td width="50%">
                          <p style="margin: 0; font-size: 12px; text-transform: uppercase; color: #888888; letter-spacing: 2px; font-weight: 600;">Occasion</p>
                          <p style="margin: 4px 0 0 0; font-size: 16px; color: #ffffff; font-weight: 600;">${booking.occasion.charAt(0).toUpperCase() + booking.occasion.slice(1)}</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <p style="font-size: 14px; line-height: 24px; color: #888888; text-align: center; margin-bottom: 32px;">
                Cancellations must be made at least 24 hours in advance. For any special requests or dietary requirements, please don't hesitate to reach out.
              </p>

              <!-- Footer CTA -->
              <table align="center" border="0" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <a href="https://fishndrop.com" style="display: inline-block; padding: 16px 36px; background-color: #d4af37; color: #000000; text-decoration: none; border-radius: 4px; font-weight: 700; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">Visit Website</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer Area -->
          <tr>
            <td style="padding: 32px 40px; background-color: #0a0a0a; border-top: 1px solid #222222; text-align: center;">
              <p style="margin: 0 0 16px 0; font-size: 12px; color: #555555; text-transform: uppercase; letter-spacing: 1px;">Follow Our Journey</p>
              <table align="center" border="0" cellpadding="0" cellspacing="0" style="margin-bottom: 24px;">
                <tr>
                  <td style="padding: 0 10px;"><a href="#" style="color: #d4af37; text-decoration: none; font-size: 12px;">Instagram</a></td>
                  <td style="padding: 0 10px;"><a href="#" style="color: #d4af37; text-decoration: none; font-size: 12px;">Facebook</a></td>
                </tr>
              </table>
              <p style="margin: 0; font-size: 11px; color: #444444;">
                &copy; ${new Date().getFullYear()} FISH & DROP RESTAURANT. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;

    const customerMailOptions = {
      from: `"Fish & Drop" <${SENDER_EMAIL}>`,
      to: booking.customerEmail,
      subject: `A Culinary Experience Awaits - Fish & Drop`,
      html: customerHtml,
      text: `Confirmed: Your reservation for ${booking.partySize} guests on ${new Date(booking.bookingDate).toLocaleDateString()} is ready!`,
    };

    await transporter.sendMail(customerMailOptions);
    logger.info(`Premium confirmation email sent to ${booking.customerEmail}`);

    // 2. Send Notification to Admin (Slightly more utility-focused but still premium)

    const adminHtml = `
      <div style="font-family: 'Inter', sans-serif; max-width: 600px; margin: 0 auto; padding: 32px; border: 1px solid #e5e7eb; border-radius: 12px; background-color: #ffffff;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px;">
          <h1 style="color: #111827; font-size: 20px; font-weight: 700; margin: 0;">New Reservation</h1>
          <span style="background-color: #ecfdf5; color: #065f46; padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: 600;">PAID</span>
        </div>
        
        <p style="color: #4b5563; font-size: 14px; margin-bottom: 24px;">A new booking has been confirmed for <strong>${booking.customerName}</strong>.</p>
        
        <table width="100%" style="border-collapse: collapse; margin-bottom: 24px;">
          <tr>
            <td style="padding: 12px 0; border-bottom: 1px solid #f3f4f6; color: #6b7280; font-size: 14px;">Customer Info</td>
            <td style="padding: 12px 0; border-bottom: 1px solid #f3f4f6; color: #111827; font-size: 14px; text-align: right; font-weight: 600;">
              ${booking.customerName}<br>
              <span style="font-weight: 400; color: #6b7280; font-size: 12px;">${booking.customerEmail}</span><br>
              <span style="font-weight: 400; color: #6b7280; font-size: 12px;">${booking.customerPhone}</span>
            </td>
          </tr>
          <tr>
            <td style="padding: 12px 0; border-bottom: 1px solid #f3f4f6; color: #6b7280; font-size: 14px;">Reservation</td>
            <td style="padding: 12px 0; border-bottom: 1px solid #f3f4f6; color: #111827; font-size: 14px; text-align: right; font-weight: 600;">
              ${new Date(booking.bookingDate).toLocaleDateString()}<br>
              <span style="font-weight: 400; color: #6b7280; font-size: 12px;">${booking.bookingTime}</span>
            </td>
          </tr>
          <tr>
            <td style="padding: 12px 0; border-bottom: 1px solid #f3f4f6; color: #6b7280; font-size: 14px;">Party Size</td>
            <td style="padding: 12px 0; border-bottom: 1px solid #f3f4f6; color: #111827; font-size: 14px; text-align: right; font-weight: 600;">${booking.partySize} Guests</td>
          </tr>
          <tr>
            <td style="padding: 12px 0; color: #111827; font-size: 16px; font-weight: 700;">Total Paid</td>
            <td style="padding: 12px 0; color: #111827; font-size: 16px; font-weight: 700; text-align: right;">$${booking.totalAmount}</td>
          </tr>
        </table>

        <a href="${process.env.FRONTEND_BASE_URL || 'http://localhost:3000'}/admin/bookings" style="display: block; width: 100%; padding: 12px; background-color: #111827; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600; text-align: center; font-size: 14px;">Review in Dashboard</a>
      </div>
    `;

    const adminMailOptions = {
      from: `"Fish & Drop" <${SENDER_EMAIL}>`,
      to: ADMIN_EMAIL,
      subject: `Alert: New Booking - ${booking.customerName}`,
      html: adminHtml,
      text: `New payment received: ${booking.customerName} has booked for ${booking.partySize} people on ${new Date(booking.bookingDate).toLocaleDateString()}. Amount: $${booking.totalAmount}`,
    };

    await transporter.sendMail(adminMailOptions);
    logger.info(`Premium admin notification sent for ${booking.customerName}`);

  } catch (error) {
    logger.error("Failed to send premium payment emails", { error });
  }
};
