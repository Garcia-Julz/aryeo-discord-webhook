// server.js
const express = require("express");
const crypto = require("crypto");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

const ARYEO_WEBHOOK_SECRET = process.env.ARYEO_WEBHOOK_SECRET;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// Capture raw body so we can validate the signature
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString("utf8");
  }
}));

function verifyAryeoSignature(rawBody, signatureHeader) {
  if (!signatureHeader) return false;

  const expected = crypto
    .createHmac("sha256", ARYEO_WEBHOOK_SECRET)
    .update(rawBody, "utf8")
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(signatureHeader, "hex")
    );
  } catch {
    return false;
  }
}

app.post("/aryeo-webhook", async (req, res) => {
  const signature = req.get("Signature");

  if (!verifyAryeoSignature(req.rawBody, signature)) {
    console.warn("❌ Invalid Aryeo webhook signature");
    return res.status(400).send("Invalid signature");
  }

  const activity = req.body;
  console.log("✅ Valid Aryeo activity:", activity);

  const { name, occurred_at, resource } = activity || {};

  // Example: react to LISTING_DELIVERED
  if (name === "LISTING_DELIVERED") {
    const listingId = resource?.id;

    const content =
      `🏡 Listing delivered!\n` +
      `• Event: \`${name}\`\n` +
      `• Listing ID: \`${listingId}\`\n` +
      `• Time (UTC): ${occurred_at}`;

    try {
      await fetch(DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content })
      });
      console.log("📨 Sent message to Discord");
    } catch (err) {
      console.error("❌ Error sending to Discord:", err);
    }
  }

  res.status(200).send("ok");
});

// Root URL for testing
app.get("/", (req, res) => {
  res.send("Aryeo → Discord webhook is running.");
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});