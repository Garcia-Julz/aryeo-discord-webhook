// server.js
const express = require("express");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

// --- ENV VARS ---
const ARYEO_WEBHOOK_SECRET = process.env.ARYEO_WEBHOOK_SECRET; // not used in test mode
const ARYEO_API_KEY = process.env.ARYEO_API_KEY;

const DRONE_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL_DRONE;
const QUICKBOOKS_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL_QUICKBOOKS;

const DRONE_MENTION = process.env.DRONE_MENTION || "@DronePilot";

console.log("Boot: ARYEO_API_KEY present?", !!ARYEO_API_KEY);
console.log("Boot: DRONE_WEBHOOK_URL present?", !!DRONE_WEBHOOK_URL);
console.log("Boot: QUICKBOOKS_WEBHOOK_URL present?", !!QUICKBOOKS_WEBHOOK_URL);
console.log("Boot: DRONE_MENTION =", DRONE_MENTION);

// --- BODY PARSER (keeps rawBody for future real signature checks) ---
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);

// --- SIGNATURE VERIFICATION (TEST MODE: always true for now) ---
function verifyAryeoSignature(rawBody, signatureHeader) {
  console.warn("⚠️ Skipping signature verification (TEST MODE).");
  return true;

  // When you're ready for real HMAC verification, swap in logic like:
  //
  // const crypto = require("crypto");
  // if (!signatureHeader || !ARYEO_WEBHOOK_SECRET) return false;
  // const expected = crypto
  //   .createHmac("sha256", ARYEO_WEBHOOK_SECRET)
  //   .update(rawBody, "utf8")
  //   .digest("hex");
  // return crypto.timingSafeEqual(
  //   Buffer.from(expected, "hex"),
  //   Buffer.from(signatureHeader, "hex")
  // );
}

// ---------------------------------------------------------
// SHARED HELPERS
// ---------------------------------------------------------

// DRONE detection config based on your product list
const DRONE_PRODUCT_NAMES = [
  "pro package",
  "plus package",
  "property listing video",
  "drone video",
  "drone photos",
  "zillow showcase tour package + drone",
  "zillow showcase + 40 photos + drone + 60-second video package",
  "add drone photos?",
  "community photos",
];

const DRONE_KEYWORDS = ["drone", "aerial"];

// Generic Discord helper
async function sendToDiscord(webhookUrl, content) {
  if (!webhookUrl) {
    console.error("❌ Missing Discord webhook URL for this notification");
    return;
  }

  try {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    console.log("📨 Discord status:", resp.status);
  } catch (err) {
    console.error("❌ Error sending to Discord:", err);
  }
}

// Fetch order details from Aryeo so we can inspect items
async function fetchOrder(orderId) {
  if (!ARYEO_API_KEY) {
    console.error("❌ ARYEO_API_KEY missing, cannot fetch order");
    return null;
  }

  try {
    const url = `https://api.aryeo.com/v1/orders/${orderId}?include=items`;
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${ARYEO_API_KEY}`,
        Accept: "application/json",
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(
        "❌ Aryeo order fetch failed:",
        resp.status,
        resp.statusText,
        text
      );
      return null;
    }

    const json = await resp.json();
    return json.data || null;
  } catch (err) {
    console.error("❌ Error calling Aryeo API:", err);
    return null;
  }
}

// Decide whether an order includes a drone product
function orderRequiresDrone(order) {
  if (!order?.items) return false;

  for (const item of order.items) {
    const label = (item.title || item.name || "").toLowerCase();

    if (!label) continue;

    // match against known product names
    if (DRONE_PRODUCT_NAMES.some((name) => label.includes(name))) {
      return true;
    }

    // or any “drone / aerial” keyword
    if (DRONE_KEYWORDS.some((kw) => label.includes(kw))) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------
// EVENT HANDLERS
// ---------------------------------------------------------

// ORDER_CREATED → send to DRONE channel (always sends; marks drone yes/no/unknown)
async function handleOrderCreated(activity) {
  const { occurred_at, resource } = activity;
  const orderId = resource?.id;

  let orderTitle = orderId;
  let requiresDrone = null; // null = unknown, true/false = known

  if (!orderId) {
    console.log("ℹ️ ORDER_CREATED with no orderId in resource");
  } else if (!ARYEO_API_KEY) {
    console.log("❌ ARYEO_API_KEY missing, cannot check for drone products.");
  } else {
    // Try to fetch from Aryeo and detect drone
    const order = await fetchOrder(orderId);
    if (order) {
      orderTitle = order.title || order.identifier || orderId;
      requiresDrone = orderRequiresDrone(order);
    } else {
      console.log("ℹ️ No order data returned from Aryeo, cannot determine drone.");
    }
  }

  let droneFlagLabel = "unknown";

  if (requiresDrone === true) droneFlagLabel = "yes";
  if (requiresDrone === false) droneFlagLabel = "no";

  let message =
    `🆕 **New Order Created**\n` +
    `• Order: \`${orderTitle}\`\n` +
    `• Order ID: \`${orderId}\`\n` +
    `• Time (UTC): ${occurred_at}\n` +
    `• Drone Required: \`${droneFlagLabel}\``;

  if (requiresDrone === true) {
    message += `\n\n🚁 **Drone Package Detected** — ${DRONE_MENTION || "@DronePilot"}, please check FAA airspace for this location.`;
  }

  await sendToDiscord(DRONE_WEBHOOK_URL, message, "DRONE");
}

// ORDER_PAYMENT_RECEIVED → used for QuickBooks / payment notifications
async function handleOrderPaymentReceived(activity) {
  const { occurred_at, resource } = activity;
  const orderId = resource?.id;

  // You can enrich this later by fetching order details too if you want
  const message =
    `💳 **Payment Received**\n` +
    `• Order ID: \`${orderId}\`\n` +
    `• Time (UTC): ${occurred_at}`;

  await sendToDiscord(QUICKBOOKS_WEBHOOK_URL, message);
}

// ---------------------------------------------------------
// ACTIVITY NAME → HANDLER MAP
// ---------------------------------------------------------

const activityHandlers = {
  ORDER_CREATED: handleOrderCreated,
  ORDER_PAYMENT_RECEIVED: handleOrderPaymentReceived,
  // In the future:
  // LISTING_DELIVERED: handleListingDelivered,
  // ORDER_CANCELLED: handleOrderCancelled,
  // etc...
};

// ---------------------------------------------------------
// MAIN WEBHOOK ROUTE
// ---------------------------------------------------------

app.post("/aryeo-webhook", async (req, res) => {
  try {
    const signature = req.get("Signature");

    if (!verifyAryeoSignature(req.rawBody, signature)) {
      console.warn("❌ Invalid signature");
      return res.status(400).send("Invalid signature");
    }

    const activity = req.body;
    console.log("📥 Activity received:", activity);

    const { name } = activity || {};
    const handler = activityHandlers[name];

    if (handler) {
      await handler(activity);
    } else {
      console.log("ℹ️ No handler registered for activity:", name);
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("💥 Error in /aryeo-webhook handler:", err);
    return res.status(500).send("Server error");
  }
});

// Simple root route for sanity checks
app.get("/", (req, res) => {
  res.send("Aryeo → Discord webhook is running.");
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});