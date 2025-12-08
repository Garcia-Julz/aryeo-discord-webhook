// server.js
const express = require("express");
const crypto = require("crypto");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

const ARYEO_WEBHOOK_SECRET = process.env.ARYEO_WEBHOOK_SECRET;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

console.log("Boot: ARYEO_WEBHOOK_SECRET present?", !!ARYEO_WEBHOOK_SECRET);
console.log("Boot: DISCORD_WEBHOOK_URL present?", !!DISCORD_WEBHOOK_URL);

// Capture raw body so we can validate the signature
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);

function verifyAryeoSignature(rawBody, signatureHeader) {
  if (!signatureHeader) {
    console.warn("❌ Missing Signature header");
    return false;
  }

  if (!ARYEO_WEBHOOK_SECRET) {
    console.error("❌ ARYEO_WEBHOOK_SECRET is not set in environment");
    return false;
  }

  let expected;
  try {
    expected = crypto
      .createHmac("sha256", ARYEO_WEBHOOK_SECRET)
      .update(rawBody, "utf8")
      .digest("hex");
  } catch (err) {
    console.error("❌ Error computing HMAC:", err);
    return false;
  }

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(signatureHeader, "hex")
    );
  } catch (err) {
    console.error("❌ Error comparing HMAC signatures:", err);
    return false;
  }
}

app.post("/aryeo-webhook", async (req, res) => {
  try {
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

// Root URL for testing
app.get("/", (req, res) => {
  res.send("Aryeo → Discord webhook is running.");
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});