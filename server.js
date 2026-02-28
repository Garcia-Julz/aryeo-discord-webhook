// server.js
const express = require("express");
const fetch = require("node-fetch");
const cron = require("node-cron");

const app = express();
const PORT = process.env.PORT || 3000;

// --- PHONE DISPLAY (Discord) ---
// Safer default: mask phone in Discord logs
const SHOW_FULL_CLIENT_PHONE_IN_DISCORD =
  (process.env.SHOW_FULL_CLIENT_PHONE_IN_DISCORD || "").toLowerCase() === "true"; // set env var true to show full phone

// --- ENV VARS ---
// --- SMRTPHONE (SMS) ---
const SMRTPHONE_API_KEY = process.env.SMRTPHONE_API_KEY;
const SMRTPHONE_FROM_NUMBER = process.env.SMRTPHONE_FROM_NUMBER; // digits only (e.g. 18135551234)
const SMRTPHONE_TEST_TOKEN = process.env.SMRTPHONE_TEST_TOKEN; // protect test route
const SMRTPHONE_DRY_RUN =
  (process.env.SMRTPHONE_DRY_RUN || "").toLowerCase() === "true";

// For real HMAC verification later if you want:
const ARYEO_WEBHOOK_SECRET = process.env.ARYEO_WEBHOOK_SECRET;

// API key used to call Aryeo REST API
const ARYEO_API_KEY = process.env.ARYEO_API_KEY;

// Base URL for your Aryeo dashboard (used to build order links)
const ARYEO_ADMIN_BASE_URL =
  process.env.ARYEO_ADMIN_BASE_URL || "https://textured-media.aryeo.com";

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

console.log("Boot: SMRTPHONE_API_KEY present?", !!SMRTPHONE_API_KEY);
console.log("Boot: SMRTPHONE_FROM_NUMBER present?", !!SMRTPHONE_FROM_NUMBER);
console.log("Boot: SMRTPHONE_TEST_TOKEN present?", !!SMRTPHONE_TEST_TOKEN);
console.log("Boot: SMRTPHONE_DRY_RUN =", SMRTPHONE_DRY_RUN);
console.log(
  "Boot: SHOW_FULL_CLIENT_PHONE_IN_DISCORD =",
  SHOW_FULL_CLIENT_PHONE_IN_DISCORD
);

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

// Normalize a datetime to YYYY-MM-DD in US Eastern
function getEasternYMD(isoString) {
  if (!isoString) return null;

  const d = new Date(isoString);
  if (isNaN(d.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);

  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;

  if (!year || !month || !day) return null;
  return `${year}-${month}-${day}`; // YYYY-MM-DD
}

async function sendToDiscord(webhookUrl, payload, contextLabel = "") {
  if (!webhookUrl) {
    console.error(
      `❌ Missing Discord webhook URL for [${contextLabel || "notification"}]`
    );
    return;
  }

  const body = typeof payload === "string" ? { content: payload } : payload;

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

// --- SMRTPHONE helper ---
async function sendSmrtPhoneSms({ from, to, message }) {
  if (!SMRTPHONE_API_KEY) {
    console.error("❌ Missing SMRTPHONE_API_KEY");
    return { ok: false, error: "Missing SMRTPHONE_API_KEY" };
  }
  if (!from || !to || !message) {
    console.error("❌ sendSmrtPhoneSms missing from/to/message");
    return { ok: false, error: "Missing from/to/message" };
  }

  const url = "https://phone.smrt.studio/sms/send";

  const params = new URLSearchParams({
    from: String(from),
    to: String(to),
    message: String(message),
  });

  if (SMRTPHONE_DRY_RUN) {
    console.log("🧪 SMRTPHONE_DRY_RUN enabled. Would send:", {
      url,
      headers: { "X-Auth-smrtPhone": "***" },
      body: params.toString(),
    });
    return { ok: true, dryRun: true };
  }

  try {
    console.log("➡️ Sending SMS via smrtPhone…", { to, from });

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "X-Auth-smrtPhone": SMRTPHONE_API_KEY,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const text = await resp.text();
    console.log("📨 smrtPhone status:", resp.status);

    if (!resp.ok) {
      console.error("❌ smrtPhone error response:", text);
      return { ok: false, status: resp.status, body: text };
    }

    return { ok: true, status: resp.status, body: text };
  } catch (err) {
    console.error("💥 Error sending smrtPhone SMS:", err);
    return { ok: false, error: String(err) };
  }
}

// ---------------------------------------------------------
// PHONE HELPERS (for Discord output)
// ---------------------------------------------------------

function normalizePhoneString(raw) {
  if (!raw || typeof raw !== "string") return null;
  const cleaned = raw.trim();
  return cleaned ? cleaned : null;
}

// Try lots of likely field names + also scan keys that contain "phone"
function extractPhoneFromCustomer(customer) {
  if (!customer || typeof customer !== "object") return null;

  // Common candidates first
  const directCandidates = [
    customer.phone,
    customer.phone_number,
    customer.mobile,
    customer.mobile_phone,
    customer.cell,
    customer.cell_phone,
    customer.primary_phone,
    customer.contact_phone,
    customer.telephone,
  ]
    .map(normalizePhoneString)
    .filter(Boolean);

  if (directCandidates.length > 0) return directCandidates[0];

  // Fallback: scan any key containing "phone"
  for (const [k, v] of Object.entries(customer)) {
    if (typeof v !== "string") continue;
    if (k.toLowerCase().includes("phone")) {
      const candidate = normalizePhoneString(v);
      if (candidate) return candidate;
    }
  }

  return null;
}

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;

  // US numbers with optional leading 1
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length === 10) return digits;

  // fallback (intl or weird formats)
  return digits;
}

function formatPhoneUS(digits) {
  if (!digits) return null;
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return digits;
}

function maskPhone(formattedOrDigits) {
  if (!formattedOrDigits) return null;
  const digits = String(formattedOrDigits).replace(/\D/g, "");
  if (digits.length < 4) return "***";
  const last4 = digits.slice(-4);
  return `***-***-${last4}`;
}

function getClientPhoneLabel(customer) {
  const raw = extractPhoneFromCustomer(customer);
  if (!raw) return null;

  const normalized = normalizePhone(raw);
  if (!normalized) return null;

  const pretty = formatPhoneUS(normalized);

  if (SHOW_FULL_CLIENT_PHONE_IN_DISCORD) return pretty;
  return maskPhone(pretty);
}

// NEW: Use this when you need the real digits for texting (not masked)
function getClientPhoneDigits(customer) {
  const raw = extractPhoneFromCustomer(customer);
  if (!raw) return null;
  return normalizePhone(raw); // returns 10-digit US (or fallback digits)
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
    const name = item.name || item.product_name || item.title || "";
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
    // include only allowed relations (Aryeo does not allow listing.address or address here)
    `?include=items,listing,customer,appointments,appointments.users,payments`;

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
      hasListing: !!order.listing,
      listingHasAddress: !!(
        order.listing &&
        order.listing.address &&
        order.listing.address.full_address
      ),
      hasOrderAddress: !!(order.address && order.address.full_address),
      appointmentsType: Array.isArray(order.appointments)
        ? `array(${order.appointments.length})`
        : typeof order.appointments,
    });

    return order;
  } catch (err) {
    console.error("💥 Error fetching order from Aryeo:", err);
    return null;
  }
}

// Fetch payment-info for an order (extra endpoint Aryeo exposes)
async function fetchOrderPaymentInfo(orderId) {
  if (!ARYEO_API_KEY) {
    console.log("❌ ARYEO_API_KEY missing, cannot fetch order payment-info.");
    return null;
  }

  const url = `https://api.aryeo.com/v1/orders/${orderId}/payment-info`;

  try {
    console.log("🔍 Fetching order payment-info from Aryeo:", url);
    const resp = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${ARYEO_API_KEY}`,
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(
        "❌ Aryeo order payment-info fetch failed:",
        resp.status,
        text
      );
      return null;
    }

    const json = await resp.json();

    // Log once so we can see field names in the Railway logs
    console.log(
      "💰 Payment-info debug for order",
      orderId,
      JSON.stringify(json, null, 2)
    );

    // Some Aryeo endpoints wrap in `data`, some don't
    return json.data || json;
  } catch (err) {
    console.error("💥 Error fetching order payment-info from Aryeo:", err);
    return null;
  }
}

// Fetch appointments for a specific YYYY-MM-DD (Eastern) date
async function fetchAppointmentsForDate(dateIso) {
  if (!ARYEO_API_KEY) {
    console.log("❌ ARYEO_API_KEY missing, cannot fetch appointments.");
    return null;
  }

  const url =
    `https://api.aryeo.com/v1/appointments` +
    `?filter[date]=${dateIso}` +
    `&include=order,order.customer,order.items,order.listing,users`;

  try {
    console.log("🔍 Fetching today's appointments from Aryeo:", url);
    const resp = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${ARYEO_API_KEY}`,
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error("❌ Failed to fetch appointments:", resp.status, text);
      return null;
    }

    const json = await resp.json();
    const appointments = json.data || [];

    // Hard-filter by Eastern local date
    const filtered = appointments.filter((appt) => {
      const raw = appt.start_at || appt.scheduled_at || appt.date || null;
      const apptYmd = raw ? getEasternYMD(raw) : null;
      return apptYmd === dateIso;
    });

    console.log(
      `✅ Appointments for ${dateIso}: raw=${appointments.length}, filtered=${filtered.length}`
    );

    // 🔍 Enrich each appointment with a FULL order object (like the drone handler)
    const enriched = await Promise.all(
      filtered.map(async (appt) => {
        // If we already somehow have a hydrated order, keep it
        if (appt.order && appt.order.listing && appt.order.listing.address) {
          return appt;
        }

        const orderId = appt.order_id || (appt.order && appt.order.id) || null;

        if (!orderId) {
          return appt;
        }

        const fullOrder = await fetchOrder(orderId);
        if (!fullOrder) {
          return appt;
        }

        return {
          ...appt,
          order: fullOrder, // <-- now buildMorningBriefingMessage sees the same shape as drone code
        };
      })
    );

    // Optional: log one appointment to confirm addresses
    if (enriched.length > 0) {
      const sample = enriched[0];
      console.log("🧪 Sample enriched appointment address debug:", {
        orderId: sample.order && sample.order.id,
        listingAddress:
          sample.order &&
          sample.order.listing &&
          sample.order.listing.address &&
          sample.order.listing.address.full_address,
        orderAddress:
          sample.order &&
          sample.order.address &&
          sample.order.address.full_address,
        apptAddress: sample.address && sample.address.full_address,
      });

      // NEW: dump full object so we can see where Aryeo hides the address
      console.log(
        "🧨 FULL ENRICHED APPOINTMENT DUMP:",
        JSON.stringify(sample, null, 2)
      );
    }

    return enriched;
  } catch (err) {
    console.error("💥 Error fetching appointments from Aryeo:", err);
    return null;
  }
}

// Try to build a human-readable address from a generic object
function extractAddressFromObject(obj) {
  if (!obj || typeof obj !== "object") return null;

  // Most likely candidates for the "street" portion
  const primaryFields = [
    "full_address",
    "formatted_address",
    "address",
    "property_full_address", // covers Aryeo property address shapes
    "property_address",
    "address_line1",
    "address1",
    "line1",
    "street1",
    "street",
    "street_line_1",
    "street_line_2",
  ];

  let base = null;
  for (const key of primaryFields) {
    if (typeof obj[key] === "string" && obj[key].trim()) {
      base = obj[key].trim();
      break;
    }
  }

  if (!base) return null;

  // First, try the "nice" explicit keys
  let city = obj.city || obj.locality || obj.town || null;

  let state =
    obj.state ||
    obj.region ||
    obj.province ||
    obj.state_province ||
    obj.state_code ||
    null;

  let postal = obj.postal_code || obj.zip || obj.zip_code || obj.postcode || null;

  // if any of city/state/postal are still missing, scan all string fields and infer by key name
  if (!city || !state || !postal) {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value !== "string") continue;
      const k = key.toLowerCase();
      const v = value.trim();
      if (!v) continue;

      if (!city && k.includes("city")) {
        city = v;
      } else if (
        !state &&
        (k.includes("state") || k.includes("province") || k.includes("region"))
      ) {
        state = v;
      } else if (
        !postal &&
        (k.includes("postal") || k.includes("zip") || k.includes("postcode"))
      ) {
        postal = v;
      }
    }
  }

  const parts = [base];
  if (city) parts.push(city);
  if (state) parts.push(state);
  if (postal) parts.push(postal);

  return parts.join(", ");
}

// Deep scan for any .full_address field anywhere in a nested object
function findAnyFullAddress(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 8) return null;

  if (typeof obj.full_address === "string" && obj.full_address.trim()) {
    return obj.full_address.trim();
  }

  for (const val of Object.values(obj)) {
    if (val && typeof val === "object") {
      const found = findAnyFullAddress(val, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

// Very loose scan for ANY address-like string in a nested object
function findAnyAddressLikeString(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 8) return null;

  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === "string") {
      const k = key.toLowerCase();
      if (
        (k.includes("address") || k.includes("street") || k.includes("line1")) &&
        val.trim().length > 5
      ) {
        return val.trim();
      }
    } else if (val && typeof val === "object") {
      const found = findAnyAddressLikeString(val, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

// Look through all likely places on the appointment + order
function extractAddressFromAppointment(appt) {
  if (!appt) return null;
  const order = appt.order || {};

  // Merge listing.address + listing into one object
  const mergedListing = order.listing
    ? { ...(order.listing.address || {}), ...order.listing }
    : null;

  // Merge order.address + order into one object
  const mergedOrder = Object.keys(order).length
    ? { ...(order.address || {}), ...order }
    : null;

  const candidates = [
    mergedListing,
    mergedOrder,
    order.listing && order.listing.address,
    order.address,
    order.listing,
    order,
    appt.address,
    appt.location,
    appt.property,
    appt,
  ];

  // First try the "known shapes"
  for (const obj of candidates) {
    const addr = extractAddressFromObject(obj);
    if (addr) return addr;
  }

  // Fallback 1: deep-scan only for `.full_address`
  const deepAddr = findAnyFullAddress({ appointment: appt, order });
  if (deepAddr) return deepAddr;

  // Fallback 2: very loose scan for any address-like string
  const looseAddr = findAnyAddressLikeString({ appointment: appt, order });
  if (looseAddr) return looseAddr;

  return null;
}

// Build the Discord message for today's appointments
function buildMorningBriefingMessage(dateIso, appointments) {
  const { date: prettyDate } = formatToEastern(`${dateIso}T00:00:00Z`);

  let lines = [];
  lines.push(`☀️🌆 Daily Schedule – ${prettyDate}`);
  lines.push("");

  if (!appointments || appointments.length === 0) {
    lines.push("• No appointments scheduled today.");
    return lines.join("\n");
  }

  lines.push(`• Total Appointments Today: ${appointments.length}`);
  lines.push("");

  // Detail each appointment
  appointments.forEach((appt, idx) => {
    const order = appt.order || {};
    const customer = order.customer || {};
    const items = order.items || [];
    const users = appt.users || [];

    // Client
    const clientName = customer.name || "Unknown client";
    const clientPhone = getClientPhoneLabel(customer);

    // Time
    const startRaw = appt.start_at || appt.scheduled_at || appt.date || null;
    const when = startRaw
      ? formatToEastern(startRaw)
      : { date: "unknown", time: "unknown" };

    // Address
    let propertyAddress =
      extractAddressFromAppointment(appt) || "Unknown address";

    // Photographer(s)
    let shooterNames = [];
    if (Array.isArray(users) && users.length > 0) {
      shooterNames = users
        .map(
          (u) =>
            u.name ||
            [u.first_name, u.last_name].filter(Boolean).join(" ")
        )
        .filter(Boolean);
    }

    const shootersLabel =
      shooterNames.length === 0 ? "Unassigned" : shooterNames.join(", ");

    // Service summary
    let serviceSummary = "Unknown service";
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

    // Order link
    const orderId = order.id;
    let orderLabel = order.number
      ? `Order #${order.number}`
      : order.title || orderId || "Order";

    const orderStatusUrl =
      order.status_url ||
      order.invoice_url ||
      order.payment_url ||
      (orderId ? `${ARYEO_ADMIN_BASE_URL}/admin/orders/${orderId}/edit` : null);

    lines.push(`**Appointment ${idx + 1}**`);
    lines.push(`• Client: \`${clientName}\``);
    if (clientPhone) lines.push(`• Phone: \`${clientPhone}\``);
    lines.push(`• Time: \`${when.time}\``);
    lines.push(`• Service: \`${serviceSummary}\``);
    lines.push(`• Photographer: \`${shootersLabel}\``);
    lines.push(`• Address: \`${propertyAddress}\``);

    if (orderStatusUrl) {
      lines.push(`• Order: [${orderLabel}](${orderStatusUrl})`);
    }
    lines.push("");
  });

  return lines.join("\n");
}

// Main function to send the morning briefing
async function sendMorningBriefing(dateOverrideIso) {
  // Compute today's date in Eastern if not provided
  let todayEst;
  if (dateOverrideIso) {
    todayEst = dateOverrideIso;
  } else {
    const now = new Date();
    const estDateStr = now.toLocaleDateString("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    todayEst = estDateStr; // YYYY-MM-DD
  }

  console.log("📅 Sending morning briefing for date:", todayEst);

  const appointments = await fetchAppointmentsForDate(todayEst);
  if (!appointments) {
    console.log("⚠️ No appointments data returned, skipping Discord send.");
    return { date: todayEst, count: 0 };
  }

  const content = buildMorningBriefingMessage(todayEst, appointments);

  console.log("➡️ Morning briefing Discord payload:", content);

  await sendToDiscord(
    BOOKINGS_WEBHOOK_URL,
    { content },
    "BOOKINGS-MORNING_BRIEFING"
  );

  return { date: todayEst, count: appointments.length };
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
    if (
      order.listing &&
      order.listing.address &&
      order.listing.address.full_address
    ) {
      propertyAddress = order.listing.address.full_address;
    } else if (order.address && order.address.full_address) {
      propertyAddress = order.address.full_address;
    } else {
      // Fallback to deep scan
      const deepAddr = findAnyFullAddress(order);
      if (deepAddr) {
        propertyAddress = deepAddr;
      }
    }

    if (propertyAddress && propertyAddress !== "unknown") {
      mapsUrl = buildGoogleMapsUrl(propertyAddress);
    }

    // Appointment – take first appointment if present
    if (Array.isArray(order.appointments) && order.appointments.length > 0) {
      const appt = order.appointments[0];
      const appointmentRaw =
        appt.start_at || appt.scheduled_at || appt.date || null;

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
  const orderLabel = (orderNumber && `Order #${orderNumber}`) || orderTitle || orderId;

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

// ORDER_PAYMENT_RECEIVED → QuickBooks channel (billing)
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

  // This is what we will display as the amount.
  let amountLabel = "unknown";

  // 1) Fetch the full order so we can grab number, customer, payments, etc.
  const order = await fetchOrder(orderId);

  if (order) {
    orderTitle = order.title || order.identifier || orderId;
    orderNumber = order.number || null;
    orderStatusUrl =
      order.status_url || order.invoice_url || order.payment_url || null;

    if (order.customer && order.customer.name) {
      customerName = order.customer.name;
    }

    // Try to infer amount from the latest payment on the order
    if (Array.isArray(order.payments) && order.payments.length > 0) {
      const lastPayment = order.payments[order.payments.length - 1];

      console.log(
        "💰 Payments debug for order",
        orderId,
        JSON.stringify(order.payments, null, 2)
      );

      const niceString =
        lastPayment.total_price_formatted ||
        lastPayment.amount_formatted ||
        lastPayment.display_amount ||
        lastPayment.formatted_amount ||
        null;

      if (niceString) {
        amountLabel = niceString;
      } else {
        const numericCandidates = [
          lastPayment.total_price,
          lastPayment.amount,
          lastPayment.subtotal_price,
          lastPayment.payment_intent && lastPayment.payment_intent.amount,
        ].filter((val) => typeof val === "number" && val > 0);

        for (const val of numericCandidates) {
          if (val > 9999) {
            amountLabel = `$${(val / 100).toFixed(2)}`;
          } else {
            amountLabel = `$${val.toFixed(2)}`;
          }
          break;
        }
      }
    }
  }

  // 1b) If we still don't know the amount, try totals on the order itself
  if (amountLabel === "unknown" && order) {
    const orderNiceString =
      order.total_price_formatted ||
      order.total_amount_formatted ||
      order.order_total_formatted ||
      null;

    if (orderNiceString) {
      amountLabel = orderNiceString;
    } else {
      const orderNumericCandidates = [
        order.total_price,
        order.total_amount,
        order.subtotal_price,
        order.order_total,
      ].filter((val) => typeof val === "number" && val > 0);

      for (const val of orderNumericCandidates) {
        const dollars = val > 9999 ? val / 100 : val;
        amountLabel = `$${dollars.toFixed(2)}`;
        break;
      }
    }
  }

  // 2) If we still don't know the amount, try to read it directly off the webhook payload
  if (amountLabel === "unknown" && resource) {
    console.log(
      "💰 Webhook resource for ORDER_PAYMENT_RECEIVED:",
      JSON.stringify(resource, null, 2)
    );

    if (resource.total_price_formatted) {
      amountLabel = resource.total_price_formatted;
    } else if (
      typeof resource.total_price === "number" &&
      resource.total_price !== 0
    ) {
      const val = resource.total_price;
      const dollars = val > 9999 ? val / 100 : val;
      amountLabel = `$${dollars.toFixed(2)}`;
    } else if (typeof resource.amount === "number" && resource.amount !== 0) {
      const val = resource.amount;
      const dollars = val > 9999 ? val / 100 : val;
      amountLabel = `$${dollars.toFixed(2)}`;
    } else if (
      typeof resource.amount === "string" &&
      resource.amount.trim() !== ""
    ) {
      amountLabel = resource.amount;
    }
  }

  // 3) If we still don't know, hit the payment-info endpoint
  if (amountLabel === "unknown") {
    const paymentInfo = await fetchOrderPaymentInfo(orderId);
    if (paymentInfo) {
      console.log(
        "💳 payment-info payload for order",
        orderId,
        JSON.stringify(paymentInfo, null, 2)
      );

      const niceString =
        paymentInfo.total_price_formatted ||
        paymentInfo.total_amount_formatted ||
        paymentInfo.amount_formatted ||
        paymentInfo.display_amount ||
        paymentInfo.formatted_amount ||
        null;

      if (niceString) {
        amountLabel = niceString;
      } else {
        const numericCandidates = [
          paymentInfo.total_price,
          paymentInfo.total_amount,
          paymentInfo.amount,
          paymentInfo.subtotal_price,
        ].filter((val) => typeof val === "number" && val > 0);

        for (const val of numericCandidates) {
          if (val > 9999) {
            amountLabel = `$${(val / 100).toFixed(2)}`;
          } else {
            amountLabel = `$${val.toFixed(2)}`;
          }
          break;
        }
      }
    }
  }

  const label = (orderNumber && `Order #${orderNumber}`) || orderTitle || orderId;

  if (!orderStatusUrl) {
    orderStatusUrl = `${ARYEO_ADMIN_BASE_URL}/admin/orders/${orderId}/edit`;
  }

  const when = formatToEastern(occurred_at);

  let lines = [];
  lines.push("💳 **Payment Received**");
  lines.push("");
  if (orderStatusUrl) {
    lines.push(`• Order: [${label}](${orderStatusUrl})`);
  } else {
    lines.push(`• Order: \`${label}\``);
  }
  if (customerName !== "unknown") {
    lines.push(`• Client: \`${customerName}\``);
  }

  lines.push("");
  lines.push("**Payment**");
  lines.push(`• Amount: \`${amountLabel}\``);
  lines.push(`• Paid: \`${when.date} at ${when.time}\``);

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
          names.length > 3 ? `${firstFew} (+${names.length - 3} more)` : firstFew;
      }
    }
  }

  const label = (orderNumber && `Order #${orderNumber}`) || orderTitle || orderId;

  const when = formatToEastern(occurred_at);
  const reason =
    activity.reason || (activity.metadata && activity.metadata.reason) || null;

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

  const orderId = resource?.order_id || resource?.order?.id;

  let orderLabel = orderId || "unknown";
  let customerName = "unknown";
  let appointmentDate = "unknown";
  let appointmentTime = "unknown";
  let propertyAddress = "unknown";
  let mapsUrl = null;

  if (orderId) {
    const order = await fetchOrder(orderId);
    if (order) {
      const orderNumber = order.number || null;
      const orderTitle = order.title || order.identifier || orderId;

      orderLabel = (orderNumber && `Order #${orderNumber}`) || orderTitle || orderId;

      if (order.customer && order.customer.name) {
        customerName = order.customer.name;
      }

      if (
        order.listing &&
        order.listing.address &&
        order.listing.address.full_address
      ) {
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
  lines.push(`• Updated at: \`${changeWhen.date} – ${changeWhen.time}\``);

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
      u.name || [u.first_name, u.last_name].filter(Boolean).join(" ") || null;
    if (userName) {
      shooterNames.push(userName);
      const mention = PHOTOGRAPHER_DISCORD_MAP[userName];
      if (mention) shooterMentions.push(mention);
    }
  } else if (Array.isArray(resource?.users)) {
    resource.users.forEach((u) => {
      const userName =
        u.name || [u.first_name, u.last_name].filter(Boolean).join(" ") || null;
      if (userName) {
        shooterNames.push(userName);
        const mention = PHOTOGRAPHER_DISCORD_MAP[userName];
        if (mention) shooterMentions.push(mention);
      }
    });
  }

  const direction =
    name && name.toUpperCase().includes("UNASSIGN")
      ? "unassigned from"
      : "assigned to";

  let orderLabel = orderId || "unknown";
  let orderNumber = null;
  let orderTitle = null;
  let orderStatusUrl = null;
  let customerName = "unknown";
  let serviceSummary = "unknown";
  let propertyAddress = "unknown";
  let mapsUrl = null;
  let appointmentDate = "unknown";
  let appointmentTime = "unknown";

  if (orderId) {
    const order = await fetchOrder(orderId);
    if (order) {
      orderNumber = order.number || null;
      orderTitle = order.title || order.identifier || orderId;

      orderStatusUrl =
        order.status_url ||
        order.invoice_url ||
        order.payment_url ||
        `${ARYEO_ADMIN_BASE_URL}/admin/orders/${orderId}/edit`;

      orderLabel = (orderNumber && `Order #${orderNumber}`) || orderTitle || orderId;

      if (order.customer && order.customer.name) {
        customerName = order.customer.name;
      }

      if (
        order.listing &&
        order.listing.address &&
        order.listing.address.full_address
      ) {
        propertyAddress = order.listing.address.full_address;
      } else if (order.address && order.address.full_address) {
        propertyAddress = order.address.full_address;
      }

      if (propertyAddress && propertyAddress !== "unknown") {
        mapsUrl = buildGoogleMapsUrl(propertyAddress);
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
            names.length > 3 ? `${firstFew} (+${names.length - 3} more)` : firstFew;
        }
      }

      let appt = null;
      if (Array.isArray(order.appointments) && order.appointments.length > 0) {
        if (appointmentId) {
          appt =
            order.appointments.find((a) => a.id === appointmentId) ||
            order.appointments[0];
        } else {
          appt = order.appointments[0];
        }
      }

      if (appt) {
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
    const appointmentRaw =
      resource?.start_at || resource?.scheduled_at || resource?.date || null;
    if (appointmentRaw && typeof appointmentRaw === "string") {
      const formatted = formatToEastern(appointmentRaw);
      appointmentDate = formatted.date;
      appointmentTime = formatted.time;
    }

    if (resource?.address?.full_address) {
      propertyAddress = resource.address.full_address;
      mapsUrl = buildGoogleMapsUrl(propertyAddress);
    }
  }

  const changeWhen = formatToEastern(occurred_at);

  let lines = [];
  lines.push("👥 Photographer Assignment Updated");
  lines.push("");

  if (orderStatusUrl && orderLabel !== "unknown") {
    lines.push(`• Order: [${orderLabel}](${orderStatusUrl})`);
  } else if (orderLabel !== "unknown") {
    lines.push(`• Order: \`${orderLabel}\``);
  }

  if (customerName !== "unknown") {
    lines.push(`• Client: \`${customerName}\``);
  }

  if (serviceSummary !== "unknown") {
    lines.push(`• Service: \`${serviceSummary}\``);
  }

  if (
    appointmentDate !== "unknown" ||
    appointmentTime !== "unknown" ||
    propertyAddress !== "unknown"
  ) {
    lines.push("");
    lines.push("**Appointment**");
    if (appointmentDate !== "unknown") {
      lines.push(`• Date: \`${appointmentDate}\``);
    }
    if (appointmentTime !== "unknown") {
      lines.push(`• Time: \`${appointmentTime}\``);
    }
    if (propertyAddress !== "unknown") {
      lines.push(`• Location: \`${propertyAddress}\``);
    }
    if (mapsUrl) {
      lines.push(`• Map: ${mapsUrl}`);
    }
  }

  if (shooterNames.length > 0) {
    const shootersLabel =
      shooterNames.length === 1 ? shooterNames[0] : shooterNames.join(", ");
    lines.push("");
    lines.push(`• Photographer(s) ${direction} appointment: \`${shootersLabel}\``);
  } else {
    lines.push("");
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

const activityHandlers = {
  ORDER_CREATED: handleOrderCreated,
  ORDER_PAYMENT_RECEIVED: handleOrderPaymentReceived,

  ORDER_CANCELED: handleOrderCanceled,
  ORDER_CANCELLED: handleOrderCanceled,

  APPOINTMENT_RESCHEDULED: handleAppointmentRescheduled,

  APPOINTMENT_USER_ASSIGNED: handlePhotographerAssignmentChanged,
  APPOINTMENT_USER_UNASSIGNED: handlePhotographerAssignmentChanged,
  APPOINTMENT_USERS_CHANGED: handlePhotographerAssignmentChanged,
};

// ---------------------------------------------------------
// MAIN WEBHOOK ROUTE
// ---------------------------------------------------------

app.post("/aryeo-webhook", async (req, res) => {
  try {
    console.log("✅ WEBHOOK HIT", new Date().toISOString());
    console.log("Headers:", req.headers);
    console.log("Body:", JSON.stringify(req.body, null, 2));

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
// Cron Jobs
// ---------------------------------------------------------

// Run every day at 7:00 AM Eastern
cron.schedule(
  "0 7 * * *",
  () => {
    console.log("⏰ Running daily morning briefing...");
    sendMorningBriefing().catch((err) => {
      console.error("💥 Error in sendMorningBriefing:", err);
    });
  },
  {
    timezone: "America/New_York",
  }
);

// ---------------------------------------------------------
// SIMPLE TEST ROUTES (no Aryeo involved)
// ---------------------------------------------------------

app.get("/test-morning-briefing", async (req, res) => {
  try {
    const now = new Date();
    const estParts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);

    const year = estParts.find((p) => p.type === "year").value;
    const month = estParts.find((p) => p.type === "month").value;
    const day = estParts.find((p) => p.type === "day").value;

    const todayEst = `${year}-${month}-${day}`; // YYYY-MM-DD

    const appointments = (await fetchAppointmentsForDate(todayEst)) || [];
    const content = buildMorningBriefingMessage(todayEst, appointments);

    await sendToDiscord(
      BOOKINGS_WEBHOOK_URL,
      { content },
      "DAILY-MORNING-BRIEFING-TEST"
    );

    res.send(
      `Sent test morning briefing for ${todayEst}. Count = ${appointments.length}`
    );
  } catch (err) {
    console.error("💥 Error in /test-morning-briefing:", err);
    res.status(500).send("Server error.");
  }
});

// ✅ SMRTPHONE TEST ROUTE (FORCES recipient to 954-736-7431)
// Call it like:
// https://YOUR-RAILWAY-DOMAIN/test-smrtphone?token=YOUR_TEST_TOKEN&message=Hello%20world
app.get("/test-smrtphone", async (req, res) => {
  try {
    const token = req.query.token || "";
    if (!SMRTPHONE_TEST_TOKEN || token !== SMRTPHONE_TEST_TOKEN) {
      return res.status(401).send("Unauthorized");
    }

    if (!SMRTPHONE_FROM_NUMBER) {
      return res.status(500).send("Missing SMRTPHONE_FROM_NUMBER env var");
    }

    // Force the test number so clients never get pinged
    const to = "9547367431";

    const message =
      (req.query.message && String(req.query.message)) ||
      "🧪 Test SMS from Railway smrtPhone integration.";

    const result = await sendSmrtPhoneSms({
      from: SMRTPHONE_FROM_NUMBER,
      to,
      message,
    });

    if (!result.ok) {
      return res
        .status(500)
        .send(`Failed to send SMS. Details: ${JSON.stringify(result)}`);
    }

    return res.send(
      `✅ Sent (or dry-run) smrtPhone test SMS to ${to}. Result: ${JSON.stringify(result)}`
    );
  } catch (err) {
    console.error("💥 Error in /test-smrtphone:", err);
    return res.status(500).send("Server error");
  }
});

app.get("/test-drone", async (req, res) => {
  await sendToDiscord(
    DRONE_WEBHOOK_URL,
    { content: "🧪 Test message to **Drone** channel from `/test-drone`" },
    "DRONE-TEST"
  );
  res.send("Sent test message to Drone Discord webhook (if configured).");
});

app.get("/test-quickbooks", async (req, res) => {
  await sendToDiscord(
    QUICKBOOKS_WEBHOOK_URL,
    { content: "🧪 Test message to **QuickBooks** channel from `/test-quickbooks`" },
    "QB-TEST"
  );
  res.send("Sent test message to QuickBooks Discord webhook (if configured).");
});

app.get("/test-bookings", async (req, res) => {
  await sendToDiscord(
    BOOKINGS_WEBHOOK_URL,
    { content: "🧪 Test message to **Bookings** channel from `/test-bookings`" },
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