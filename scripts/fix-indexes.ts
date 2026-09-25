/**
 * Clean up duplicate/empty phone entries and fix MongoDB indexes.
 * Run once: npx ts-node --project tsconfig.json scripts/fix-indexes.ts
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

async function fixIndexes() {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI || process.env.DATABASE_URL || "";
  if (!mongoUri) {
    console.error("❌ No MONGODB_URI found in .env");
    process.exit(1);
  }

  console.log("🔗 Connecting to MongoDB...");
  await mongoose.connect(mongoUri);
  console.log("✅ Connected!");

  const db = mongoose.connection.db;
  if (!db) {
    console.error("❌ No db connection");
    process.exit(1);
  }
  const collection = db.collection("users");

  // Step 1: Remove users with empty/null phone (they are broken ghost records)
  const deleteResult = await collection.deleteMany({ 
    phone: { $in: [null, "", undefined] }
  });
  console.log(`🗑️  Deleted ${deleteResult.deletedCount} users with empty/null phone.`);

  // Step 2: For duplicate emails, keep only the one with a real phone
  const emailDupes = await collection.aggregate([
    { $match: { email: { $ne: null, $ne: "" } } },
    { $group: { _id: "$email", count: { $sum: 1 }, ids: { $push: "$_id" } } },
    { $match: { count: { $gt: 1 } } }
  ]).toArray();

  for (const dupe of emailDupes) {
    console.log(`⚠️  Found ${dupe.count} users with email: ${dupe._id}`);
    // Keep the first one, delete the rest
    const [keep, ...remove] = dupe.ids;
    const removeResult = await collection.deleteMany({ _id: { $in: remove } });
    console.log(`   Kept ${keep}, removed ${removeResult.deletedCount} duplicates.`);
  }

  // Step 3: Set empty email to undefined (unset) to avoid sparse index conflicts  
  await collection.updateMany(
    { email: "" },
    { $unset: { email: "" } }
  );
  console.log("🧹 Cleared empty string emails (set to undefined for sparse index).");

  // Step 4: List current indexes
  const indexes = await collection.indexes();
  console.log("📋 Current indexes:", indexes.map((i: any) => i.name));

  // Step 5: Drop old email index if non-sparse
  const emailIndex = indexes.find((i: any) => i.name === "email_1");
  if (emailIndex) {
    if (!emailIndex.sparse) {
      console.log("⚠️  Dropping old non-sparse email_1 index...");
      await collection.dropIndex("email_1");
      console.log("✅ Dropped email_1!");
    } else {
      console.log("✅ email_1 already sparse.");
    }
  }

  // Drop email_1_sparse if exists (leftover from previous run)
  const emailSparseIndex = indexes.find((i: any) => i.name === "email_1_sparse");
  if (emailSparseIndex) {
    await collection.dropIndex("email_1_sparse");
    console.log("🗑️  Dropped old email_1_sparse.");
  }

  // Step 6: Drop old phone index if non-sparse
  const phoneIndex = indexes.find((i: any) => i.name === "phone_1");
  if (phoneIndex && !phoneIndex.sparse) {
    console.log("⚠️  Dropping old non-sparse phone_1 index...");
    await collection.dropIndex("phone_1");
    console.log("✅ Dropped phone_1!");
  }
  const phoneSparseIndex = indexes.find((i: any) => i.name === "phone_1_sparse");
  if (phoneSparseIndex) {
    await collection.dropIndex("phone_1_sparse");
    console.log("🗑️  Dropped old phone_1_sparse.");
  }

  // Step 7: Recreate proper sparse unique indexes
  await collection.createIndex({ email: 1 }, { unique: true, sparse: true, name: "email_1" });
  console.log("✅ Created sparse unique email index!");

  await collection.createIndex({ phone: 1 }, { unique: true, sparse: true, name: "phone_1" });
  console.log("✅ Created sparse unique phone index!");

  console.log("🎉 All done! Indexes fixed successfully.");
  await mongoose.disconnect();
}

fixIndexes().catch((err) => {
  console.error("❌ Fatal Error:", err.message);
  process.exit(1);
});
