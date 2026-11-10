import { safeTrigger } from "../../client";
import { nowIso, splitName, toId } from "../../helpers/common";
import { getPublicLinkBase } from "../../config";
import type { ActorInfo } from "../../types";

export type PromoterVerificationAction = "approved" | "rejected";

/**
 * Staff/admin verified (approved) or rejected a promoter application.
 * Event: "promoter_verified" | "promoter_rejected" · Webhook: promoterVerification
 */
export const sendGHLPromoterVerificationEvent = async (
  promoter: any,
  action: PromoterVerificationAction,
  verifiedBy?: ActorInfo,
  rejectionReason?: string
): Promise<void> => {
  const approved = action === "approved";
  const event = approved ? "promoter_verified" : "promoter_rejected";

  await safeTrigger(event, () => {
    const { name, firstName, lastName } = splitName(promoter.name, "Promoter");
    const promoterId = toId(promoter);
    return {
      webhook: "promoterVerification",
      event,
      ref: promoterId,
      payload: {
        event,
        action: approved ? "verified" : "rejected",
        ghlTag: approved ? "Promoter Verified" : "Promoter Rejected",
        promoterId,
        name,
        firstName,
        lastName,
        number: promoter.phone || "",
        phone: promoter.phone || "",
        email: promoter.email || "",
        companyName: promoter.companyName || "",
        promoterStatus: action,
        rejectionReason: approved ? "" : rejectionReason || promoter.promoterRejectionReason || "",
        // Links for the "your account is active" / "application update" message
        loginUrl: `${getPublicLinkBase()}/promoter/register/?tab=login`,
        createEventUrl: approved ? `${getPublicLinkBase()}/promoter/events/new/` : "",
        verifiedBy: verifiedBy
          ? { id: verifiedBy.id, name: verifiedBy.name, email: verifiedBy.email, role: verifiedBy.role }
          : undefined,
        timestamp: nowIso()
      }
    };
  });
};

/** Convenience wrapper: approve without actor details. */
export const sendGHLPromoterApprovedEvent = (promoter: any): Promise<void> =>
  sendGHLPromoterVerificationEvent(promoter, "approved");
