// server.js
const express = require("express");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

const ARYEO_WEBHOOK_SECRET = process.env.ARYEO_WEBHOOK_SECRET;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

console.log("Boot: ARYEO_WEBHOOK_SECRET present?", !!ARYEO_WEBHOOK_SECRET);
console.log("Boot: DISCORD_WEBHOOK_URL present?", !!DISCORD_WEBHOOK_URL);

// Capture raw body (kept for future real verification)
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);

// TEMPORARY: Disable signature verification for testing
function verifyAryeoSignature(rawBody, signatureHeader) {
  console.warn("⚠️ Skipping HMAC verification (TEST MODE).");
  return true;
}

app.post("/aryeo-webhook", async (req, res) => {
  try {
    const signature = req.get("Signature");

    // ALWAYS passing in test mode
    if (!verifyAryeoSignature(req.rawBody, signature)) {
      console.warn("❌ Invalid Aryeo webhook signature");
      return res.status(400).send("Invalid signature");
    }

    const activity = req.body;
    console.log("✅ Valid Aryeo activity received:", activity);

    const { name, occurred_at, resource } = activity || {};

    if (name === "LISTING_DELIVERED") {
      const listingId = resource && resource.id;

      const content =
        `🏡 Listing delivered!\n` +
        `• Event: \`${name}\`\n` +
        `• Listing ID: \`${listingId}\`\n` +
        `• Time (UTC): ${occurred_at}`;

      if (!DISCORD_WEBHOOK_URL) {
        console.error("❌ DISCORD_WEBHOOK_URL is not set in environment");
      } else {
        try {
          const resp = await fetch(DISCORD_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content }),
          });
          console.log("📨 Sent message to Discord, status:", resp.status);
        } catch (err) {
          console.error("❌ Error sending to Discord:", err);
        }
      }
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("💥 Unexpected error in /aryeo-webhook handler:", err);
    return res.status(500).send("Server error");
  }
});

// Root URL
app.get("/", (req, res) => {
  res.send("Aryeo → Discord webhook is running (TEST MODE).");
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});