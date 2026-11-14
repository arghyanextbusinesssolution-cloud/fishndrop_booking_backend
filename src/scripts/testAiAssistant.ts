/**
 * Chat with the AI booking assistant from the terminal (real DB + Groq, GHL webhooks disabled).
 *   npx ts-node src/scripts/testAiAssistant.ts "msg 1" "msg 2" ...
 */
import dotenv from "dotenv";
dotenv.config();
process.env.GHL_WEBHOOKS_ENABLED = "false";
process.env.GHL_API_TOKEN = "";
import mongoose from "mongoose";
import connectDB from "../config/db";
import AiConversation from "../models/AiConversation";
import { processInboundMessage } from "../ai/assistant.service";

const run = async () => {
  await connectDB();
  const contactId = `cli-test-${Date.now()}`;
  for (const text of process.argv.slice(2)) {
    const r = await processInboundMessage({ contactId, channel: "instagram", text, contactName: "Maria Lopez" });
    console.log(`\nCUSTOMER: ${text}\nAI: ${r.reply}\n   [${r.status} · stage=${r.stage} · tools=${(r.toolsUsed || []).join(",") || "-"}${r.handoff ? " · HANDOFF" : ""}]`);
  }
  await AiConversation.deleteOne({ contactId });
  await mongoose.disconnect();
  process.exit(0);
};
run().catch((e) => { console.error(e); process.exit(1); });
