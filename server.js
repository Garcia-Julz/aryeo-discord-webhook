// server.js
const express = require("express");
const fetch = require("node-fetch");
const cron = require("node-cron");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------
// ONE PLACE TO CHANGE THE DAILY SCHEDULE TIME
// ---------------------------------------------------------
const DAILY_JOB_HOUR_ET = parseInt(process.env.DAILY_JOB_HOUR_ET || "8", 10); // 0-23
const DAILY_JOB_MINUTE_ET = parseInt(
  process.env.DAILY_JOB_MINUTE_ET || "0",
  10
); // 0-59
const CRON_TZ = "America/New_York";
const DAILY_CRON_EXPR = `${DAILY_JOB_MINUTE_ET} ${DAILY_JOB_HOUR_ET} * * *`;

// ---------------------------------------------------------
// FEATURE FLAGS / DEBUG
// ---------------------------------------------------------
const SHOW_FULL_CLIENT_PHONE_IN_DISCORD =
  (process.env.SHOW_FULL_CLIENT_PHONE_IN_DISCORD || "").toLowerCase() ===
  "true";

const DEBUG_CANCELED_FILTER =
  (process.env.DEBUG_CANCELED_FILTER || "").toLowerCase() === "true";

const DEBUG_ADDRESS_PARSING =
  (process.env.DEBUG_ADDRESS_PARSING || "").toLowerCase() === "true";

const ENABLE_REAL_SIGNATURE_VERIFICATION =
  (process.env.ENABLE_REAL_SIGNATURE_VERIFICATION || "").toLowerCase() ===
  "true";

// ---------------------------------------------------------
// ENV VARS
// ---------------------------------------------------------

// --- SMRTPHONE (SMS) ---
const SMRTPHONE_API_KEY = process.env.SMRTPHONE_API_KEY;
const SMRTPHONE_FROM_NUMBER = process.env.SMRTPHONE_FROM_NUMBER; // digits only
const SMRTPHONE_TEST_TOKEN = process.env.SMRTPHONE_TEST_TOKEN; // protect test route
const SMRTPHONE_TEST_NUMBER = process.env.SMRTPHONE_TEST_NUMBER; // digits only
const SMRTPHONE_DRY_RUN =
  (process.env.SMRTPHONE_DRY_RUN || "").toLowerCase() === "true";

// Aryeo
const ARYEO_WEBHOOK_SECRET = process.env.ARYEO_WEBHOOK_SECRET;
const ARYEO_API_KEY = process.env.ARYEO_API_KEY;
const ARYEO_API_BASE_URL =
  process.env.ARYEO_API_BASE_URL || "https://api.aryeo.com/v1";

// Base URL for Aryeo dashboard
const ARYEO_ADMIN_BASE_URL =
  process.env.ARYEO_ADMIN_BASE_URL || "https://textured-media.aryeo.com";

// Discord webhooks
const DRONE_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL_DRONE;
const QUICKBOOKS_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL_QUICKBOOKS;
const BOOKINGS_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL_BOOKINGS;

// Generic role mention if no specific shooter is found
const DRONE_MENTION = process.env.DRONE_MENTION || "@DronePilot";

// Map Aryeo user names -> Discord mentions
const PHOTOGRAPHER_DISCORD_MAP = {
  "Julian Garcia": "<@294642333352198148>",
  "Que Mckenzie": "<@242693007453847552>",
  "Que McKenzie": "<@242693007453847552>",
};

// ---------------------------------------------------------
// BOOT LOGS
// ---------------------------------------------------------
console.log("Boot: TIMEZONE =", CRON_TZ);
console.log("Boot: DAILY_JOB_HOUR_ET =", DAILY_JOB_HOUR_ET);
console.log("Boot: DAILY_JOB_MINUTE_ET =", DAILY_JOB_MINUTE_ET);
console.log("Boot: DAILY_CRON_EXPR =", DAILY_CRON_EXPR);

console.log("Boot: ARYEO_WEBHOOK_SECRET present?", !!ARYEO_WEBHOOK_SECRET);
console.log("Boot: ENABLE_REAL_SIGNATURE_VERIFICATION =", ENABLE_REAL_SIGNATURE_VERIFICATION);
console.log("Boot: ARYEO_API_KEY present?", !!ARYEO_API_KEY);
console.log("Boot: DRONE_WEBHOOK_URL present?", !!DRONE_WEBHOOK_URL);
console.log("Boot: QUICKBOOKS_WEBHOOK_URL present?", !!QUICKBOOKS_WEBHOOK_URL);
console.log("Boot: BOOKINGS_WEBHOOK_URL present?", !!BOOKINGS_WEBHOOK_URL);
console.log("Boot: DRONE_MENTION =", DRONE_MENTION);

console.log("Boot: SMRTPHONE_API_KEY present?", !!SMRTPHONE_API_KEY);
console.log("Boot: SMRTPHONE_FROM_NUMBER present?", !!SMRTPHONE_FROM_NUMBER);
console.log("Boot: SMRTPHONE_TEST_TOKEN present?", !!SMRTPHONE_TEST_TOKEN);
console.log("Boot: SMRTPHONE_TEST_NUMBER present?", !!SMRTPHONE_TEST_NUMBER);
console.log("Boot: SMRTPHONE_DRY_RUN =", SMRTPHONE_DRY_RUN);
console.log(
  "Boot: SHOW_FULL_CLIENT_PHONE_IN_DISCORD =",
  SHOW_FULL_CLIENT_PHONE_IN_DISCORD
);
console.log("Boot: DEBUG_CANCELED_FILTER =", DEBUG_CANCELED_FILTER);
console.log("Boot: DEBUG_ADDRESS_PARSING =", DEBUG_ADDRESS_PARSING);

// ---------------------------------------------------------
// BODY PARSER
// ---------------------------------------------------------
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);

// ---------------------------------------------------------
// SIGNATURE VERIFICATION
// ---------------------------------------------------------
function timingSafeEqualStrings(a, b) {
  const aBuf = Buffer.from(String(a || ""), "utf8");
  const bBuf = Buffer.from(String(b || ""), "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function verifyAryeoSignature(rawBody, signatureHeader) {
  if (!ENABLE_REAL_SIGNATURE_VERIFICATION) {
    console.warn("⚠️ Skipping signature verification (TEST MODE).");
    return true;
  }

  if (!ARYEO_WEBHOOK_SECRET) {
    console.error("❌ ENABLE_REAL_SIGNATURE_VERIFICATION is on but ARYEO_WEBHOOK_SECRET is missing.");
    return false;
  }

  if (!rawBody || !signatureHeader) {
    console.error("❌ Missing rawBody or signatureHeader for webhook verification.");
    return false;
  }

  try {
    const expected = crypto
      .createHmac("sha256", ARYEO_WEBHOOK_SECRET)
      .update(rawBody, "utf8")
      .digest("hex");

    const provided = String(signatureHeader).trim();

    const valid =
      timingSafeEqualStrings(provided, expected) ||
      timingSafeEqualStrings(provided.replace(/^sha256=/i, ""), expected);

    if (!valid) {
      console.error("❌ Signature mismatch.");
    }

    return valid;
  } catch (err) {
    console.error("💥 Error verifying Aryeo signature:", err);
    return false;
  }
}

// ---------------------------------------------------------
// SHARED HELPERS
// ---------------------------------------------------------

function getEasternTodayYMD(dateObj = new Date()) {
  return dateObj.toLocaleDateString("en-CA", {
    timeZone: CRON_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function formatToEastern(isoString) {
  if (!isoString) return { date: "unknown", time: "unknown" };

  const d = new Date(isoString);
  if (isNaN(d.getTime())) return { date: "unknown", time: "unknown" };

  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: CRON_TZ,
    year: "numeric",
    month: "short",
    day: "2-digit",
  });

  const timeFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: CRON_TZ,
    hour: "numeric",
    minute: "2-digit",
  });

  return {
    date: dateFormatter.format(d),
    time: timeFormatter.format(d) + " ET",
  };
}

function getEasternYMD(isoString) {
  if (!isoString) return null;

  const d = new Date(isoString);
  if (isNaN(d.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CRON_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);

  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;

  if (!year || !month || !day) return null;
  return `${year}-${month}-${day}`;
}

function getAppointmentSortTime_(appt) {
  const raw = appt?.start_at || appt?.scheduled_at || appt?.date || null;

  if (!raw) return Number.MAX_SAFE_INTEGER;

  const ms = new Date(raw).getTime();
  if (Number.isNaN(ms)) return Number.MAX_SAFE_INTEGER;

  return ms;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function formatCurrencyFromUnknownValue(val) {
  if (typeof val !== "number" || !isFinite(val) || val <= 0) return null;
  const dollars = val > 9999 ? val / 100 : val;
  return `$${dollars.toFixed(2)}`;
}

async function sendToDiscord(webhookUrl, payload, contextLabel = "") {
  if (!webhookUrl) {
    console.error(
      `❌ Missing Discord webhook URL for [${contextLabel || "notification"}]`
    );
    return { ok: false, error: "Missing webhook URL" };
  }

  const baseBody =
    typeof payload === "string" ? { content: payload } : payload || {};

  const body = {
    ...baseBody,
    flags: ((baseBody.flags || 0) | 4),
  };

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
      console.error(`❌ Discord error response [${contextLabel}]:`, text);
      return { ok: false, status: resp.status, body: text };
    }

    return { ok: true, status: resp.status };
  } catch (err) {
    console.error(`❌ Error sending to Discord [${contextLabel}]:`, err);
    return { ok: false, error: String(err) };
  }
}

function buildGoogleMapsUrl(addressString) {
  if (!addressString) return null;
  const encoded = encodeURIComponent(addressString);
  return `https://www.google.com/maps/search/?api=1&query=${encoded}`;
}

function dedupeStrings(arr) {
  return [...new Set((arr || []).filter(Boolean).map((v) => String(v).trim()).filter(Boolean))];
}

// ---------------------------------------------------------
// CANCEL / STATUS FILTER
// ---------------------------------------------------------

function looksCanceledStatus_(val) {
  const s = String(val || "").toLowerCase().trim();
  if (!s) return false;
  return s.includes("cancel") || s.includes("void");
}

function isCanceledAppointmentOrOrder_(appt) {
  if (!appt || typeof appt !== "object") return false;

  const order = appt.order || appt.order_data || appt.orderData || {};

  const apptCanceledFlag =
    !!(
      appt.cancelled_at ||
      appt.canceled_at ||
      appt.cancelledAt ||
      appt.canceledAt ||
      appt.cancellation_at ||
      appt.cancellationAt
    );

  const orderCanceledFlag =
    !!(
      order.cancelled_at ||
      order.canceled_at ||
      order.cancelledAt ||
      order.canceledAt ||
      order.cancellation_at ||
      order.cancellationAt
    );

  const apptStatusCanceled = looksCanceledStatus_(appt.status);
  const orderStatusCanceled = looksCanceledStatus_(order.status);
  const apptStateCanceled = looksCanceledStatus_(appt.state);
  const orderStateCanceled = looksCanceledStatus_(order.state);

  return (
    apptCanceledFlag ||
    orderCanceledFlag ||
    apptStatusCanceled ||
    orderStatusCanceled ||
    apptStateCanceled ||
    orderStateCanceled
  );
}

// ---------------------------------------------------------
// SMRTPHONE helper
// ---------------------------------------------------------

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
// PHONE HELPERS
// ---------------------------------------------------------

function normalizePhoneString(raw) {
  if (!raw || typeof raw !== "string") return null;
  const cleaned = raw.trim();
  return cleaned ? cleaned : null;
}

function extractPhoneFromCustomer(customer) {
  if (!customer || typeof customer !== "object") return null;

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

  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length === 10) return digits;

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

function getClientPhoneDigits(customer) {
  const raw = extractPhoneFromCustomer(customer);
  if (!raw) return null;
  return normalizePhone(raw);
}

// ---------------------------------------------------------
// ORDER / APPT HELPERS
// ---------------------------------------------------------

function summarizeOrderItems(items) {
  if (!Array.isArray(items) || items.length === 0) return "Unknown service";

  const names = items
    .map((item) => item.name || item.product_name || item.title)
    .filter(Boolean);

  if (names.length === 0) return "Unknown service";
  if (names.length === 1) return names[0];

  const firstFew = names.slice(0, 3).join(", ");
  return names.length > 3 ? `${firstFew} (+${names.length - 3} more)` : firstFew;
}

function orderRequiresDrone(order) {
  const droneKeywords = [
    "drone",
    "aerial",
    "plus package",
    "pro package",
    "property listing video",
  ];

  const items = order.items || order.order_items || [];

  if (!Array.isArray(items) || items.length === 0) {
    console.log("ℹ️ No order items found when checking for drone.");
    return null;
  }

  const itemsLower = items.map((item) => {
    const name = item.name || item.product_name || item.title || "";
    return String(name).toLowerCase();
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

async function aryeoGet(path, contextLabel = "ARYEO") {
  if (!ARYEO_API_KEY) {
    console.log("❌ ARYEO_API_KEY missing, cannot call Aryeo.");
    return null;
  }

  const url = `${ARYEO_API_BASE_URL}${path}`;

  try {
    console.log(`🔍 Fetching from Aryeo [${contextLabel}]:`, url);
    const resp = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${ARYEO_API_KEY}`,
      },
    });

    const text = await resp.text();
    const json = safeJsonParse(text);

    if (!resp.ok) {
      console.error(`❌ Aryeo request failed [${contextLabel}]:`, resp.status, text);
      return null;
    }

    return json;
  } catch (err) {
    console.error(`💥 Error calling Aryeo [${contextLabel}]:`, err);
    return null;
  }
}

async function fetchOrder(orderId) {
  if (!orderId) return null;

  const json = await aryeoGet(
    `/orders/${orderId}?include=items,listing,listing.address,address,customer,appointments,appointments.users,payments`,
    "FETCH_ORDER"
  );

  if (!json) return null;

  const order = json.data || json.order || json;

  console.log("✅ Aryeo order fetch success. Sample:", {
    id: order?.id,
    number: order?.number,
    title: order?.title,
    status: order?.status,
    hasCustomer: !!order?.customer,
    hasListing: !!order?.listing,
    listingHasAddress: !!(
      order?.listing &&
      order?.listing?.address &&
      order?.listing?.address?.full_address
    ),
    hasOrderAddress: !!(order?.address && order?.address?.full_address),
    appointmentsType: Array.isArray(order?.appointments)
      ? `array(${order.appointments.length})`
      : typeof order?.appointments,
  });

  return order;
}

async function fetchOrderPaymentInfo(orderId) {
  if (!orderId) return null;

  const json = await aryeoGet(
    `/orders/${orderId}/payment-info`,
    "FETCH_ORDER_PAYMENT_INFO"
  );

  if (!json) return null;

  console.log(
    "💰 Payment-info debug for order",
    orderId,
    JSON.stringify(json, null, 2)
  );

  return json.data || json;
}

async function fetchAppointmentsForDate(dateIso) {
  if (!dateIso) return null;

  const json = await aryeoGet(
    `/appointments?filter[date]=${dateIso}&include=order,order.address,order.customer,order.items,order.listing,order.listing.address,users`,
    "FETCH_APPOINTMENTS_FOR_DATE"
  );

  if (!json) return null;

  const appointments = json.data || [];

  const filteredByDate = appointments.filter((appt) => {
    const raw = appt.start_at || appt.scheduled_at || appt.date || null;
    const apptYmd = raw ? getEasternYMD(raw) : null;
    return apptYmd === dateIso;
  });

  console.log(
    `✅ Appointments for ${dateIso}: raw=${appointments.length}, dateFiltered=${filteredByDate.length}`
  );

  const enriched = await Promise.all(
    filteredByDate.map(async (appt) => {
      if (
        appt.order &&
        appt.order.customer &&
        (
          appt.order.address ||
          (appt.order.listing && appt.order.listing.address)
        )
      ) {
        return appt;
      }

      const orderId = appt.order_id || (appt.order && appt.order.id) || null;
      if (!orderId) return appt;

      const fullOrder = await fetchOrder(orderId);
      if (!fullOrder) return appt;

      return { ...appt, order: fullOrder };
    })
  );

  const notCanceled = [];
  const canceled = [];

  for (const appt of enriched) {
    if (isCanceledAppointmentOrOrder_(appt)) {
      canceled.push(appt);
    } else {
      notCanceled.push(appt);
    }
  }

  console.log(
    `🚫 Cancel filter applied: kept=${notCanceled.length}, removedCanceled=${canceled.length}`
  );

  if (DEBUG_CANCELED_FILTER && canceled.length > 0) {
    console.log(
      "🧾 CANCELED REMOVED (sample up to 5):",
      canceled.slice(0, 5).map((a) => ({
        apptId: a.id,
        apptStatus: a.status,
        apptCanceledAt: a.canceled_at || a.cancelled_at || null,
        orderId: a.order_id || a.order?.id || null,
        orderStatus: a.order?.status,
        orderCanceledAt: a.order?.canceled_at || a.order?.cancelled_at || null,
        start_at: a.start_at || a.scheduled_at || a.date || null,
      }))
    );
  }

  return notCanceled;
}

// ---------------------------------------------------------
// ADDRESS HELPERS
// ---------------------------------------------------------

function cleanAddressValue_(val) {
  if (typeof val !== "string") return null;
  const cleaned = val.replace(/\s+/g, " ").trim();
  return cleaned || null;
}

function hasStreetNumber_(value) {
  return /\b\d+[A-Za-z]?(?:-\d+)?\b/.test(String(value || ""));
}

function looksLikeFullAddress_(value) {
  const s = String(value || "").trim();
  if (!s) return false;

  const hasNumber = hasStreetNumber_(s);
  const hasStreetWord =
    /\b(st|street|ave|avenue|rd|road|dr|drive|blvd|boulevard|ln|lane|ct|court|cir|circle|trl|trail|way|ter|terrace|pl|place|pkwy|parkway)\b/i.test(
      s
    );
  const hasComma = s.includes(",");
  const hasZip = /\b\d{5}(?:-\d{4})?\b/.test(s);

  return (hasNumber && hasStreetWord) || (hasComma && hasNumber) || (hasNumber && hasZip);
}

function scoreAddressCandidate_(value) {
  const s = String(value || "").trim();
  if (!s) return -999;

  let score = 0;

  if (looksLikeFullAddress_(s)) score += 100;
  if (hasStreetNumber_(s)) score += 50;
  if (s.includes(",")) score += 20;
  if (/\b\d{5}(?:-\d{4})?\b/.test(s)) score += 20;
  if (/\b[A-Z]{2}\b/.test(s)) score += 10;
  if (s.length >= 20) score += 5;
  if (s.length >= 30) score += 5;

  if (
    !hasStreetNumber_(s) &&
    /\b(st|street|ave|avenue|rd|road|dr|drive)\b/i.test(s)
  ) {
    score -= 25;
  }

  return score;
}

function extractAddressCandidatesFromObject_(obj) {
  if (!obj || typeof obj !== "object") return [];

  const candidates = [];

  const directFields = [
    "full_address",
    "formatted_address",
    "property_full_address",
    "property_address",
    "display_address",
    "address",
    "address_line1",
    "address1",
    "line1",
    "street1",
    "street",
    "street_line_1",
    "street_line_2",
  ];

  for (const key of directFields) {
    const value = cleanAddressValue_(obj[key]);
    if (value) candidates.push(value);
  }

  const line1 =
    cleanAddressValue_(obj.address_line1) ||
    cleanAddressValue_(obj.address1) ||
    cleanAddressValue_(obj.line1) ||
    cleanAddressValue_(obj.street1) ||
    cleanAddressValue_(obj.street) ||
    cleanAddressValue_(obj.street_line_1);

  const line2 =
    cleanAddressValue_(obj.address_line2) ||
    cleanAddressValue_(obj.address2) ||
    cleanAddressValue_(obj.line2) ||
    cleanAddressValue_(obj.street_line_2);

  const city =
    cleanAddressValue_(obj.city) ||
    cleanAddressValue_(obj.locality) ||
    cleanAddressValue_(obj.town) ||
    cleanAddressValue_(obj.municipality);

  const state =
    cleanAddressValue_(obj.state) ||
    cleanAddressValue_(obj.region) ||
    cleanAddressValue_(obj.province) ||
    cleanAddressValue_(obj.state_province) ||
    cleanAddressValue_(obj.state_code);

  const postal =
    cleanAddressValue_(obj.postal_code) ||
    cleanAddressValue_(obj.zip) ||
    cleanAddressValue_(obj.zip_code) ||
    cleanAddressValue_(obj.postcode);

  const composedStreet = [line1, line2].filter(Boolean).join(", ");
  const composed = [composedStreet, city, state, postal].filter(Boolean).join(", ");

  if (composed) candidates.push(composed);
  if (composedStreet) candidates.push(composedStreet);

  return dedupeStrings(candidates);
}

function chooseBestAddressCandidate_(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  const ranked = candidates
    .filter(Boolean)
    .map((value) => ({
      value,
      score: scoreAddressCandidate_(value),
    }))
    .sort((a, b) => b.score - a.score);

  return ranked[0]?.value || null;
}

function extractAddressFromObject(obj) {
  if (!obj || typeof obj !== "object") return null;
  const candidates = extractAddressCandidatesFromObject_(obj);
  return chooseBestAddressCandidate_(candidates);
}

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

function findAnyAddressLikeString(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 8) return null;

  const direct = extractAddressFromObject(obj);
  if (direct) return direct;

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

function extractAddressFromAppointment(appt) {
  if (!appt) return null;
  const order = appt.order || {};

  const mergedListing = order.listing
    ? { ...order.listing, ...(order.listing.address || {}) }
    : null;

  const mergedOrder = Object.keys(order).length
    ? { ...order, ...(order.address || {}) }
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

  const gatheredCandidates = [];

  for (const obj of candidates) {
    if (!obj) continue;
    const extracted = extractAddressCandidatesFromObject_(obj);
    gatheredCandidates.push(...extracted);
  }

  const bestCandidate = chooseBestAddressCandidate_(dedupeStrings(gatheredCandidates));
  if (bestCandidate) {
    if (DEBUG_ADDRESS_PARSING) {
      console.log("📍 Address candidate selection:", {
        appointmentId: appt.id || null,
        orderId: order.id || null,
        chosen: bestCandidate,
        candidates: dedupeStrings(gatheredCandidates),
      });
    }
    return bestCandidate;
  }

  const deepAddr = findAnyFullAddress({ appointment: appt, order });
  if (deepAddr) return deepAddr;

  const looseAddr = findAnyAddressLikeString({ appointment: appt, order });
  if (looseAddr) return looseAddr;

  return null;
}

// ---------------------------------------------------------
// CITY HELPERS
// ---------------------------------------------------------

function extractCityFromObject(obj) {
  if (!obj || typeof obj !== "object") return null;

  const direct = obj.city || obj.locality || obj.town || obj.municipality || null;
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== "string") continue;
    const key = k.toLowerCase();
    if (key.includes("city") || key.includes("locality") || key.includes("town")) {
      const val = v.trim();
      if (val) return val;
    }
  }

  return null;
}

function extractCityFromAppointment(appt) {
  if (!appt) return null;
  const order = appt.order || {};

  const candidates = [
    order.listing && order.listing.address,
    order.listing,
    order.address,
    order,
    appt.address,
    appt.location,
    appt.property,
    appt,
  ];

  for (const obj of candidates) {
    const city = extractCityFromObject(obj);
    if (city) return city;
  }

  const deepScan = (obj, depth = 0) => {
    if (!obj || typeof obj !== "object" || depth > 8) return null;

    const city = extractCityFromObject(obj);
    if (city) return city;

    for (const val of Object.values(obj)) {
      if (val && typeof val === "object") {
        const found = deepScan(val, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };

  return deepScan({ appointment: appt, order });
}

function getSmsLocationLabel(appt) {
  const addr = extractAddressFromAppointment(appt);
  const city = extractCityFromAppointment(appt);

  if (!addr && !city) return "the property address";
  if (addr && city) {
    const addrLower = String(addr).toLowerCase();
    const cityLower = String(city).toLowerCase();
    if (addrLower.includes(cityLower)) return addr;
    return `${addr}, ${city}`;
  }
  return addr || city;
}

// ---------------------------------------------------------
// DISCORD: Morning briefing
// ---------------------------------------------------------

function buildMorningBriefingMessage(dateIso, appointments) {
  const prettyDate = new Date(`${dateIso}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: CRON_TZ,
    year: "numeric",
    month: "short",
    day: "2-digit",
  });

  let lines = [];
  lines.push(`☀️🌆 Daily Schedule – ${prettyDate}`);
  lines.push("");

  if (!appointments || appointments.length === 0) {
    lines.push("• No appointments scheduled today.");
    return lines.join("\n");
  }

  const sortedAppointments = [...appointments].sort((a, b) => {
    const timeDiff = getAppointmentSortTime_(a) - getAppointmentSortTime_(b);
    if (timeDiff !== 0) return timeDiff;

    const aId = String(a?.id || "");
    const bId = String(b?.id || "");
    return aId.localeCompare(bId);
  });

  lines.push(`• Total Appointments Today: ${sortedAppointments.length}`);
  lines.push("");

  sortedAppointments.forEach((appt, idx) => {
    const order = appt.order || {};
    const customer = order.customer || {};
    const items = order.items || [];
    const users = appt.users || [];

    const clientName = customer.name || "Unknown client";
    const clientPhone = getClientPhoneLabel(customer);

    const startRaw = appt.start_at || appt.scheduled_at || appt.date || null;
    const when = startRaw
      ? formatToEastern(startRaw)
      : { date: "unknown", time: "unknown" };

    const propertyAddress = getSmsLocationLabel(appt) || "Unknown address";

    let shooterNames = [];
    if (Array.isArray(users) && users.length > 0) {
      shooterNames = users
        .map(
          (u) => u.name || [u.first_name, u.last_name].filter(Boolean).join(" ")
        )
        .filter(Boolean);
    }

    const shootersLabel =
      shooterNames.length === 0 ? "Unassigned" : shooterNames.join(", ");

    const serviceSummary = summarizeOrderItems(items);

    const orderId = order.id;
    const orderLabel = order.number
      ? `Order #${order.number}`
      : order.title || orderId || "Order";

    lines.push(`**Appointment ${idx + 1}**`);
    lines.push(`• Time: \`${when.time}\``);
    lines.push(`• Client: \`${clientName}\``);
    if (clientPhone) lines.push(`• Phone: \`${clientPhone}\``);
    lines.push(`• Service: \`${serviceSummary}\``);
    lines.push(`• Photographer: \`${shootersLabel}\``);
    lines.push(`• Address: \`${propertyAddress}\``);
    lines.push(`• Order: \`${orderLabel}\``);
    lines.push("");
  });

  return lines.join("\n");
}

async function sendMorningBriefing(dateOverrideIso) {
  const todayEst = dateOverrideIso || getEasternTodayYMD();
  console.log("📅 Sending morning briefing for date:", todayEst);

  const appointments = await fetchAppointmentsForDate(todayEst);
  if (!appointments) {
    console.log("⚠️ No appointments data returned, skipping Discord send.");
    return { ok: false, date: todayEst, count: 0, reason: "No appointments data" };
  }

  const content = buildMorningBriefingMessage(todayEst, appointments);
  console.log("➡️ Morning briefing Discord payload length:", content.length);

  const resp = await sendToDiscord(
    BOOKINGS_WEBHOOK_URL,
    { content },
    "BOOKINGS-MORNING_BRIEFING"
  );

  return { ok: !!resp.ok, date: todayEst, count: appointments.length, discord: resp };
}

// ---------------------------------------------------------
// SMS: Send reminders to clients for a given Eastern date
// ---------------------------------------------------------

async function sendClientRemindersForDate(
  targetDate,
  { limit = 0, idxOnly = null, forceDryRun = false } = {}
) {
  if (!SMRTPHONE_FROM_NUMBER) {
    console.error("❌ Missing SMRTPHONE_FROM_NUMBER env var (SMS will not send).");
    return {
      targetDate,
      appointmentsFound: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      error: "Missing SMRTPHONE_FROM_NUMBER",
      results: [],
    };
  }

  const appointments = (await fetchAppointmentsForDate(targetDate)) || [];
  if (appointments.length === 0) {
    return {
      targetDate,
      appointmentsFound: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      results: [],
    };
  }

  const listToSend =
    idxOnly !== null
      ? [appointments[Math.min(idxOnly, appointments.length - 1)]]
      : appointments;

  const trimmed =
    limit > 0 ? listToSend.slice(0, Math.min(limit, listToSend.length)) : listToSend;

  console.log(
    `📲 sendClientRemindersForDate: date=${targetDate} found=${appointments.length} willSend=${trimmed.length} dryRun=${SMRTPHONE_DRY_RUN || forceDryRun}`
  );

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  const results = [];

  for (let i = 0; i < trimmed.length; i++) {
    const appt = trimmed[i];
    const order = appt.order || {};
    const customer = order.customer || {};

    const clientName = customer.name || "there";
    const to = getClientPhoneDigits(customer);

    if (!to) {
      skipped++;
      results.push({
        ok: false,
        reason: "No client phone found on order.customer",
        clientName,
        orderId: order.id || null,
      });
      continue;
    }

    const startRaw = appt.start_at || appt.scheduled_at || appt.date || null;
    const when = startRaw
      ? formatToEastern(startRaw)
      : { date: targetDate, time: "soon" };

    const address = getSmsLocationLabel(appt);

    const message =
      `Good morning ${clientName}!\n` +
      `Friendly reminder: we’re scheduled for ${when.time} today.\n` +
      `Location: ${address}\n`;

    if (SMRTPHONE_DRY_RUN || forceDryRun) {
      console.log("🧪 DRY RUN: would send SMS:", {
        to,
        from: SMRTPHONE_FROM_NUMBER,
        message,
      });
      sent++;
      results.push({
        ok: true,
        dryRun: true,
        to,
        clientName,
        orderId: order.id || null,
      });
      continue;
    }

    const result = await sendSmrtPhoneSms({
      from: SMRTPHONE_FROM_NUMBER,
      to,
      message,
    });

    if (!result.ok) {
      failed++;
      results.push({
        ok: false,
        to,
        clientName,
        orderId: order.id || null,
        error: result,
      });
      continue;
    }

    sent++;
    results.push({ ok: true, to, clientName, orderId: order.id || null });
  }

  return {
    targetDate,
    appointmentsFound: appointments.length,
    sent,
    skipped,
    failed,
    results,
  };
}

// ---------------------------------------------------------
// DAILY JOB WRAPPER
// ---------------------------------------------------------

async function runDailyBriefingAndSms() {
  const targetDate = getEasternTodayYMD();
  console.log("⏰ Daily job fired:", {
    cron: DAILY_CRON_EXPR,
    timezone: CRON_TZ,
    targetDate,
    nowIso: new Date().toISOString(),
  });

  let discordResult = null;
  let smsResult = null;

  try {
    discordResult = await sendMorningBriefing(targetDate);
  } catch (err) {
    console.error("💥 Daily job: Discord briefing failed:", err);
    discordResult = { ok: false, error: String(err) };
  }

  try {
    smsResult = await sendClientRemindersForDate(targetDate);
  } catch (err) {
    console.error("💥 Daily job: SMS reminders failed:", err);
    smsResult = { ok: false, error: String(err) };
  }

  console.log("✅ Daily job summary:", {
    discordOk: !!(discordResult && discordResult.ok),
    discordCount:
      discordResult && typeof discordResult.count === "number"
        ? discordResult.count
        : null,
    smsSent: smsResult && typeof smsResult.sent === "number" ? smsResult.sent : null,
    smsSkipped:
      smsResult && typeof smsResult.skipped === "number" ? smsResult.skipped : null,
    smsFailed:
      smsResult && typeof smsResult.failed === "number" ? smsResult.failed : null,
    smsAppointmentsFound:
      smsResult && typeof smsResult.appointmentsFound === "number"
        ? smsResult.appointmentsFound
        : null,
    smsError: smsResult && smsResult.error ? smsResult.error : null,
  });

  return { discordResult, smsResult, targetDate };
}

// ---------------------------------------------------------
// EVENT HANDLERS
// ---------------------------------------------------------

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
  let requiresDrone = null;
  let serviceSummary = "unknown";

  let photographerNames = [];
  let photographerMentions = [];

  const order = await fetchOrder(orderId);

  if (order && looksCanceledStatus_(order.status)) {
    console.log("🚫 ORDER_CREATED ignored because order is canceled:", {
      orderId,
      status: order.status,
    });
    return;
  }

  if (order) {
    orderTitle = order.title || order.identifier || orderId;
    orderNumber = order.number || null;
    orderStatusUrl = order.status_url || order.payment_url || null;

    if (order.customer && order.customer.name) {
      customerName = order.customer.name;
    }

    const extractedAddress = extractAddressFromAppointment({ order });
    if (extractedAddress) {
      propertyAddress = extractedAddress;
    }

    if (propertyAddress && propertyAddress !== "unknown") {
      mapsUrl = buildGoogleMapsUrl(propertyAddress);
    }

    if (Array.isArray(order.appointments) && order.appointments.length > 0) {
      const appt = order.appointments[0];

      if (isCanceledAppointmentOrOrder_({ ...appt, order })) {
        console.log("🚫 ORDER_CREATED ignored because appointment/order canceled:", {
          orderId,
          apptId: appt.id,
          apptStatus: appt.status,
          orderStatus: order.status,
        });
        return;
      }

      const appointmentRaw = appt.start_at || appt.scheduled_at || appt.date || null;

      if (appointmentRaw && typeof appointmentRaw === "string") {
        const formatted = formatToEastern(appointmentRaw);
        appointmentDate = formatted.date;
        appointmentTime = formatted.time;
      }

      const apptAddress = extractAddressFromAppointment({ ...appt, order });
      if (apptAddress) {
        propertyAddress = apptAddress;
        mapsUrl = buildGoogleMapsUrl(propertyAddress);
      }

      if (Array.isArray(appt.users) && appt.users.length > 0) {
        appt.users.forEach((u) => {
          const userName =
            u.name || [u.first_name, u.last_name].filter(Boolean).join(" ") || null;

          if (userName) {
            photographerNames.push(userName);

            const mention = PHOTOGRAPHER_DISCORD_MAP[userName];
            if (mention) photographerMentions.push(mention);
          }
        });
      }
    }

    serviceSummary = summarizeOrderItems(order.items || order.order_items || []);
    requiresDrone = orderRequiresDrone(order);
  }

  if (requiresDrone === false) {
    console.log("ℹ️ Order does not appear to include drone services; skipping.");
    return;
  }

  const orderLabel = (orderNumber && `Order #${orderNumber}`) || orderTitle || orderId;

  let lines = [];
  lines.push("🚁 **New Drone Order – Airspace Check Needed**");
  lines.push("");

  lines.push("**Order**");
  if (orderStatusUrl) lines.push(`• Order #: [${orderLabel}](${orderStatusUrl})`);
  else lines.push(`• Order #: \`${orderLabel}\``);

  if (customerName !== "unknown") lines.push(`• Client: \`${customerName}\``);
  lines.push(`• Service: \`${serviceSummary}\``);

  if (photographerNames.length > 0) {
    const label =
      photographerNames.length === 1 ? photographerNames[0] : photographerNames.join(", ");
    lines.push(`• Photographer: \`${label}\``);
  }

  lines.push("");
  lines.push("**Appointment**");
  lines.push(`• Date: \`${appointmentDate}\``);
  lines.push(`• Time: \`${appointmentTime}\``);
  lines.push(`• Location: \`${propertyAddress}\``);
  if (mapsUrl) lines.push(`• Map: ${mapsUrl}`);

  lines.push("");
  lines.push("**Action for Drone Team**");
  lines.push("• Use the Air Control app to verify airspace for this location.");
  lines.push("• Confirm: Allowed / Restricted / Permit Required.");

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
  let amountLabel = "unknown";

  const order = await fetchOrder(orderId);

  if (order && looksCanceledStatus_(order.status)) {
    console.log("🚫 PAYMENT_RECEIVED ignored because order is canceled:", {
      orderId,
      status: order.status,
    });
    return;
  }

  if (order) {
    orderTitle = order.title || order.identifier || orderId;
    orderNumber = order.number || null;
    orderStatusUrl =
      order.status_url || order.invoice_url || order.payment_url || null;

    if (order.customer && order.customer.name) {
      customerName = order.customer.name;
    }

    if (Array.isArray(order.payments) && order.payments.length > 0) {
      const lastPayment = order.payments[order.payments.length - 1];

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
          const formatted = formatCurrencyFromUnknownValue(val);
          if (formatted) {
            amountLabel = formatted;
            break;
          }
        }
      }
    }
  }

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
        const formatted = formatCurrencyFromUnknownValue(val);
        if (formatted) {
          amountLabel = formatted;
          break;
        }
      }
    }
  }

  if (amountLabel === "unknown" && resource) {
    if (resource.total_price_formatted) {
      amountLabel = resource.total_price_formatted;
    } else if (typeof resource.total_price === "number" && resource.total_price !== 0) {
      amountLabel = formatCurrencyFromUnknownValue(resource.total_price) || amountLabel;
    } else if (typeof resource.amount === "number" && resource.amount !== 0) {
      amountLabel = formatCurrencyFromUnknownValue(resource.amount) || amountLabel;
    } else if (typeof resource.amount === "string" && resource.amount.trim() !== "") {
      amountLabel = resource.amount;
    }
  }

  if (amountLabel === "unknown") {
    const paymentInfo = await fetchOrderPaymentInfo(orderId);
    if (paymentInfo) {
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
          const formatted = formatCurrencyFromUnknownValue(val);
          if (formatted) {
            amountLabel = formatted;
            break;
          }
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
  lines.push(`• Order: [${label}](${orderStatusUrl})`);
  if (customerName !== "unknown") lines.push(`• Client: \`${customerName}\``);

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

    if (order.customer && order.customer.name) customerName = order.customer.name;

    serviceSummary = summarizeOrderItems(order.items || order.order_items || []);
  }

  const label = (orderNumber && `Order #${orderNumber}`) || orderTitle || orderId;
  const when = formatToEastern(occurred_at);
  const reason = activity.reason || (activity.metadata && activity.metadata.reason) || null;

  let lines = [];
  lines.push("❌ **Order Cancelled**");
  lines.push("");
  lines.push(`• Order: \`${label}\``);
  if (customerName !== "unknown") lines.push(`• Client: \`${customerName}\``);
  if (serviceSummary !== "unknown") lines.push(`• Service: \`${serviceSummary}\``);
  lines.push(`• Cancelled at: \`${when.date} – ${when.time}\``);
  if (reason) lines.push(`• Reason: \`${reason}\``);

  const content = lines.join("\n");
  await sendToDiscord(BOOKINGS_WEBHOOK_URL, { content }, "BOOKINGS-ORDER_CANCELED");
}

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

    if (order && looksCanceledStatus_(order.status)) {
      console.log("🚫 APPT_RESCHEDULED ignored because order is canceled:", {
        orderId,
        status: order.status,
      });
      return;
    }

    if (order) {
      const orderNumber = order.number || null;
      const orderTitle = order.title || order.identifier || orderId;

      orderLabel = (orderNumber && `Order #${orderNumber}`) || orderTitle || orderId;

      if (order.customer && order.customer.name) customerName = order.customer.name;

      const extractedAddress = extractAddressFromAppointment({ order });
      if (extractedAddress) {
        propertyAddress = extractedAddress;
      }

      if (propertyAddress && propertyAddress !== "unknown") {
        mapsUrl = buildGoogleMapsUrl(propertyAddress);
      }

      if (Array.isArray(order.appointments) && order.appointments.length > 0) {
        const appt = order.appointments[0];

        if (isCanceledAppointmentOrOrder_({ ...appt, order })) {
          console.log("🚫 APPT_RESCHEDULED ignored because appointment/order canceled:", {
            orderId,
            apptId: appt.id,
            apptStatus: appt.status,
            orderStatus: order.status,
          });
          return;
        }

        const appointmentRaw = appt.start_at || appt.scheduled_at || appt.date || null;

        if (appointmentRaw && typeof appointmentRaw === "string") {
          const formatted = formatToEastern(appointmentRaw);
          appointmentDate = formatted.date;
          appointmentTime = formatted.time;
        }

        const apptAddress = extractAddressFromAppointment({ ...appt, order });
        if (apptAddress) {
          propertyAddress = apptAddress;
          mapsUrl = buildGoogleMapsUrl(propertyAddress);
        }
      }
    }
  } else {
    const appointmentRaw = resource?.start_at || resource?.scheduled_at || resource?.date || null;
    if (appointmentRaw && typeof appointmentRaw === "string") {
      const formatted = formatToEastern(appointmentRaw);
      appointmentDate = formatted.date;
      appointmentTime = formatted.time;
    }

    if (looksCanceledStatus_(resource?.status) || looksCanceledStatus_(resource?.state)) {
      console.log("🚫 APPT_RESCHEDULED ignored because appointment resource looks canceled:", {
        apptId: resource?.id,
        status: resource?.status,
        state: resource?.state,
      });
      return;
    }

    const extractedAddress = extractAddressFromAppointment(resource);
    if (extractedAddress) {
      propertyAddress = extractedAddress;
      mapsUrl = buildGoogleMapsUrl(propertyAddress);
    }
  }

  const changeWhen = formatToEastern(occurred_at);

  let lines = [];
  lines.push("🔁 **Appointment Rescheduled**");
  lines.push("");
  if (orderLabel !== "unknown") lines.push(`• Order: \`${orderLabel}\``);
  if (customerName !== "unknown") lines.push(`• Client: \`${customerName}\``);
  lines.push("");
  lines.push("**New Appointment Time**");
  lines.push(`• Date: \`${appointmentDate}\``);
  lines.push(`• Time: \`${appointmentTime}\``);
  if (propertyAddress !== "unknown") lines.push(`• Location: \`${propertyAddress}\``);
  if (mapsUrl) lines.push(`• Map: ${mapsUrl}`);
  lines.push("");
  lines.push(`• Updated at: \`${changeWhen.date} – ${changeWhen.time}\``);

  const content = lines.join("\n");
  await sendToDiscord(
    BOOKINGS_WEBHOOK_URL,
    { content },
    "BOOKINGS-APPOINTMENT_RESCHEDULED"
  );
}

async function handlePhotographerAssignmentChanged(activity) {
  const { occurred_at, resource, name } = activity || {};

  const appointmentId = resource?.id || resource?.appointment_id;
  const orderId = resource?.order_id || resource?.order?.id;

  let shooterNames = [];
  let shooterMentions = [];

  if (resource?.user) {
    const u = resource.user;
    const userName = u.name || [u.first_name, u.last_name].filter(Boolean).join(" ") || null;
    if (userName) {
      shooterNames.push(userName);
      const mention = PHOTOGRAPHER_DISCORD_MAP[userName];
      if (mention) shooterMentions.push(mention);
    }
  } else if (Array.isArray(resource?.users)) {
    resource.users.forEach((u) => {
      const userName = u.name || [u.first_name, u.last_name].filter(Boolean).join(" ") || null;
      if (userName) {
        shooterNames.push(userName);
        const mention = PHOTOGRAPHER_DISCORD_MAP[userName];
        if (mention) shooterMentions.push(mention);
      }
    });
  }

  shooterNames = dedupeStrings(shooterNames);
  shooterMentions = dedupeStrings(shooterMentions);

  const direction =
    name && name.toUpperCase().includes("UNASSIGN") ? "unassigned from" : "assigned to";

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

    if (order && looksCanceledStatus_(order.status)) {
      console.log("🚫 PHOTOG_ASSIGN ignored because order is canceled:", {
        orderId,
        status: order.status,
      });
      return;
    }

    if (order) {
      orderNumber = order.number || null;
      orderTitle = order.title || order.identifier || orderId;

      orderStatusUrl =
        order.status_url ||
        order.invoice_url ||
        order.payment_url ||
        `${ARYEO_ADMIN_BASE_URL}/admin/orders/${orderId}/edit`;

      orderLabel = (orderNumber && `Order #${orderNumber}`) || orderTitle || orderId;

      if (order.customer && order.customer.name) customerName = order.customer.name;

      const extractedAddress = extractAddressFromAppointment({ order });
      if (extractedAddress) {
        propertyAddress = extractedAddress;
        mapsUrl = buildGoogleMapsUrl(propertyAddress);
      }

      serviceSummary = summarizeOrderItems(order.items || order.order_items || []);

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
        if (isCanceledAppointmentOrOrder_({ ...appt, order })) {
          console.log("🚫 PHOTOG_ASSIGN ignored because appointment/order canceled:", {
            orderId,
            apptId: appt.id,
            apptStatus: appt.status,
            orderStatus: order.status,
          });
          return;
        }

        const appointmentRaw = appt.start_at || appt.scheduled_at || appt.date || null;
        if (appointmentRaw && typeof appointmentRaw === "string") {
          const formatted = formatToEastern(appointmentRaw);
          appointmentDate = formatted.date;
          appointmentTime = formatted.time;
        }

        const apptAddress = extractAddressFromAppointment({ ...appt, order });
        if (apptAddress) {
          propertyAddress = apptAddress;
          mapsUrl = buildGoogleMapsUrl(propertyAddress);
        }
      }
    }
  } else {
    const appointmentRaw = resource?.start_at || resource?.scheduled_at || resource?.date || null;
    if (appointmentRaw && typeof appointmentRaw === "string") {
      const formatted = formatToEastern(appointmentRaw);
      appointmentDate = formatted.date;
      appointmentTime = formatted.time;
    }

    if (looksCanceledStatus_(resource?.status) || looksCanceledStatus_(resource?.state)) {
      console.log("🚫 PHOTOG_ASSIGN ignored because appointment resource looks canceled:", {
        apptId: resource?.id,
        status: resource?.status,
        state: resource?.state,
      });
      return;
    }

    const extractedAddress = extractAddressFromAppointment(resource);
    if (extractedAddress) {
      propertyAddress = extractedAddress;
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

  if (customerName !== "unknown") lines.push(`• Client: \`${customerName}\``);
  if (serviceSummary !== "unknown") lines.push(`• Service: \`${serviceSummary}\``);

  if (
    appointmentDate !== "unknown" ||
    appointmentTime !== "unknown" ||
    propertyAddress !== "unknown"
  ) {
    lines.push("");
    lines.push("**Appointment**");
    if (appointmentDate !== "unknown") lines.push(`• Date: \`${appointmentDate}\``);
    if (appointmentTime !== "unknown") lines.push(`• Time: \`${appointmentTime}\``);
    if (propertyAddress !== "unknown") lines.push(`• Location: \`${propertyAddress}\``);
    if (mapsUrl) lines.push(`• Map: ${mapsUrl}`);
  }

  if (shooterNames.length > 0) {
    const shootersLabel = shooterNames.length === 1 ? shooterNames[0] : shooterNames.join(", ");
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
// CRON JOBS
// ---------------------------------------------------------

cron.schedule(
  DAILY_CRON_EXPR,
  async () => {
    await runDailyBriefingAndSms();
  },
  { timezone: CRON_TZ }
);

// ---------------------------------------------------------
// SIMPLE TEST ROUTES
// ---------------------------------------------------------

app.get("/test-daily-job-now", async (req, res) => {
  const token = req.query.token || "";
  if (!SMRTPHONE_TEST_TOKEN || token !== SMRTPHONE_TEST_TOKEN) {
    return res.status(401).send("Unauthorized");
  }

  try {
    const result = await runDailyBriefingAndSms();
    return res.status(200).send(
      `✅ Ran daily job now (Discord + SMS)\n` + JSON.stringify(result, null, 2)
    );
  } catch (err) {
    console.error("💥 Error in /test-daily-job-now:", err);
    return res.status(500).send("Server error");
  }
});

app.get("/test-morning-briefing", async (req, res) => {
  try {
    const token = req.query.token || "";
    if (SMRTPHONE_TEST_TOKEN && token !== SMRTPHONE_TEST_TOKEN) {
      return res.status(401).send("Unauthorized");
    }

    const targetDate = (req.query.date && String(req.query.date)) || getEasternTodayYMD();
    const appointments = (await fetchAppointmentsForDate(targetDate)) || [];
    const content = buildMorningBriefingMessage(targetDate, appointments);

    await sendToDiscord(
      BOOKINGS_WEBHOOK_URL,
      { content },
      "DAILY-MORNING-BRIEFING-TEST"
    );

    return res.send(
      `Sent test morning briefing for ${targetDate}. Count = ${appointments.length}`
    );
  } catch (err) {
    console.error("💥 Error in /test-morning-briefing:", err);
    return res.status(500).send("Server error.");
  }
});

app.get("/test-address-debug", async (req, res) => {
  try {
    const token = req.query.token || "";
    if (!SMRTPHONE_TEST_TOKEN || token !== SMRTPHONE_TEST_TOKEN) {
      return res.status(401).send("Unauthorized");
    }

    const targetDate = (req.query.date && String(req.query.date)) || getEasternTodayYMD();
    const appointments = (await fetchAppointmentsForDate(targetDate)) || [];

    const debug = appointments.map((appt, idx) => {
      const order = appt.order || {};
      return {
        idx,
        appointmentId: appt.id || null,
        orderId: order.id || null,
        rawStart: appt.start_at || appt.scheduled_at || appt.date || null,
        parsedAddress: extractAddressFromAppointment(appt),
        parsedCity: extractCityFromAppointment(appt),
        smsLocationLabel: getSmsLocationLabel(appt),
        listingAddress: order.listing?.address || null,
        orderAddress: order.address || null,
      };
    });

    return res.status(200).json({
      targetDate,
      count: appointments.length,
      debug,
    });
  } catch (err) {
    console.error("💥 Error in /test-address-debug:", err);
    return res.status(500).send("Server error");
  }
});

app.get("/test-smrtphone", async (req, res) => {
  try {
    const token = req.query.token || "";
    if (!SMRTPHONE_TEST_TOKEN || token !== SMRTPHONE_TEST_TOKEN) {
      return res.status(401).send("Unauthorized");
    }

    if (!SMRTPHONE_FROM_NUMBER) {
      return res.status(500).send("Missing SMRTPHONE_FROM_NUMBER env var");
    }

    const to = (SMRTPHONE_TEST_NUMBER || "").replace(/\D/g, "") || "9547367431";

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
      `✅ Sent smrtPhone test SMS to ${to}. Result: ${JSON.stringify(result)}`
    );
  } catch (err) {
    console.error("💥 Error in /test-smrtphone:", err);
    return res.status(500).send("Server error");
  }
});

app.get("/ping-todays-clients", async (req, res) => {
  try {
    const token = req.query.token || "";
    if (!SMRTPHONE_TEST_TOKEN || token !== SMRTPHONE_TEST_TOKEN) {
      return res.status(401).send("Unauthorized");
    }

    let targetDate = (req.query.date && String(req.query.date)) || null;
    if (!targetDate) targetDate = getEasternTodayYMD();

    const forceDryRun = String(req.query.dryRun || "").toLowerCase() === "true";
    const limit = Math.max(0, parseInt(req.query.limit || "0", 10) || 0);
    const idxOnlyRaw = req.query.idx;
    const idxOnly =
      idxOnlyRaw === undefined || idxOnlyRaw === null || idxOnlyRaw === ""
        ? null
        : Math.max(0, parseInt(String(idxOnlyRaw), 10) || 0);

    const smsResult = await sendClientRemindersForDate(targetDate, {
      limit,
      idxOnly,
      forceDryRun,
    });

    return res.status(200).send(
      `✅ ping-todays-clients complete for ${targetDate}\n\n` +
        JSON.stringify(smsResult, null, 2)
    );
  } catch (err) {
    console.error("💥 Error in /ping-todays-clients:", err);
    return res.status(500).send("Server error");
  }
});

app.get("/test-drone", async (req, res) => {
  try {
    const token = req.query.token || "";
    if (SMRTPHONE_TEST_TOKEN && token !== SMRTPHONE_TEST_TOKEN) {
      return res.status(401).send("Unauthorized");
    }

    await sendToDiscord(
      DRONE_WEBHOOK_URL,
      { content: "🧪 Test message to **Drone** channel from `/test-drone`" },
      "DRONE-TEST"
    );
    return res.send("Sent test message to Drone Discord webhook (if configured).");
  } catch (err) {
    console.error("💥 Error in /test-drone:", err);
    return res.status(500).send("Server error");
  }
});

app.get("/test-quickbooks", async (req, res) => {
  try {
    const token = req.query.token || "";
    if (SMRTPHONE_TEST_TOKEN && token !== SMRTPHONE_TEST_TOKEN) {
      return res.status(401).send("Unauthorized");
    }

    await sendToDiscord(
      QUICKBOOKS_WEBHOOK_URL,
      {
        content: "🧪 Test message to **QuickBooks** channel from `/test-quickbooks`",
      },
      "QB-TEST"
    );
    return res.send("Sent test message to QuickBooks Discord webhook (if configured).");
  } catch (err) {
    console.error("💥 Error in /test-quickbooks:", err);
    return res.status(500).send("Server error");
  }
});

app.get("/test-bookings", async (req, res) => {
  try {
    const token = req.query.token || "";
    if (SMRTPHONE_TEST_TOKEN && token !== SMRTPHONE_TEST_TOKEN) {
      return res.status(401).send("Unauthorized");
    }

    await sendToDiscord(
      BOOKINGS_WEBHOOK_URL,
      { content: "🧪 Test message to **Bookings** channel from `/test-bookings`" },
      "BOOKINGS-TEST"
    );
    return res.send("Sent test message to Bookings Discord webhook (if configured).");
  } catch (err) {
    console.error("💥 Error in /test-bookings:", err);
    return res.status(500).send("Server error");
  }
});

app.get("/", (req, res) => {
  res.send(
    "Aryeo → Discord webhook is running. " +
      `Daily cron: ${DAILY_CRON_EXPR} (${CRON_TZ})`
  );
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});