// Run from backend/: node src/scripts/genCateringMenus.js — regenerates backend/src/ai/cateringMenus.ts from frontend/lib/cateringRestaurants.ts (data only)
const fs = require("fs"), path = require("path");
const root = path.resolve(__dirname, "../../..");
const ts = require(path.join(root, "backend/node_modules/typescript"));
const src = fs.readFileSync(path.join(root, "frontend/lib/cateringRestaurants.ts"), "utf8");
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText;
const m = { exports: {} }; new Function("module", "exports", js)(m, m.exports);
const data = m.exports.CATERING_RESTAURANTS.map((r) => ({
  id: r.id, name: r.name, cuisine: r.cuisine, tagline: r.tagline, shortDesc: r.shortDesc, fullDesc: r.fullDesc,
  phoneNumber: r.phoneNumber || "", websiteUrl: r.websiteUrl || "", highlightDishes: r.highlightDishes || [],
  categories: (r.categories || []).map((c) => ({ categoryName: c.categoryName, items: c.items.map((i) => ({ name: i.name, desc: i.desc, ...(i.spicy ? { spicy: true } : {}), ...(i.vegetarian ? { vegetarian: true } : {}) })) }))
}));
const out = `/**
 * Partner restaurant catering menus for the AI assistant.
 * GENERATED from frontend/lib/cateringRestaurants.ts — when a menu changes there, regenerate this file
 * (same data the booking page shows). Prices are not listed: catering is quoted separately.
 */

export interface AiMenuItem { name: string; desc: string; spicy?: boolean; vegetarian?: boolean }
export interface AiMenuCategory { categoryName: string; items: AiMenuItem[] }
export interface AiCateringRestaurant {
  id: string; name: string; cuisine: string; tagline: string; shortDesc: string; fullDesc: string;
  phoneNumber: string; websiteUrl: string; highlightDishes: string[]; categories: AiMenuCategory[];
}

export const CATERING_MENUS: AiCateringRestaurant[] = ${JSON.stringify(data, null, 2)};
`;
fs.writeFileSync(path.join(root, "backend/src/ai/cateringMenus.ts"), out);
console.log("restaurants:", data.map((r) => `${r.name} (${r.categories.length} sections, ${r.categories.reduce((n, c) => n + c.items.length, 0)} dishes)`).join(" | "));
