import crypto from "crypto";
import dotenv from "dotenv";
import mongoose from "mongoose";
import connectDB from "../config/db";
import User from "../models/User";

dotenv.config();

const generatePassword = (): string => {
  const randomChunk = crypto.randomBytes(6).toString("base64url");
  return `Admin@${randomChunk}9`;
};

const resolveEmail = (): string => {
  const cliEmail = process.argv[2];
  const envEmail = process.env.ADMIN_EMAIL;
  const email = (cliEmail || envEmail || "admin@gmail.com").trim().toLowerCase();
  return email;
};

const resolvePassword = (): string => {
  const cliPassword = process.argv[3];
  const envPassword = process.env.ADMIN_PASSWORD;
  return (cliPassword || envPassword || "admin123").trim();
};

const main = async (): Promise<void> => {
  const email = resolveEmail();
  const password = resolvePassword();

  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is missing in environment");
  }

  if (password.length < 8) {
    throw new Error("Admin password must be at least 8 characters");
  }

  await connectDB();

  const existing = await User.findOne({ email }).select("+password");
  if (existing) {
    existing.role = "admin";
    existing.password = password;
    await existing.save();
    console.log("Updated existing user to admin.");
  } else {
    await User.create({
      name: "System Admin",
      email,
      password,
      role: "admin"
    });
    console.log("Created new admin user.");
  }

  console.log("Admin credentials:");
  console.log(`Email: ${email}`);
  console.log(`Password: ${password}`);

  await mongoose.connection.close();
  process.exit(0);
};

void main().catch(async (error: unknown) => {
  console.error("Failed to create admin user:", error);
  try {
    await mongoose.connection.close();
  } catch {}
  process.exit(1);
});
