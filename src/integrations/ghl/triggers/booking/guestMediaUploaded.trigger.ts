import { safeTrigger } from "../../client";
import { bookingDispatch } from "../../payloads/booking.payload";
import type { MediaDetails } from "../../types";

/**
 * Guest uploaded photos/videos from their celebration.
 * Event: "guest_media_uploaded" · Tag: "Media Uploaded" · Webhook: general
 */
export const sendGHLMediaUploadEvent = async (booking: any, mediaDetails: MediaDetails): Promise<void> => {
  await safeTrigger("guest_media_uploaded", () =>
    bookingDispatch(booking, {
      event: "guest_media_uploaded",
      leadStatus: "booking",
      ghlTag: "Media Uploaded",
      mediaDetails
    })
  );
};
