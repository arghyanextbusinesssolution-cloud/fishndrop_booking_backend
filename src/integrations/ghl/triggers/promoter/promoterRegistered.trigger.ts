import { safeTrigger } from "../../client";
import { nowIso, splitName, toId } from "../../helpers/common";

/**
 * Promoter signed up with a verification document.
 * Event: "promoter_registered" · Tag: "Promoter Registered" · Webhook: promoterApplication
 */
export const sendGHLPromoterRegisteredEvent = async (promoter: any): Promise<void> => {
  await safeTrigger("promoter_registered", () => {
    const { firstName, lastName } = splitName(promoter.name, "Promoter");
    const promoterId = toId(promoter);
    return {
      webhook: "promoterApplication",
      event: "promoter_registered",
      ref: promoterId,
      payload: {
        event: "promoter_registered",
        leadStatus: "lead",
        ghlTag: "Promoter Registered",
        promoterId,
        firstName,
        lastName,
        name: promoter.name,
        email: promoter.email,
        phone: promoter.phone,
        companyName: promoter.companyName || "",
        // Only a real link: never an embedded data: URL
        idDocumentUrl: /^https?:\/\//i.test(promoter.idDocumentUrl || "") ? promoter.idDocumentUrl : "",
        promoterStatus: promoter.promoterStatus || "pending",
        timestamp: nowIso()
      }
    };
  });
};
