export const NO_CATERING_LABEL = "No Partner Catering (Self-Managed)";

/** Partner catering key → display name. Legacy keys are kept for older bookings. */
export const CATERING_LABEL_MAP: Readonly<Record<string, string>> = Object.freeze({
  none: NO_CATERING_LABEL,
  no_catering: NO_CATERING_LABEL,
  jamaican_jerk_house: "Jamaican Jerk House",
  east_coast_street_tacos: "East Coast Street Tacos",
  cooklyn_eats: "Cooklyn Eats",
  cooklyneats: "Cooklyn Eats",
  custom_catering: "Custom / Multi-Restaurant Mix",
  custom: "Custom Menu",
  // legacy menu keys
  seafood_buffet: "Jamaican Jerk House",
  tropica_signature: "East Coast Street Tacos",
  bbq_grill: "Cooklyn Eats",
  cocktail_canapes: "East Coast Street Tacos",
  vegan_garden: "Cooklyn Eats",
  kids_friendly: "Jamaican Jerk House"
});

export const resolveRestaurantName = (cateringMenu?: string): string => {
  const key = (cateringMenu || "none").toLowerCase().trim();
  return CATERING_LABEL_MAP[key] || (cateringMenu && cateringMenu !== "none" ? cateringMenu : NO_CATERING_LABEL);
};

export interface ParsedDish {
  name: string;
  quantity: number;
}

export interface ParsedNotes {
  rawNotes: string;
  cleanNotes: string;
  dietaryNotes: string;
  dishes: ParsedDish[];
  dishesSummary: string;
  totalDishCount: number;
}

const toPlainQuantities = (value: any): Record<string, number> => {
  if (!value) return {};
  if (typeof value.entries === "function") return Object.fromEntries(value.entries());
  if (typeof value === "object") return { ...value };
  return {};
};

const parseDishToken = (raw: string): ParsedDish => {
  const qtyMatch =
    raw.match(/^(.*?)\s*\(?(?:x|\bqty:?)\s*(\d+)(?:\s*(?:platters?|plates?))?\)?$/i) ||
    raw.match(/^(.*?)\s*\((\d+)\s*(?:platters?|plates?|x)?\)$/i);
  return qtyMatch ? { name: qtyMatch[1].trim(), quantity: parseInt(qtyMatch[2], 10) } : { name: raw, quantity: 1 };
};

/**
 * Extracts "[Dishes: …]" and "[Dietary: …]" blocks from booking notes and merges dish
 * quantities with `booking.dishQuantities` (which wins when present).
 */
export const parseBookingNotes = (notes: unknown, dishQuantities: unknown): ParsedNotes => {
  const rawNotes = String(notes || "");
  let cleanNotes = rawNotes;
  let dishes: ParsedDish[] = [];

  const dishesMatch = rawNotes.match(/\[Dishes:\s*([^\]]+)\]/i);
  if (dishesMatch?.[1]) {
    dishes = dishesMatch[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(parseDishToken);
    cleanNotes = cleanNotes.replace(/\[Dishes:\s*[^\]]+\]/gi, "").trim();
  }

  const saved = toPlainQuantities(dishQuantities);
  const hasSaved = Object.keys(saved).length > 0;
  if (dishes.length === 0 && hasSaved) {
    dishes = Object.entries(saved).map(([name, qty]) => ({ name, quantity: Number(qty) || 1 }));
  } else if (dishes.length > 0 && hasSaved) {
    dishes = dishes.map((d) => ({ name: d.name, quantity: saved[d.name] ?? d.quantity }));
  }

  let dietaryNotes = "";
  const dietaryMatch = cleanNotes.match(/\[Dietary:\s*([^\]]+)\]/i);
  if (dietaryMatch?.[1]) {
    dietaryNotes = dietaryMatch[1].trim();
    cleanNotes = cleanNotes.replace(/\[Dietary:\s*[^\]]+\]/gi, "").trim();
  }

  return {
    rawNotes,
    cleanNotes,
    dietaryNotes,
    dishes,
    dishesSummary: dishes.map((d) => `${d.name} (x${d.quantity})`).join(", "),
    totalDishCount: dishes.reduce((sum, d) => sum + (Number(d.quantity) || 1), 0)
  };
};
