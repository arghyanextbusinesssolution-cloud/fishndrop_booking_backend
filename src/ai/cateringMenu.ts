import { CATERING_MENUS, AiCateringRestaurant } from "./cateringMenus";

/**
 * get_catering_menu — partner restaurant menus (same data as the booking page).
 *   no restaurant → the list of partner restaurants with their signature dishes
 *   restaurant    → that restaurant's full menu, grouped by section (compact for a DM)
 */

const ALIASES: Array<[RegExp, string]> = [
  [/jama|jerk|caribb|island/i, "jamaican_jerk_house"],
  [/mex|taco|street|fiesta|east coast/i, "east_coast_street_tacos"],
  [/soul|southern|cooklyn|comfort/i, "cooklyn_eats"],
  [/custom|mix|multi|bespoke/i, "custom_catering"]
];

const find = (q?: string): AiCateringRestaurant | undefined => {
  if (!q?.trim()) return undefined;
  const byId = CATERING_MENUS.find((r) => r.id === q.trim() || r.name.toLowerCase() === q.trim().toLowerCase());
  if (byId) return byId;
  const alias = ALIASES.find(([re]) => re.test(q));
  return alias ? CATERING_MENUS.find((r) => r.id === alias[1]) : undefined;
};

const menuText = (r: AiCateringRestaurant) =>
  r.categories
    .map((c) => `${c.categoryName}: ${c.items.map((i) => `${i.name}${i.vegetarian ? " (veg)" : ""}${i.spicy ? " 🌶" : ""}`).join(", ")}`)
    .join("\n");

const STOP = new Set(["and", "the", "with", "from", "some", "a", "an", "of", "please", "also"]);
const SYNONYMS: Record<string, string> = { mac: "macaroni", bbq: "bbq", wings: "wing", plantain: "plantains" };
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .map((w) => SYNONYMS[w] || w)
    .join(" ");

/** Finds the real menu dish for what the customer typed ("jerk chicken" → "Authentic Jerk Chicken"). */
const findDish = (q: string, within: AiCateringRestaurant[]) => {
  const n = norm(q);
  if (!n) return undefined;
  const all = within.flatMap((r) => r.categories.flatMap((c) => c.items.map((i) => ({ r, name: i.name }))));
  return (
    all.find((d) => norm(d.name) === n) ||
    all.find((d) => norm(d.name).includes(n)) ||
    all.find((d) => n.split(" ").filter((w) => w.length > 2).every((w) => norm(d.name).includes(w)))
  );
};

/**
 * choose_catering — the customer picks partner-restaurant dishes in the chat. Returns the matched real dishes
 * and the restaurant ids (same format the website booking stores: "jamaican_jerk_house,cooklyn_eats").
 */
export type AiPortion = "" | "individual" | "half_tray" | "full_tray";
const PORTION_TEXT: Record<string, string> = { individual: "individual servings", half_tray: "half tray", full_tray: "full tray" };
const toPortion = (p?: string): AiPortion => {
  const l = (p || "").toLowerCase();
  if (/half/.test(l)) return "half_tray";
  if (/full/.test(l)) return "full_tray";
  if (/individ|single|plate|box/.test(l)) return "individual";
  return "";
};

export interface CateringItem {
  name: string;
  /** How many people this dish should serve (0 = not given yet) */
  people: number;
  portion: AiPortion;
}

/**
 * choose_catering — the customer's catering REQUEST: restaurant → dishes → people per dish → optional portion
 * style → special instructions. No prices / guaranteed portions: the team (Sarah) confirms with the restaurant
 * and sends a separate quote. Ids use the website format ("jamaican_jerk_house,cooklyn_eats").
 */
export const chooseCatering = (args: {
  restaurants?: string[];
  dishes?: Array<string | { dish?: string; name?: string; people?: number; portion?: string }>;
  special_instructions?: string;
}) => {
  const picked = (args.restaurants || []).map((r) => find(r)).filter((r): r is AiCateringRestaurant => Boolean(r?.categories.length));
  const searchIn = picked.length ? picked : CATERING_MENUS.filter((r) => r.categories.length);
  const matched: (CateringItem & { restaurantId: string })[] = [];
  const unknown: string[] = [];
  for (const raw of args.dishes || []) {
    const d = typeof raw === "string" ? { dish: raw } : raw;
    const label = String(d.dish || d.name || "").trim();
    if (!label) continue;
    const hit = findDish(label, searchIn) || findDish(label, CATERING_MENUS);
    if (!hit) {
      unknown.push(label);
      continue;
    }
    if (matched.some((m) => m.name === hit.name)) continue;
    const people = Math.min(500, Math.max(0, Math.round(Number(d.people) || 0)));
    matched.push({ name: hit.name, people, portion: toPortion(d.portion), restaurantId: hit.r.id });
  }
  const ids = [...new Set([...picked.map((r) => r.id), ...matched.map((m) => m.restaurantId)])];
  const missingPeople = matched.filter((m) => !m.people).map((m) => m.name);
  return {
    ok: matched.length > 0 || ids.length > 0,
    restaurants: ids.map((id) => CATERING_MENUS.find((r) => r.id === id)?.name),
    cateringMenu: ids.join(","),
    items: matched.map(({ name, people, portion }) => ({ name, people, portion })),
    request: matched
      .map((m) => `${m.name}${m.people ? ` for ${m.people} people` : ""}${m.portion ? ` (${PORTION_TEXT[m.portion]})` : ""}`)
      .join(", "),
    specialInstructions: (args.special_instructions || "").trim().slice(0, 500) || undefined,
    needPeopleFor: missingPeople.length ? missingPeople : undefined,
    notOnMenu: unknown.length ? unknown : undefined,
    note: [
      missingPeople.length
        ? `Ask how many people ${missingPeople.length === 1 ? "this dish" : "each dish"} should serve (e.g. "fried chicken for 15 people") — ONE question.`
        : "Confirm the request back in one short line.",
      "Portion style (individual servings / half tray / full tray) is optional — offer it once, never require it.",
      "Never quote a catering price or promise portion sizes: our team confirms quantities, portions, availability and price with the restaurant and sends a separate catering quote by SMS or email for approval. Catering is separate from the venue booking and not part of today's deposit.",
      unknown.length ? "Items in notOnMenu aren't on the partner menus — offer the closest dishes." : ""
    ]
      .filter(Boolean)
      .join(" ")
  };
};

export const getCateringMenu = (args: { restaurant?: string }) => {
  const r = find(args.restaurant);
  const partners = CATERING_MENUS.filter((x) => x.categories.length);

  if (!r) {
    return {
      ok: true,
      restaurants: CATERING_MENUS.map((x) => ({
        name: x.name,
        cuisine: x.cuisine,
        about: x.shortDesc,
        signatureDishes: x.highlightDishes.slice(0, 4)
      })),
      customerLine: `We partner with ${partners.map((x) => `${x.name} (${x.cuisine.replace(/ Catering$/, "")})`).join(", ")} — or a custom mix from all of them. Catering is quoted separately.`,
      note: "Tell them the partners in one short message (name + cuisine + 2 signature dishes each), then ask which menu they'd like to see. Prices aren't listed — catering is quoted separately by the team."
    };
  }

  if (!r.categories.length) {
    return {
      ok: true,
      restaurant: r.name,
      about: r.fullDesc,
      note: "Custom menus are put together by the team — offer to have a team member help (request_human_help) after collecting what they'd like."
    };
  }

  return {
    ok: true,
    restaurant: r.name,
    cuisine: r.cuisine,
    about: r.shortDesc,
    menu: menuText(r),
    dishDetails: r.categories.flatMap((c) => c.items.map((i) => ({ section: c.categoryName, name: i.name, desc: i.desc }))),
    phone: r.phoneNumber || undefined,
    note:
      "Send the menu as plain text: restaurant name, then each section on its own line with the dish names (use `menu`). Keep descriptions out unless they ask about a dish (then use dishDetails). End with: the catering price is set by our team once they've picked their dishes, and ask which dishes they'd like. Never invent dishes or prices."
  };
};
