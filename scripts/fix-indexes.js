/**
 * Fix MongoDB indexes: drop old non-sparse email/phone unique indexes,
 * clean bad data, and recreate as sparse.
 */
const mongoose = require("mongoose");
require("dotenv").config();

async function fixIndexes() {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI || "";
  if (!mongoUri) {
    console.error("❌ No MONGODB_URI found in .env");
    process.exit(1);
  }

  console.log("🔗 Connecting to MongoDB...");
  await mongoose.connect(mongoUri);
  console.log("✅ Connected to:", mongoUri.split("@")[1] || "MongoDB");

  const db = mongoose.connection.db;
  const collection = db.collection("users");

  // Step 1: Remove users with empty/null phone (broken ghost records from failed registrations)
  const deleteResult = await collection.deleteMany({ 
    $or: [{ phone: null }, { phone: "" }]
  });
  console.log(`🗑️  Deleted ${deleteResult.deletedCount} users with empty/null phone.`);

  // Step 2: Unset empty string emails so they don't conflict with sparse index
  const emailClean = await collection.updateMany({ email: "" }, { $unset: { email: 1 } });
  console.log(`🧹 Cleared ${emailClean.modifiedCount} empty string emails.`);

  // Step 3: Fix duplicate emails (keep newest, remove older ones)
  const emailDupes = await collection.aggregate([
    { $match: { email: { $ne: null, $exists: true } } },
    { $group: { _id: "$email", count: { $sum: 1 }, ids: { $push: "$_id" } } },
    { $match: { count: { $gt: 1 } } }
  ]).toArray();

  for (const dupe of emailDupes) {
    console.log(`⚠️  Found ${dupe.count} users with duplicate email: ${dupe._id}`);
    const [_keep, ...remove] = dupe.ids;
    const removeResult = await collection.deleteMany({ _id: { $in: remove } });
    console.log(`   Removed ${removeResult.deletedCount} duplicate(s).`);
  }

  // Step 3b: Fix duplicate phones (keep newest, remove older ones)
  const phoneDupes = await collection.aggregate([
    { $match: { phone: { $ne: null, $exists: true, $ne: "" } } },
    { $group: { _id: "$phone", count: { $sum: 1 }, ids: { $push: "$_id" } } },
    { $match: { count: { $gt: 1 } } }
  ]).toArray();

  for (const dupe of phoneDupes) {
    console.log(`⚠️  Found ${dupe.count} users with duplicate phone: ${dupe._id}`);
    const [_keep, ...remove] = dupe.ids;
    const removeResult = await collection.deleteMany({ _id: { $in: remove } });
    console.log(`   Removed ${removeResult.deletedCount} duplicate phone(s).`);
  }

  // Step 4: List current indexes
  const indexes = await collection.indexes();
  console.log("📋 Current indexes:", indexes.map(i => i.name));

  // Step 5: Drop all old email indexes
  for (const idx of indexes) {
    if (idx.name && idx.name.startsWith("email_")) {
      try {
        await collection.dropIndex(idx.name);
        console.log(`🗑️  Dropped index: ${idx.name}`);
      } catch (e) {
        console.log(`   Could not drop ${idx.name}: ${e.message}`);
      }
    }
  }

  // Step 6: Drop all old phone indexes (except _id_)
  for (const idx of indexes) {
    if (idx.name && idx.name.startsWith("phone_")) {
      try {
        await collection.dropIndex(idx.name);
        console.log(`🗑️  Dropped index: ${idx.name}`);
      } catch (e) {
        console.log(`   Could not drop ${idx.name}: ${e.message}`);
      }
    }
  }

  // Step 7: Create proper sparse unique indexes
  await collection.createIndex({ email: 1 }, { unique: true, sparse: true, name: "email_1" });
  console.log("✅ Created sparse unique email index!");

  await collection.createIndex({ phone: 1 }, { unique: true, sparse: true, name: "phone_1" });
  console.log("✅ Created sparse unique phone index!");

  const finalIndexes = await collection.indexes();
  console.log("📋 Final indexes:", finalIndexes.map(i => `${i.name} (sparse:${!!i.sparse}, unique:${!!i.unique})`));
  console.log("🎉 Done! All indexes fixed.");
  await mongoose.disconnect();
}

fixIndexes().catch((err) => {
  console.error("❌ Fatal Error:", err.message);
  process.exit(1);
});
