/**
 * Creates (or resets) a blog-only SEO login.
 *   npx ts-node src/scripts/createSeoUser.ts <email> <password> [name]
 * The account gets role "seo": it can sign in at /seo-login and manage blogs — nothing else.
 */
import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import connectDB from "../config/db";
import User from "../models/User";

const main = async () => {
  const email = (process.argv[2] || "").trim().toLowerCase();
  const password = (process.argv[3] || "").trim();
  const name = (process.argv[4] || "SEO Team").trim();
  if (!email.includes("@")) throw new Error("Usage: createSeoUser.ts <email> <password> [name]");
  if (password.length < 8) throw new Error("Password must be at least 8 characters");

  await connectDB();
  const existing = await User.findOne({ email }).select("+password");
  if (existing) {
    if (["admin", "owner"].includes(existing.role)) {
      throw new Error(`${email} is an ${existing.role} account — refusing to downgrade it to SEO.`);
    }
    existing.role = "seo";
    existing.password = password;
    if (!existing.name || existing.name === "Guest User") existing.name = name;
    await existing.save();
    console.log(`Updated ${email} → role "seo" (password reset).`);
  } else {
    await User.create({ name, email, password, role: "seo" });
    console.log(`Created SEO login ${email} (role "seo").`);
  }
  await mongoose.disconnect();
  process.exit(0);
};

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
