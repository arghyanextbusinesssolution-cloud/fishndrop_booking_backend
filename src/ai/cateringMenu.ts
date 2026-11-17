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
      "Send the menu as plain text: restaurant name, then each section on its own line with the dish names (use `menu`). Keep descriptions out unless they ask about a dish (then use dishDetails). End with: catering is quoted separately, and ask if they'd like it for their event. Never invent dishes or prices."
  };
};
