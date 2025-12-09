// server.js
const express = require("express");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

// --- ENV VARS ---
// For real HMAC verification later if you want:
const ARYEO_WEBHOOK_SECRET = process.env.ARYEO_WEBHOOK_SECRET;

// API key used to call Aryeo REST API
const ARYEO_API_KEY = process.env.ARYEO_API_KEY;

// Discord webhooks
const DRONE_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL_DRONE;
const QUICKBOOKS_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL_QUICKBOOKS;
const BOOKINGS_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL_BOOKINGS;

// Generic role mention if no specific shooter is found
const DRONE_MENTION = process.env.DRONE_MENTION || "@DronePilot";

// Map Aryeo user names -> Discord mentions
// Make sure these match *exactly* how Aryeo returns the name.
const PHOTOGRAPHER_DISCORD_MAP = {
  "Julian Garcia": "<@294642333352198148>",
  "Que Mckenzie": "<@242693007453847552>",
};

console.log("Boot: ARYEO_WEBHOOK_SECRET present?", !!ARYEO_WEBHOOK_SECRET);
console.log("Boot: ARYEO_API_KEY present?", !!ARYEO_API_KEY);
console.log("Boot: DRONE_WEBHOOK_URL present?", !!DRONE_WEBHOOK_URL);
console.log("Boot: QUICKBOOKS_WEBHOOK_URL present?", !!QUICKBOOKS_WEBHOOK_URL);
console.log("Boot: BOOKINGS_WEBHOOK_URL present?", !!BOOKINGS_WEBHOOK_URL);
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
    date: dateFormatter.format(d), // e.g. "Dec 04, 2025"
    time: timeFormatter.format(d) + " ET", // e.g. "9:30 AM ET"
  };
}

async function sendToDiscord(webhookUrl, payload, contextLabel = "") {
  if (!webhookUrl) {
    console.error(
      `❌ Missing Discord webhook URL for [${contextLabel || "notification"}]`
    );
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
      hasCustomer: !!order.customer,
      appointmentsType: Array.isArray(order.appointments)
        ? `array(${order.appointments.length})`
        : typeof order.appointments,
    });

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

    // Prefer listing.address if present
    if (order.listing && order.listing.address && order.listing.address.full_address) {
      propertyAddress = order.listing.address.full_address;
    } else if (order.address && order.address.full_address) {
      // fallback if you ever add "address" as allowed include
      propertyAddress = order.address.full_address;
    }

    if (propertyAddress && propertyAddress !== "unknown") {
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
    console.log(
      "ℹ️ Order does not appear to include drone services; skipping drone notification."
    );
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

  const when = formatToEastern(occurred_at);

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
  lines.push(`• Time: \`${when.date} – ${when.time}\``);

  const content = lines.join("\n");

  await sendToDiscord(
    QUICKBOOKS_WEBHOOK_URL,
    { content },
    "QB-PAYMENT_RECEIVED"
  );
}

// ❌ ORDER CANCELED → bookings channel
async function handleOrderCanceled(activity) {
  const { occurred_at, resource } = activity || {};
  const orderId = resource?.id;

  if (!orderId) {
    console.warn("ORDER_CANCELED event missing resource.id");
    return;
  }

  let orderTitle = orderId;
  let orderNumber = null;
  let customerName = "unknown";
  let serviceSummary = "unknown";

  const order = await fetchOrder(orderId);

  if (order) {
    orderTitle = order.title || order.identifier || orderId;
    orderNumber = order.number || null;

    if (order.customer && order.customer.name) {
      customerName = order.customer.name;
    }

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
  }

  const label =
    (orderNumber && `Order #${orderNumber}`) ||
    orderTitle ||
    orderId;

  const when = formatToEastern(occurred_at);
  const reason =
    activity.reason ||
    (activity.metadata && activity.metadata.reason) ||
    null;

  let lines = [];
  lines.push("❌ **Order Cancelled**");
  lines.push("");
  lines.push(`• Order: \`${label}\``);
  if (customerName !== "unknown") {
    lines.push(`• Client: \`${customerName}\``);
  }
  if (serviceSummary !== "unknown") {
    lines.push(`• Service: \`${serviceSummary}\``);
  }
  lines.push(`• Cancelled at: \`${when.date} – ${when.time}\``);
  if (reason) {
    lines.push(`• Reason: \`${reason}\``);
  }

  const content = lines.join("\n");
  await sendToDiscord(
    BOOKINGS_WEBHOOK_URL,
    { content },
    "BOOKINGS-ORDER_CANCELED"
  );
}

// 🔁 APPOINTMENT RESCHEDULED → bookings channel
async function handleAppointmentRescheduled(activity) {
  const { occurred_at, resource } = activity || {};

  const appointmentId = resource?.id;
  const orderId = resource?.order_id || resource?.order?.id;

  let orderLabel = orderId || "unknown";
  let customerName = "unknown";
  let appointmentDate = "unknown";
  let appointmentTime = "unknown";
  let propertyAddress = "unknown";
  let mapsUrl = null;

  // If we can see an order_id, try to pull richer info from the order
  if (orderId) {
    const order = await fetchOrder(orderId);
    if (order) {
      const orderNumber = order.number || null;
      const orderTitle = order.title || order.identifier || orderId;

      orderLabel =
        (orderNumber && `Order #${orderNumber}`) ||
        orderTitle ||
        orderId;

      if (order.customer && order.customer.name) {
        customerName = order.customer.name;
      }

      if (order.listing && order.listing.address && order.listing.address.full_address) {
        propertyAddress = order.listing.address.full_address;
      } else if (order.address && order.address.full_address) {
        propertyAddress = order.address.full_address;
      }

      if (propertyAddress && propertyAddress !== "unknown") {
        mapsUrl = buildGoogleMapsUrl(propertyAddress);
      }

      if (Array.isArray(order.appointments) && order.appointments.length > 0) {
        const appt = order.appointments[0];
        const appointmentRaw =
          appt.start_at || appt.scheduled_at || appt.date || null;

        if (appointmentRaw && typeof appointmentRaw === "string") {
          const formatted = formatToEastern(appointmentRaw);
          appointmentDate = formatted.date;
          appointmentTime = formatted.time;
        }
      }
    }
  } else {
    // Fallback: try to pull directly off the resource in case Aryeo sends an appointment object
    const appointmentRaw =
      resource?.start_at || resource?.scheduled_at || resource?.date || null;
    if (appointmentRaw && typeof appointmentRaw === "string") {
      const formatted = formatToEastern(appointmentRaw);
      appointmentDate = formatted.date;
      appointmentTime = formatted.time;
    }
  }

  const changeWhen = formatToEastern(occurred_at);

  let lines = [];
  lines.push("🔁 **Appointment Rescheduled**");
  lines.push("");
  if (appointmentId) {
    lines.push(`• Appointment ID: \`${appointmentId}\``);
  }
  if (orderLabel !== "unknown") {
    lines.push(`• Order: \`${orderLabel}\``);
  }
  if (customerName !== "unknown") {
    lines.push(`• Client: \`${customerName}\``);
  }
  lines.push("");
  lines.push("**New Appointment Time**");
  lines.push(`• Date: \`${appointmentDate}\``);
  lines.push(`• Time: \`${appointmentTime}\``);
  if (propertyAddress !== "unknown") {
    lines.push(`• Location: \`${propertyAddress}\``);
  }
  if (mapsUrl) {
    lines.push(`• Map: ${mapsUrl}`);
  }
  lines.push("");
  lines.push(
    `• Change recorded at: \`${changeWhen.date} – ${changeWhen.time}\``
  );

  const content = lines.join("\n");
  await sendToDiscord(
    BOOKINGS_WEBHOOK_URL,
    { content },
    "BOOKINGS-APPOINTMENT_RESCHEDULED"
  );
}

// 👥 Photographer assignment change → bookings channel
async function handlePhotographerAssignmentChanged(activity) {
  const { occurred_at, resource, name } = activity || {};

  const appointmentId = resource?.id || resource?.appointment_id;
  const orderId = resource?.order_id || resource?.order?.id;

  let shooterNames = [];
  let shooterMentions = [];

  if (resource?.user) {
    const u = resource.user;
    const userName =
      u.name ||
      [u.first_name, u.last_name].filter(Boolean).join(" ") ||
      null;
    if (userName) {
      shooterNames.push(userName);
      const mention = PHOTOGRAPHER_DISCORD_MAP[userName];
      if (mention) shooterMentions.push(mention);
    }
  } else if (Array.isArray(resource?.users)) {
    resource.users.forEach((u) => {
      const userName =
        u.name ||
        [u.first_name, u.last_name].filter(Boolean).join(" ") ||
        null;
      if (userName) {
        shooterNames.push(userName);
        const mention = PHOTOGRAPHER_DISCORD_MAP[userName];
        if (mention) shooterMentions.push(mention);
      }
    });
  }

  const changeWhen = formatToEastern(occurred_at);

  const direction = name && name.toUpperCase().includes("UNASSIGN")
    ? "unassigned from"
    : "assigned to";

  let lines = [];
  lines.push("👥 **Photographer Assignment Updated**");
  lines.push("");
  if (appointmentId) {
    lines.push(`• Appointment ID: \`${appointmentId}\``);
  }
  if (orderId) {
    lines.push(`• Order ID: \`${orderId}\``);
  }
  if (shooterNames.length > 0) {
    const label =
      shooterNames.length === 1
        ? shooterNames[0]
        : shooterNames.join(", ");
    lines.push(`• Photographer(s) ${direction} appointment: \`${label}\``);
  } else {
    lines.push("• Photographer(s) changed (names not parsed).");
  }
  lines.push(`• Change recorded at: \`${changeWhen.date} – ${changeWhen.time}\``);

  if (shooterMentions.length > 0) {
    lines.push("");
    lines.push(shooterMentions.join(" "));
  }

  const content = lines.join("\n");
  await sendToDiscord(
    BOOKINGS_WEBHOOK_URL,
    { content },
    "BOOKINGS-PHOTOGRAPHER_ASSIGNMENT"
  );
}

// ---------------------------------------------------------
// ACTIVITY NAME → HANDLER MAP
// ---------------------------------------------------------
//
// ⚠️ Names here are our best guess based on Aryeo’s conventions.
// When you see real activity.name values coming through from Aryeo,
// update these keys to match exactly.

const activityHandlers = {
  ORDER_CREATED: handleOrderCreated,
  ORDER_PAYMENT_RECEIVED: handleOrderPaymentReceived,

  // Order cancelled (Aryeo might use either spelling)
  ORDER_CANCELED: handleOrderCanceled,
  ORDER_CANCELLED: handleOrderCanceled,

  // Appointment rescheduled
  APPOINTMENT_RESCHEDULED: handleAppointmentRescheduled,

  // Photographer assignment changes (adjust once you see real names)
  APPOINTMENT_USER_ASSIGNED: handlePhotographerAssignmentChanged,
  APPOINTMENT_USER_UNASSIGNED: handlePhotographerAssignmentChanged,
  APPOINTMENT_USERS_CHANGED: handlePhotographerAssignmentChanged,
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

app.get("/test-bookings", async (req, res) => {
  await sendToDiscord(
    BOOKINGS_WEBHOOK_URL,
    {
      content: "🧪 Test message to **Bookings** channel from `/test-bookings`",
    },
    "BOOKINGS-TEST"
  );
  res.send("Sent test message to Bookings Discord webhook (if configured).");
});

// Root sanity route
app.get("/", (req, res) => {
  res.send("Aryeo → Discord webhook is running.");
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});