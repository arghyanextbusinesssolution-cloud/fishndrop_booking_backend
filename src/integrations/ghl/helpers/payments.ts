import { getOrdinal } from "./common";

export interface PaymentSummary {
  totalPaid: number;
  depositInStart: number;
  paidNow: number;
  currentInstallmentNumber: number;
  currentInstallmentLabel: string;
  installments: Array<{
    installment: string;
    iterationIndex: number;
    amount: number;
    paymentType: string;
    paymentMethod: string;
    status: string;
    transactionId: string;
    paidAt: string;
  }>;
  installmentSummary: string;
  totalInstallments: number;
  verifiedInstallments: number;
  pendingInstallments: number;
}

/** Derives paid / deposit / installment figures from `booking.paymentBreakdown`. */
export const summarizePayments = (booking: any, paidNowOverride?: number): PaymentSummary => {
  const breakdown: any[] = Array.isArray(booking.paymentBreakdown) ? booking.paymentBreakdown : [];
  const verified = breakdown.filter((p) => p.status === "verified");

  const totalPaid =
    verified.length > 0
      ? verified.reduce((sum, p) => sum + (Number(p.amount) || 0), 0)
      : booking.paymentStatus === "paid"
      ? booking.totalAmount || 0
      : booking.depositAmount || 0;

  const depositEntry = verified.find((p) => p.paymentType === "deposit");
  const depositInStart = depositEntry ? Number(depositEntry.amount || 0) : Number(booking.depositAmount || 0);

  const latestVerified = verified[verified.length - 1];
  const paidNow =
    paidNowOverride !== undefined
      ? Number(paidNowOverride)
      : latestVerified
      ? Number(latestVerified.amount || 0)
      : booking.depositAmount || 0;

  const currentInstallmentNumber = Math.max(1, verified.length);

  const installments = verified.map((item, idx) => ({
    installment: `${getOrdinal(idx + 1)} Installment`,
    iterationIndex: idx + 1,
    amount: Number(item.amount || 0),
    paymentType: item.paymentType || "deposit",
    paymentMethod: item.paymentMethod || "zelle",
    status: item.status || "verified",
    transactionId: item.transactionId || "",
    paidAt: item.paidAt || item.createdAt || new Date().toISOString()
  }));

  const installmentSummary =
    verified.length > 0
      ? verified
          .map(
            (p, idx) =>
              `${getOrdinal(idx + 1)}: $${Number(p.amount || 0).toFixed(2)} (${
                p.paymentType === "deposit" ? "Deposit" : "Balance"
              })`
          )
          .join(" | ")
      : `Deposit: $${depositInStart.toFixed(2)}`;

  return {
    totalPaid,
    depositInStart,
    paidNow,
    currentInstallmentNumber,
    currentInstallmentLabel: `${getOrdinal(currentInstallmentNumber)} Installment`,
    installments,
    installmentSummary,
    totalInstallments: breakdown.length,
    verifiedInstallments: verified.length,
    pendingInstallments: breakdown.filter((p) => p.status === "pending").length
  };
};
