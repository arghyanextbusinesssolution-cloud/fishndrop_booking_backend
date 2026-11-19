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
  /** People to serve (new "servings" requests) or platters (older bookings) */
  quantity: number;
  /** "Individual servings" / "Half tray" / "Full tray" when requested (new format only) */
  portion?: string;
}

export interface ParsedNotes {
  rawNotes: string;
  cleanNotes: string;
  dietaryNotes: string;
  dishes: ParsedDish[];
  dishesSummary: string;
  totalDishCount: number;
  /** "servings" = quantities are people per dish; "platters" = older bookings */
  cateringFormat: "servings" | "platters";
}

const PORTION_LABELS: Record<string, string> = { individual: "Individual servings", half_tray: "Half tray", full_tray: "Full tray" };

const toPlainQuantities = (value: any): Record<string, number> => {
  if (!value) return {};
  if (typeof value.entries === "function") return Object.fromEntries(value.entries());
  if (typeof value === "object") return { ...value };
  return {};
};

const parseDishToken = (raw: string): ParsedDish & { servings?: boolean } => {
  // New format: "Fried Chicken (for 15 people · Half tray)"
  const s = raw.match(/^(.*?)\s*\(for\s+(\d+)\s+(?:people|persons?|guests?)(?:\s*[·;\/]\s*([^)]+))?\)$/i);
  if (s) return { name: s[1].trim(), quantity: parseInt(s[2], 10) || 1, portion: s[3]?.trim() || undefined, servings: true };
  const qtyMatch =
    raw.match(/^(.*?)\s*\(?(?:x|\bqty:?)\s*(\d+)(?:\s*(?:platters?|plates?))?\)?$/i) ||
    raw.match(/^(.*?)\s*\((\d+)\s*(?:platters?|plates?|x)?\)$/i);
  return qtyMatch ? { name: qtyMatch[1].trim(), quantity: parseInt(qtyMatch[2], 10) } : { name: raw, quantity: 1 };
};

/**
 * Extracts "[Dishes: …]" and "[Dietary: …]" blocks from booking notes and merges dish
 * quantities with `booking.dishQuantities` (which wins when present).
 */
export const parseBookingNotes = (
  notes: unknown,
  dishQuantities: unknown,
  extra: { dishPortions?: unknown; cateringFormat?: string } = {}
): ParsedNotes => {
  const rawNotes = String(notes || "");
  let cleanNotes = rawNotes;
  let dishes: ParsedDish[] = [];
  let servings = extra.cateringFormat === "servings";

  const dishesMatch = rawNotes.match(/\[Dishes:\s*([^\]]+)\]/i);
  if (dishesMatch?.[1]) {
    const tokens = dishesMatch[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(parseDishToken);
    if (tokens.some((t) => t.servings)) servings = true;
    dishes = tokens.map(({ name, quantity, portion }) => ({ name, quantity, portion }));
    cleanNotes = cleanNotes.replace(/\[Dishes:\s*[^\]]+\]/gi, "").trim();
  }

  const saved = toPlainQuantities(dishQuantities);
  const portions = toPlainQuantities(extra.dishPortions) as unknown as Record<string, string>;
  const hasSaved = Object.keys(saved).length > 0;
  if (dishes.length === 0 && hasSaved) {
    dishes = Object.entries(saved).map(([name, qty]) => ({ name, quantity: Number(qty) || 1 }));
  } else if (dishes.length > 0 && hasSaved) {
    dishes = dishes.map((d) => ({ ...d, quantity: saved[d.name] ?? d.quantity }));
  }
  dishes = dishes.map((d) => ({ ...d, portion: d.portion || PORTION_LABELS[portions[d.name]] || undefined }));

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
    dishesSummary: dishes
      .map((d) => (servings ? `${d.name} (for ${d.quantity} ${d.quantity === 1 ? "person" : "people"}${d.portion ? ` · ${d.portion}` : ""})` : `${d.name} (x${d.quantity})`))
      .join(", "),
    // Servings requests: number of dishes (people aren't a dish count); older bookings: total platters
    totalDishCount: servings ? dishes.length : dishes.reduce((sum, d) => sum + (Number(d.quantity) || 1), 0),
    cateringFormat: servings ? "servings" : "platters"
  };
};
