// server.js
const express = require("express");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

// --- ENV VARS ---
const ARYEO_WEBHOOK_SECRET = process.env.ARYEO_WEBHOOK_SECRET; // not used in TEST mode
const ARYEO_API_KEY = process.env.ARYEO_API_KEY;

const DRONE_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL_DRONE;
const QUICKBOOKS_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL_QUICKBOOKS;
const DRONE_MENTION = process.env.DRONE_MENTION || "@DronePilot";

// Map Aryeo user names -> Discord mentions
// Adjust the keys ("Julian Garcia", "Que Mckenzie") to match
// exactly how Aryeo returns their names in appointments.users.
const PHOTOGRAPHER_DISCORD_MAP = {
  "Julian Garcia": "<@294642333352198148>",
  "Que Mckenzie": "<@242693007453847552>",
};

console.log("Boot: ARYEO_WEBHOOK_SECRET present?", !!ARYEO_WEBHOOK_SECRET);
console.log("Boot: ARYEO_API_KEY present?", !!ARYEO_API_KEY);
console.log("Boot: DRONE_WEBHOOK_URL present?", !!DRONE_WEBHOOK_URL);
console.log("Boot: QUICKBOOKS_WEBHOOK_URL present?", !!QUICKBOOKS_WEBHOOK_URL);
console.log("Boot: DRONE_MENTION =", DRONE_MENTION);

// --- BODY PARSER (keep rawBody in case we later validate signatures) ---
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);

// --- SIGNATURE VERIFICATION (TEST MODE: always allow) ---
function verifyAryeoSignature(rawBody, signatureHeader) {
  console.warn("⚠️ Skipping signature verification (TEST MODE).");
  return true;
}

// ---------------------------------------------------------
// SHARED HELPERS
// ---------------------------------------------------------

// Format ISO date/time to US Eastern
function formatToEastern(isoString) {
  if (!isoString) {
    return { date: "unknown", time: "unknown" };
  }

  const d = new Date(isoString);
  if (isNaN(d.getTime())) {
    return { date: "unknown", time: "unknown" };
  }

  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "short",
    day: "2-digit",
  });

  const timeFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  });

  return {
    date: dateFormatter.format(d),         // e.g. "Feb 01, 2025"
    time: timeFormatter.format(d) + " ET", // e.g. "10:30 AM ET"
  };
}

async function sendToDiscord(webhookUrl, payload, contextLabel = "") {
  if (!webhookUrl) {
    console.error(`❌ Missing Discord webhook URL for [${contextLabel || "notification"}]`);
    return;
  }

  const body =
    typeof payload === "string"
      ? { content: payload }
      : payload;

  try {
    console.log(`➡️ Sending to Discord [${contextLabel}]…`);
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    console.log(`📨 Discord status [${contextLabel}]:`, resp.status);
    if (!resp.ok) {
      const text = await resp.text();
      console.error("❌ Discord error response:", text);
    }
  } catch (err) {
    console.error(`❌ Error sending to Discord [${contextLabel}]:`, err);
  }
}

function buildGoogleMapsUrl(addressString) {
  if (!addressString) return null;
  const encoded = encodeURIComponent(addressString);
  return `https://www.google.com/maps/search/?api=1&query=${encoded}`;
}

// Very simple drone-detection helper.
// Adjust keywords if your product names change.
function orderRequiresDrone(order) {
  const droneKeywords = [
    "drone",
    "aerial",
    "plus package",
    "pro package",
    "property listing video", // you said this uses drone when permitted
  ];

  const items = order.items || order.order_items || [];

  if (!Array.isArray(items) || items.length === 0) {
    console.log("ℹ️ No order items found when checking for drone.");
    return null; // unknown
  }

  const itemsLower = items.map((item) => {
    const name =
      item.name ||
      item.product_name ||
      item.title ||
      "";
    return name.toLowerCase();
  });

  const hit = droneKeywords.find((kw) =>
    itemsLower.some((name) => name.includes(kw))
  );

  if (hit) {
    console.log("🚁 Drone detected via keyword:", hit);
    return true;
  }

  console.log("ℹ️ No drone keywords detected in order items.");
  return false;
}

// Fetch order details from Aryeo.
async function fetchOrder(orderId) {
  if (!ARYEO_API_KEY) {
    console.log("❌ ARYEO_API_KEY missing, cannot fetch order.");
    return null;
  }

  // NOTE: `address` is NOT allowed in include list.
  // We include listing and then use listing.address.
  const url =
    `https://api.aryeo.com/v1/orders/${orderId}` +
    `?include=items,listing,customer,appointments,appointments.users`;

  try {
    console.log("🔍 Fetching order from Aryeo:", url);
    const resp = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${ARYEO_API_KEY}`,
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error("❌ Aryeo order fetch failed:", resp.status, text);
      return null;
    }

    const json = await resp.json();
    const order = json.data || json.order || json;
    console.log("✅ Aryeo order fetch success. Sample:", {
      id: order.id,
      number: order.number,
      title: order.title,
      hasListing: !!order.listing,
      hasCustomer: !!order.customer,
      appointmentsType: Array.isArray(order.appointments)
        ? `array(${order.appointments.length})`
        : typeof order.appointments,
    });

    // Helpful once to see the appointment structure:
    if (Array.isArray(order.appointments) && order.appointments.length > 0) {
      console.log(
        "📝 First appointment users:",
        JSON.stringify(order.appointments[0].users || [], null, 2)
      );
    }

    return order;
  } catch (err) {
    console.error("💥 Error fetching order from Aryeo:", err);
    return null;
  }
}

// ---------------------------------------------------------
// EVENT HANDLERS
// ---------------------------------------------------------

// ORDER_CREATED → drone channel, with order & appointment info
async function handleOrderCreated(activity) {
  const { resource } = activity || {};
  const orderId = resource?.id;

  if (!orderId) {
    console.warn("ORDER_CREATED event missing resource.id");
    return;
  }

  let orderNumber = null;
  let orderStatusUrl = null;
  let orderTitle = orderId;

  let appointmentDate = "unknown";
  let appointmentTime = "unknown";

  let propertyAddress = "unknown";
  let mapsUrl = null;

  let customerName = "unknown";
  let requiresDrone = null; // null = unknown, true/false = known
  let serviceSummary = "unknown";

  let photographerNames = [];
  let photographerMentions = [];

  const order = await fetchOrder(orderId);

  if (order) {
    orderTitle = order.title || order.identifier || orderId;
    orderNumber = order.number || null;
    orderStatusUrl = order.status_url || order.payment_url || null;

    // Customer / client name
    if (order.customer && order.customer.name) {
      customerName = order.customer.name;
    }

    // Address – prefer listing.address, fallback to order.address if it exists
    if (order.listing && order.listing.address) {
      const addr = order.listing.address;
      propertyAddress =
        addr.unparsed_address ||
        [
          addr.address_line_1,
          addr.address_line_2,
          addr.city,
          addr.state_or_province || addr.state,
          addr.postal_code,
        ]
          .filter(Boolean)
          .join(", ") ||
        "unknown";

      mapsUrl = buildGoogleMapsUrl(propertyAddress);
    } else if (order.address) {
      // Fallback in case order.address is actually present for you
      const addr = order.address;
      propertyAddress =
        addr.unparsed_address ||
        [
          addr.street_number,
          addr.street_name,
          addr.city,
          addr.state_or_province || addr.state,
          addr.postal_code,
        ]
          .filter(Boolean)
          .join(", ") ||
        "unknown";

      mapsUrl = buildGoogleMapsUrl(propertyAddress);
    }

    // Appointment – take first appointment if present
    if (Array.isArray(order.appointments) && order.appointments.length > 0) {
      const appt = order.appointments[0];
      const appointmentRaw = appt.start_at || appt.scheduled_at || appt.date || null;

      if (appointmentRaw && typeof appointmentRaw === "string") {
        const formatted = formatToEastern(appointmentRaw);
        appointmentDate = formatted.date;
        appointmentTime = formatted.time;
      }

      // Assigned users (photographers) on this appointment
      if (Array.isArray(appt.users) && appt.users.length > 0) {
        appt.users.forEach((u) => {
          const userName =
            u.name ||
            [u.first_name, u.last_name].filter(Boolean).join(" ") ||
            null;

          if (userName) {
            photographerNames.push(userName);

            const mention = PHOTOGRAPHER_DISCORD_MAP[userName];
            if (mention) {
              photographerMentions.push(mention);
            }
          }
        });
      }
    }

    // Service: summarize order items
    const items = order.items || order.order_items || [];
    if (Array.isArray(items) && items.length > 0) {
      const names = items
        .map((item) => item.name || item.product_name || item.title)
        .filter(Boolean);

      if (names.length === 1) {
        serviceSummary = names[0];
      } else if (names.length > 1) {
        const firstFew = names.slice(0, 3).join(", ");
        serviceSummary =
          names.length > 3
            ? `${firstFew} (+${names.length - 3} more)`
            : firstFew;
      }
    }

    // Drone detection
    requiresDrone = orderRequiresDrone(order);
  }

  // If we’re confident it’s NOT a drone job, skip notifying this channel
  if (requiresDrone === false) {
    console.log("ℹ️ Order does not appear to include drone services; skipping drone notification.");
    return;
  }

  // Build label "Order #1234" or fallback to title/ID
  const orderLabel =
    (orderNumber && `Order #${orderNumber}`) ||
    orderTitle ||
    orderId;

  // Build a cleaner Drone notification message
  let lines = [];

  lines.push("🚁 **New Drone Order – Airspace Check Needed**");
  lines.push("");

  lines.push("**Order**");
  if (orderStatusUrl) {
    lines.push(`• Order #: [${orderLabel}](${orderStatusUrl})`);
  } else {
    lines.push(`• Order #: \`${orderLabel}\``);
  }

  if (customerName !== "unknown") {
    lines.push(`• Client: \`${customerName}\``);
  }

  lines.push(`• Service: \`${serviceSummary}\``);

  if (photographerNames.length > 0) {
    const label =
      photographerNames.length === 1
        ? photographerNames[0]
        : photographerNames.join(", ");
    lines.push(`• Photographer: \`${label}\``);
  }

  lines.push("");
  lines.push("**Appointment**");
  lines.push(`• Date: \`${appointmentDate}\``);
  lines.push(`• Time: \`${appointmentTime}\``);
  lines.push(`• Location: \`${propertyAddress}\``);

  if (mapsUrl) {
    lines.push(`• Map: ${mapsUrl}`);
  }

  lines.push("");
  lines.push("**Action for Drone Team**");
  lines.push("• Use the Air Control app to verify airspace for this location.");
  lines.push("• Confirm: Allowed / Restricted / Permit Required.");

  // Mentions: prefer specific shooters if we recognized them; otherwise use generic role
  if (photographerMentions.length > 0) {
    lines.push("");
    lines.push(photographerMentions.join(" "));
  } else if (DRONE_MENTION) {
    lines.push("");
    lines.push(DRONE_MENTION);
  }

  const content = lines.join("\n");

  await sendToDiscord(DRONE_WEBHOOK_URL, { content }, "DRONE-ORDER_CREATED");
}

// ORDER_PAYMENT_RECEIVED → QuickBooks channel
async function handleOrderPaymentReceived(activity) {
  const { occurred_at, resource } = activity || {};
  const orderId = resource?.id;

  if (!orderId) {
    console.warn("ORDER_PAYMENT_RECEIVED event missing resource.id");
    return;
  }

  let orderTitle = orderId;
  let orderNumber = null;
  let orderStatusUrl = null;
  let customerName = "unknown";

  const order = await fetchOrder(orderId);

  if (order) {
    orderTitle = order.title || order.identifier || orderId;
    orderNumber = order.number || null;
    orderStatusUrl =
      order.status_url || order.invoice_url || order.payment_url || null;

    if (order.customer && order.customer.name) {
      customerName = order.customer.name;
    }
  }

  const label =
    (orderNumber && `Order #${orderNumber}`) ||
    orderTitle ||
    orderId;

  let lines = [];
  lines.push("💳 **Payment Received**");
  lines.push("");
  if (orderStatusUrl) {
    lines.push(`• Order: [${label}](${orderStatusUrl})`);
  } else {
    lines.push(`• Order: \`${label}\``);
  }
  lines.push(`• Order ID: \`${orderId}\``);
  if (customerName !== "unknown") {
    lines.push(`• Client: \`${customerName}\``);
  }

  const content = lines.join("\n");

  await sendToDiscord(QUICKBOOKS_WEBHOOK_URL, { content }, "QB-PAYMENT_RECEIVED");
}

// ---------------------------------------------------------
// ACTIVITY NAME → HANDLER MAP
// ---------------------------------------------------------

const activityHandlers = {
  ORDER_CREATED: handleOrderCreated,
  ORDER_PAYMENT_RECEIVED: handleOrderPaymentReceived,
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

// ---------------------------------------------------------
// SIMPLE TEST ROUTES (no Aryeo involved)
// ---------------------------------------------------------

app.get("/test-drone", async (req, res) => {
  await sendToDiscord(
    DRONE_WEBHOOK_URL,
    {
      content: "🧪 Test message to **Drone** channel from `/test-drone`",
    },
    "DRONE-TEST"
  );
  res.send("Sent test message to Drone Discord webhook (if configured).");
});

app.get("/test-quickbooks", async (req, res) => {
  await sendToDiscord(
    QUICKBOOKS_WEBHOOK_URL,
    {
      content: "🧪 Test message to **QuickBooks** channel from `/test-quickbooks`",
    },
    "QB-TEST"
  );
  res.send("Sent test message to QuickBooks Discord webhook (if configured).");
});

// Root sanity route
app.get("/", (req, res) => {
  res.send("Aryeo → Discord webhook is running.");
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});