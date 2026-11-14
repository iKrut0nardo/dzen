const DAY_NAMES = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const SLOT_STEP = 15;
const MAX_BOOKING_DAYS = 60;
const MAX_BOOKING_MINUTES = 480;
const BUNDLE_CONFLICTS = {
  "package-last-hope": ["haircut", "last-hope"],
  "package-care-peel": ["haircut", "milk-shake", "maraes-color-care", "anti-hair-loss", "scalp-peel"],
  "package-premium": ["haircut", "premium-max"],
};

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(retryNotifications(env));
  },
};

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const corsHeaders = getCorsHeaders(request, env);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (url.pathname === "/api/health" && request.method === "GET") {
    return json({ ok: true }, 200, corsHeaders);
  }

  if (url.pathname === "/api/availability" && request.method === "GET") {
    try {
      const month = url.searchParams.get("month") || "";
      const serviceIds = parseServiceIds(url.searchParams.get("services") || "");
      const result = await monthAvailability(env.DB, month, serviceIds);
      return json(result, 200, corsHeaders);
    } catch (error) {
      return json({ error: error.message || "Не удалось получить расписание." }, 400, corsHeaders);
    }
  }

  if (url.pathname === "/api/bookings" && request.method === "POST") {
    try {
      const origin = request.headers.get("Origin") || "";
      if (env.SITE_ORIGIN && origin !== env.SITE_ORIGIN) {
        return json({ error: "Недопустимый источник запроса." }, 403, corsHeaders);
      }
      const text = await request.text();
      if (text.length > 8192) return json({ error: "Слишком большой запрос." }, 413, corsHeaders);
      const body = JSON.parse(text);
      if (body.website) return json({ ok: true }, 200, corsHeaders);

      const name = normalizeName(body.name);
      const phone = normalizePhone(body.phone);
      const serviceIds = parseServiceIds(Array.isArray(body.serviceIds) ? body.serviceIds.join(",") : "");
      const date = String(body.date || "");
      const time = String(body.time || "");

      if (!body.consent) return json({ error: "Подтвердите согласие на обработку данных для записи." }, 400, corsHeaders);
      if (!name || name.length < 2 || name.length > 80) return json({ error: "Укажите имя длиной от 2 до 80 символов." }, 400, corsHeaders);
      if (!phone || phone.replace(/\D/g, "").length < 7 || phone.length > 32) return json({ error: "Проверьте номер телефона." }, 400, corsHeaders);
      if (!isValidDate(date) || !/^\d{2}:\d{2}$/.test(time)) return json({ error: "Выберите дату и время из календаря." }, 400, corsHeaders);
      if (!env.TELEGRAM_BOT_TOKEN || !env.ADMIN_TELEGRAM_ID) {
        return json({ error: "Система записи ещё не настроена администратором." }, 503, corsHeaders);
      }

      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      if (!(await allowBookingAttempt(env.DB, ip))) {
        return json({ error: "Слишком много попыток. Подождите минуту и попробуйте снова." }, 429, corsHeaders);
      }

      const dateResult = await dateAvailability(env.DB, date, serviceIds);
      const selectedSlot = dateResult.slots.find((slot) => slot.time === time);
      if (!selectedSlot) {
        return json({ error: "Это время уже занято. Обновите календарь и выберите другое." }, 409, corsHeaders);
      }

      const startMinute = parseTime(time);
      const endMinute = startMinute + selectedSlot.durationMinutes;
      const appointmentId = crypto.randomUUID();
      const serviceSnapshot = selectedSlot.services.map((service) => ({
        id: service.id,
        label: service.label,
        price: service.price,
      }));
      const statements = [
        env.DB.prepare(`INSERT INTO appointments
          (id, client_name, phone, local_date, start_minute, end_minute, duration_minutes, services_json, total_price_byn)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(appointmentId, name, phone, date, startMinute, endMinute, selectedSlot.durationMinutes,
            JSON.stringify(serviceSnapshot), selectedSlot.totalPrice),
      ];

      for (let minute = startMinute; minute < endMinute; minute += SLOT_STEP) {
        statements.push(env.DB.prepare(`INSERT INTO appointment_slots (local_date, start_minute, appointment_id)
          VALUES (?, ?, ?)`)
          .bind(date, minute, appointmentId));
      }

      statements.push(env.DB.prepare(`INSERT INTO notification_outbox (id, appointment_id, deliver_after)
        VALUES (?, ?, ?)`)
        .bind(appointmentId, appointmentId, Math.floor(Date.now() / 1000)));

      try {
        await env.DB.batch(statements);
      } catch (error) {
        if (/unique|constraint/i.test(String(error.message || error))) {
          return json({ error: "Это время только что заняли. Обновите календарь и выберите другой слот." }, 409, corsHeaders);
        }
        throw error;
      }

      const appointment = {
        id: appointmentId,
        name,
        phone,
        date,
        startMinute,
        endMinute,
        durationMinutes: selectedSlot.durationMinutes,
        totalPrice: selectedSlot.totalPrice,
        services: serviceSnapshot,
      };
      let notificationPending = false;
      try {
        await sendNewBooking(env, appointment);
        await env.DB.prepare("UPDATE notification_outbox SET delivered_at = CURRENT_TIMESTAMP WHERE id = ?")
          .bind(appointmentId).run();
      } catch (_error) {
        notificationPending = true;
        await env.DB.prepare(`UPDATE notification_outbox
          SET attempts = attempts + 1, deliver_after = ? WHERE id = ?`)
          .bind(Math.floor(Date.now() / 1000) + 300, appointmentId).run();
      }

      return json({ ok: true, notificationPending }, 201, corsHeaders);
    } catch (error) {
      const status = error instanceof SyntaxError ? 400 : 400;
      return json({ error: error.message || "Не удалось сохранить запись." }, status, corsHeaders);
    }
  }

  if (url.pathname === "/telegram/webhook" && request.method === "POST") {
    const suppliedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (!env.TELEGRAM_WEBHOOK_SECRET || suppliedSecret !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (!env.TELEGRAM_BOT_TOKEN || !env.ADMIN_TELEGRAM_ID) {
      return new Response("Bot is not configured", { status: 503 });
    }
    const update = await request.json();
    ctx.waitUntil(handleTelegramUpdate(update, env));
    return new Response("ok");
  }

  return json({ error: "Not found" }, 404, corsHeaders);
}

function getCorsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = !env.SITE_ORIGIN || origin === env.SITE_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allowed ? (origin || env.SITE_ORIGIN || "*") : "null",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    "Content-Type": "application/json; charset=utf-8",
  };
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function parseServiceIds(value) {
  const ids = [...new Set(String(value).split(",").map((id) => id.trim()).filter(Boolean))];
  if (!ids.length || ids.length > 12 || ids.some((id) => !/^[a-z0-9-]{1,40}$/.test(id))) {
    throw new Error("Выберите услуги для записи.");
  }
  return ids;
}

function normalizeName(value) {
  return String(value || "").replace(/[<>\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
}

function normalizePhone(value) {
  const phone = String(value || "").replace(/[<>\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  return phone;
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parseTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value));
  if (!match) return -1;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return -1;
  return hour * 60 + minute;
}

function formatTime(minute) {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function dateWeekday(dateString) {
  return new Date(`${dateString}T12:00:00Z`).getUTCDay();
}

function addDays(dateString, amount) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function minskNow() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Minsk",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const part = (name) => parts.find((item) => item.type === name)?.value || "00";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    minute: Number(part("hour")) * 60 + Number(part("minute")),
  };
}

async function getServiceSelection(db, ids) {
  const selected = new Set(ids);
  for (const [bundle, included] of Object.entries(BUNDLE_CONFLICTS)) {
    if (selected.has(bundle) && included.some((id) => selected.has(id))) {
      throw new Error("Для пакета не выбирайте отдельно входящие в него услуги.");
    }
  }
  const marks = ids.map(() => "?").join(",");
  const result = await db.prepare(`SELECT id, label, price_byn, duration_minutes, requires_duration, active
    FROM services WHERE id IN (${marks})`).bind(...ids).all();
  const byId = new Map((result.results || []).map((row) => [row.id, row]));
  if (byId.size !== ids.length) throw new Error("Некоторые выбранные услуги не найдены.");
  const services = ids.map((id) => byId.get(id));
  if (services.some((service) => !service.active)) throw new Error("Одна из выбранных услуг временно недоступна.");
  const setupNeeded = services.filter((service) => service.requires_duration && service.duration_minutes <= 0);
  if (setupNeeded.length) {
    throw new Error(`Администратору нужно указать длительность: ${setupNeeded.map((service) => service.label).join(", ")}.`);
  }
  const rawDuration = services.reduce((sum, service) => sum + Number(service.duration_minutes), 0);
  const durationMinutes = Math.ceil(rawDuration / SLOT_STEP) * SLOT_STEP;
  if (!durationMinutes || durationMinutes > MAX_BOOKING_MINUTES) throw new Error("Общая длительность выбранных услуг должна быть от 15 минут до 8 часов.");
  return {
    services: services.map((service) => ({ id: service.id, label: service.label, price: Number(service.price_byn), duration: Number(service.duration_minutes) })),
    durationMinutes,
    totalPrice: services.reduce((sum, service) => sum + Number(service.price_byn), 0),
  };
}

function parseWindows(value) {
  try {
    const windows = JSON.parse(value || "[]");
    return Array.isArray(windows) ? windows.filter((item) =>
      Number.isInteger(item.start) && Number.isInteger(item.end) && item.start >= 0 && item.end <= 1440 && item.start < item.end
    ) : [];
  } catch (_error) {
    return [];
  }
}

async function getWindows(db, date) {
  const override = await db.prepare("SELECT windows_json FROM date_overrides WHERE local_date = ?")
    .bind(date).first();
  if (override) return parseWindows(override.windows_json);
  const row = await db.prepare("SELECT windows_json FROM weekly_schedule WHERE weekday = ?")
    .bind(dateWeekday(date)).first();
  return parseWindows(row?.windows_json);
}

async function occupiedSlots(db, date) {
  const result = await db.prepare("SELECT start_minute FROM appointment_slots WHERE local_date = ?")
    .bind(date).all();
  return new Set((result.results || []).map((row) => Number(row.start_minute)));
}

async function dateAvailability(db, date, serviceIds) {
  if (!isValidDate(date)) throw new Error("Укажите корректную дату.");
  const today = minskNow();
  if (date < today.date || date > addDays(today.date, MAX_BOOKING_DAYS)) return { slots: [] };

  const selection = await getServiceSelection(db, serviceIds);
  const windows = await getWindows(db, date);
  const occupied = await occupiedSlots(db, date);
  const slots = [];

  for (const window of windows) {
    for (let start = window.start; start + selection.durationMinutes <= window.end; start += SLOT_STEP) {
      if (date === today.date && start <= today.minute) continue;
      let free = true;
      for (let minute = start; minute < start + selection.durationMinutes; minute += SLOT_STEP) {
        if (occupied.has(minute)) {
          free = false;
          break;
        }
      }
      if (free) slots.push({
        time: formatTime(start),
        durationMinutes: selection.durationMinutes,
        totalPrice: selection.totalPrice,
        services: selection.services,
      });
    }
  }

  return { slots };
}

async function monthAvailability(db, month, serviceIds) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("Выберите месяц.");
  const [year, monthNumber] = month.split("-").map(Number);
  if (monthNumber < 1 || monthNumber > 12) throw new Error("Выберите корректный месяц.");
  const first = `${month}-01`;
  const last = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  const today = minskNow();
  const maxDate = addDays(today.date, MAX_BOOKING_DAYS);
  const rangeStart = first < today.date ? today.date : first;
  const rangeEnd = last > maxDate ? maxDate : last;
  if (rangeStart > rangeEnd) return { month, availableDates: [], slotsByDate: {} };

  const selection = await getServiceSelection(db, serviceIds);
  const [scheduleRows, overrideRows, slotRows] = await Promise.all([
    db.prepare("SELECT weekday, windows_json FROM weekly_schedule").all(),
    db.prepare("SELECT local_date, windows_json FROM date_overrides WHERE local_date BETWEEN ? AND ?")
      .bind(rangeStart, rangeEnd).all(),
    db.prepare("SELECT local_date, start_minute FROM appointment_slots WHERE local_date BETWEEN ? AND ?")
      .bind(rangeStart, rangeEnd).all(),
  ]);
  const schedule = new Map((scheduleRows.results || []).map((row) => [Number(row.weekday), parseWindows(row.windows_json)]));
  const overrides = new Map((overrideRows.results || []).map((row) => [row.local_date, parseWindows(row.windows_json)]));
  const occupied = new Map();
  for (const row of slotRows.results || []) {
    if (!occupied.has(row.local_date)) occupied.set(row.local_date, new Set());
    occupied.get(row.local_date).add(Number(row.start_minute));
  }

  const availableDates = [];
  const slotsByDate = {};
  for (let date = rangeStart; date <= rangeEnd; date = addDays(date, 1)) {
    const weekday = dateWeekday(date);
    const windows = overrides.has(date) ? overrides.get(date) : (schedule.get(weekday) || []);
    const busy = occupied.get(date) || new Set();
    const times = [];
    for (const window of windows) {
      for (let start = window.start; start + selection.durationMinutes <= window.end; start += SLOT_STEP) {
        if (date === today.date && start <= today.minute) continue;
        let free = true;
        for (let minute = start; minute < start + selection.durationMinutes; minute += SLOT_STEP) {
          if (busy.has(minute)) {
            free = false;
            break;
          }
        }
        if (free) times.push(formatTime(start));
      }
    }
    if (times.length) {
      availableDates.push(date);
      slotsByDate[date] = times;
    }
  }
  return { month, availableDates, slotsByDate, durationMinutes: selection.durationMinutes, totalPrice: selection.totalPrice };
}

async function allowBookingAttempt(db, ip) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  const key = [...new Uint8Array(digest)].slice(0, 12).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % 60);
  const row = await db.prepare(`INSERT INTO rate_limits (rate_key, window_start, request_count)
    VALUES (?, ?, 1)
    ON CONFLICT(rate_key) DO UPDATE SET
      request_count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.request_count + 1 ELSE 1 END,
      window_start = excluded.window_start
    RETURNING request_count`).bind(key, windowStart).first();
  return Number(row?.request_count || 1) <= 6;
}

async function telegram(env, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram ${method} failed`);
  return result.result;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function money(value) {
  return `${Number(value).toLocaleString("ru-RU")} р`;
}

function formatDate(date) {
  const [year, month, day] = date.split("-");
  return `${day}.${month}.${year}`;
}

async function sendNewBooking(env, booking) {
  const services = booking.services.map((service) => `• ${escapeHtml(service.label)} — ${money(service.price)}`).join("\n");
  const text = `🆕 <b>Новая запись</b>\n\n<b>${escapeHtml(formatDate(booking.date))} в ${formatTime(booking.startMinute)}</b>\nКлиент: ${escapeHtml(booking.name)}\nТелефон: ${escapeHtml(booking.phone)}\n\n${services}\n\nИтого: <b>${money(booking.totalPrice)}</b>\nДлительность: ${booking.durationMinutes} мин`;
  await telegram(env, "sendMessage", {
    chat_id: env.ADMIN_TELEGRAM_ID,
    text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "📋 Открыть меню записей", callback_data: "menu:bookings:0" }]] },
  });
}

async function retryNotifications(env) {
  const now = Math.floor(Date.now() / 1000);
  const result = await env.DB.prepare(`SELECT n.id, n.attempts, a.id AS appointment_id, a.client_name,
    a.phone, a.local_date, a.start_minute, a.end_minute, a.duration_minutes, a.services_json, a.total_price_byn
    FROM notification_outbox n JOIN appointments a ON a.id = n.appointment_id
    WHERE n.delivered_at IS NULL AND n.deliver_after <= ? ORDER BY n.deliver_after LIMIT 10`)
    .bind(now).all();

  for (const row of result.results || []) {
    try {
      await sendNewBooking(env, {
        id: row.appointment_id,
        name: row.client_name,
        phone: row.phone,
        date: row.local_date,
        startMinute: Number(row.start_minute),
        endMinute: Number(row.end_minute),
        durationMinutes: Number(row.duration_minutes),
        services: JSON.parse(row.services_json),
        totalPrice: Number(row.total_price_byn),
      });
      await env.DB.prepare("UPDATE notification_outbox SET delivered_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(row.id).run();
    } catch (_error) {
      const attempts = Number(row.attempts) + 1;
      const delay = attempts > 8 ? 86400 : Math.min(300 * (2 ** Math.min(attempts, 4)), 3600);
      await env.DB.prepare("UPDATE notification_outbox SET attempts = ?, deliver_after = ? WHERE id = ?")
        .bind(attempts, now + delay, row.id).run();
    }
  }
}

async function sendAdmin(env, chatId, text, replyMarkup) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

function mainMenu() {
  return { inline_keyboard: [
    [{ text: "📋 Записи", callback_data: "menu:bookings:0" }, { text: "📅 Сегодня", callback_data: "menu:today" }],
    [{ text: "⚙️ Рабочий график", callback_data: "menu:schedule" }],
    [{ text: "✂️ Длительность услуг", callback_data: "menu:services" }],
  ] };
}

async function handleTelegramUpdate(update, env) {
  if (update.callback_query) {
    const query = update.callback_query;
    if (String(query.from?.id) !== String(env.ADMIN_TELEGRAM_ID) || query.message?.chat?.type !== "private") return;
    await telegram(env, "answerCallbackQuery", { callback_query_id: query.id }).catch(() => {});
    await handleAdminCallback(query, env);
    return;
  }

  const message = update.message;
  if (!message || String(message.from?.id) !== String(env.ADMIN_TELEGRAM_ID) || message.chat?.type !== "private") return;
  if (message.text) await handleAdminMessage(message, env);
}

async function handleAdminCallback(query, env) {
  const chatId = query.message.chat.id;
  const data = String(query.data || "");

  if (data === "menu" || data === "menu:home") {
    await sendAdmin(env, chatId, "<b>DZEN · управление записями</b>\nВыберите раздел:", mainMenu());
  } else if (data.startsWith("menu:bookings:")) {
    const page = Number(data.split(":")[2]) || 0;
    await showBookings(env, chatId, page);
  } else if (data === "menu:today") {
    await showBookings(env, chatId, 0, true);
  } else if (data === "menu:schedule") {
    await showSchedule(env, chatId);
  } else if (data === "menu:services") {
    await showServices(env, chatId);
  } else if (data.startsWith("day:")) {
    const weekday = Number(data.split(":")[1]);
    if (weekday >= 0 && weekday <= 6) {
      await saveAdminState(env.DB, env.ADMIN_TELEGRAM_ID, "weekday", { weekday });
      await sendAdmin(env, chatId, `Укажите часы для <b>${DAY_NAMES[weekday]}</b>:\n<code>09:00-13:00, 14:00-18:00</code>\nИли напишите <code>выходной</code>. Интервалы задаются с шагом 15 минут.`);
    }
  } else if (data === "schedule:override") {
    await saveAdminState(env.DB, env.ADMIN_TELEGRAM_ID, "override", {});
    await sendAdmin(env, chatId, `Особый день:\n<code>2026-12-25 выходной</code>\nили <code>2026-12-25 10:00-15:00</code>\nСбросить настройку даты: <code>2026-12-25 сброс</code>.`);
  } else if (data.startsWith("service:")) {
    const serviceId = data.slice("service:".length);
    const service = await env.DB.prepare("SELECT id, label, duration_minutes FROM services WHERE id = ?")
      .bind(serviceId).first();
    if (service) {
      await saveAdminState(env.DB, env.ADMIN_TELEGRAM_ID, "service", { serviceId });
      await sendAdmin(env, chatId, `Длительность для <b>${escapeHtml(service.label)}</b> в минутах.\nДля услуги без заданного времени укажите число минут. Для дополнительной услуги 0 означает без дополнительного времени; чтобы отключить услугу, напишите <code>выкл</code>. Сейчас: ${Number(service.duration_minutes)} мин.`);
    }
  } else if (data.startsWith("delete:")) {
    const id = data.slice("delete:".length);
    const booking = await getBooking(env.DB, id);
    if (booking) {
      await sendAdmin(env, chatId, `Удалить запись <b>${formatDate(booking.local_date)} в ${formatTime(Number(booking.start_minute))}</b> — ${escapeHtml(booking.client_name)}?`, {
        inline_keyboard: [[{ text: "Да, удалить", callback_data: `delete-yes:${id}` }, { text: "Отмена", callback_data: "menu:bookings:0" }]],
      });
    }
  } else if (data.startsWith("delete-yes:")) {
    const id = data.slice("delete-yes:".length);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM appointment_slots WHERE appointment_id = ?").bind(id),
      env.DB.prepare("DELETE FROM notification_outbox WHERE appointment_id = ?").bind(id),
      env.DB.prepare("DELETE FROM appointments WHERE id = ?").bind(id),
    ]);
    await sendAdmin(env, chatId, "Запись удалена, время снова доступно для бронирования.", mainMenu());
  }
}

async function showBookings(env, chatId, page = 0, todayOnly = false) {
  const today = minskNow().date;
  const offset = Math.max(0, page) * 8;
  const query = todayOnly
    ? env.DB.prepare(`SELECT * FROM appointments WHERE local_date = ? ORDER BY start_minute LIMIT 8 OFFSET ?`).bind(today, offset)
    : env.DB.prepare(`SELECT * FROM appointments ORDER BY local_date DESC, start_minute DESC LIMIT 8 OFFSET ?`).bind(offset);
  const result = await query.all();
  const rows = result.results || [];
  await sendAdmin(env, chatId, todayOnly ? `<b>Записи на ${formatDate(today)}</b>` : "<b>Все записи · сначала новые</b>");
  if (!rows.length) {
    await sendAdmin(env, chatId, "Записей нет.", mainMenu());
    return;
  }
  for (const booking of rows) {
    const services = JSON.parse(booking.services_json).map((item) => escapeHtml(item.label)).join(", ");
    const text = `🗓 <b>${formatDate(booking.local_date)} · ${formatTime(Number(booking.start_minute))}</b>\n${escapeHtml(booking.client_name)} · ${escapeHtml(booking.phone)}\n${services}\n${money(booking.total_price_byn)} · ${booking.duration_minutes} мин`;
    await sendAdmin(env, chatId, text, { inline_keyboard: [[{ text: "🗑 Удалить запись", callback_data: `delete:${booking.id}` }]] });
  }
  const controls = [];
  if (page > 0) controls.push({ text: "← Новее", callback_data: `menu:bookings:${page - 1}` });
  if (rows.length === 8) controls.push({ text: "Старее →", callback_data: `menu:bookings:${page + 1}` });
  if (controls.length) await sendAdmin(env, chatId, "Страницы записей:", { inline_keyboard: [controls] });
  await sendAdmin(env, chatId, "Меню:", mainMenu());
}

async function showSchedule(env, chatId) {
  const result = await env.DB.prepare("SELECT weekday, windows_json FROM weekly_schedule ORDER BY weekday").all();
  const rows = result.results || [];
  const lines = rows.map((row) => {
    const windows = parseWindows(row.windows_json).map((window) => `${formatTime(window.start)}–${formatTime(window.end)}`).join(", ") || "выходной";
    return `${DAY_NAMES[Number(row.weekday)]}: ${windows}`;
  });
  const overrides = await env.DB.prepare("SELECT local_date, windows_json FROM date_overrides WHERE local_date >= ? ORDER BY local_date LIMIT 10")
    .bind(minskNow().date).all();
  const exceptionLines = (overrides.results || []).map((row) => {
    const windows = parseWindows(row.windows_json).map((window) => `${formatTime(window.start)}–${formatTime(window.end)}`).join(", ") || "выходной";
    return `${formatDate(row.local_date)}: ${windows}`;
  });
  const text = `<b>Рабочий график · Europe/Minsk</b>\n${lines.join("\n")}\n\n<b>Ближайшие особые дни</b>\n${exceptionLines.join("\n") || "Пока не заданы"}`;
  const buttons = rows.map((row) => [{ text: `${DAY_NAMES[Number(row.weekday)]} · ${parseWindows(row.windows_json).map((window) => `${formatTime(window.start)}-${formatTime(window.end)}`).join(", ") || "выходной"}`, callback_data: `day:${row.weekday}` }]);
  buttons.push([{ text: "➕ Настроить дату / выходной", callback_data: "schedule:override" }]);
  buttons.push([{ text: "↩️ Главное меню", callback_data: "menu" }]);
  await sendAdmin(env, chatId, text, { inline_keyboard: buttons });
}

async function showServices(env, chatId) {
  const result = await env.DB.prepare("SELECT id, label, duration_minutes, requires_duration, active FROM services ORDER BY sort_order").all();
  const rows = result.results || [];
  const buttons = [];
  for (let index = 0; index < rows.length; index += 2) {
    buttons.push(rows.slice(index, index + 2).map((service) => ({
      text: `${service.active ? "✂️" : "⏸"}${service.requires_duration && !Number(service.duration_minutes) ? "⚠️" : ""} ${service.label.slice(0, 17)} · ${Number(service.duration_minutes)}м`,
      callback_data: `service:${service.id}`,
    })));
  }
  buttons.push([{ text: "↩️ Главное меню", callback_data: "menu" }]);
  await sendAdmin(env, chatId, "<b>Длительность услуг</b>\nНажмите услугу и укажите длительность в минутах. Для пометки ⚠️ время нужно задать до онлайн-записи. Дополнительным услугам можно оставить 0 мин.", { inline_keyboard: buttons });
}

async function getBooking(db, id) {
  return db.prepare("SELECT * FROM appointments WHERE id = ?").bind(id).first();
}

async function saveAdminState(db, adminId, action, payload) {
  const expires = Math.floor(Date.now() / 1000) + 600;
  await db.prepare(`INSERT INTO admin_state (admin_id, action, payload, expires_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(admin_id) DO UPDATE SET action = excluded.action, payload = excluded.payload, expires_at = excluded.expires_at`)
    .bind(String(adminId), action, JSON.stringify(payload), expires).run();
}

async function handleAdminMessage(message, env) {
  const chatId = message.chat.id;
  const text = String(message.text || "").trim();
  const state = await env.DB.prepare("SELECT action, payload, expires_at FROM admin_state WHERE admin_id = ?")
    .bind(String(env.ADMIN_TELEGRAM_ID)).first();

  if (state && Number(state.expires_at) >= Math.floor(Date.now() / 1000) && !text.startsWith("/")) {
    const payload = JSON.parse(state.payload || "{}");
    let complete = false;
    if (state.action === "weekday") complete = await updateWeekday(env, chatId, Number(payload.weekday), text);
    else if (state.action === "override") complete = await updateOverride(env, chatId, text);
    else if (state.action === "service") complete = await updateService(env, chatId, payload.serviceId, text);
    if (complete) await env.DB.prepare("DELETE FROM admin_state WHERE admin_id = ?").bind(String(env.ADMIN_TELEGRAM_ID)).run();
    return;
  }

  if (text === "/start" || text === "/menu") {
    await sendAdmin(env, chatId, "<b>DZEN · управление записями</b>\nВыберите раздел:", mainMenu());
  } else if (text === "/bookings") {
    await showBookings(env, chatId, 0);
  } else if (text === "/today") {
    await showBookings(env, chatId, 0, true);
  } else {
    await sendAdmin(env, chatId, "Откройте меню кнопкой /menu.", mainMenu());
  }
}

function parseWindowsInput(text) {
  if (/^выходной$/i.test(text.trim())) return [];
  const parts = text.split(",").map((item) => item.trim()).filter(Boolean);
  if (!parts.length || parts.length > 4) return null;
  const windows = [];
  for (const part of parts) {
    const match = /^(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})$/.exec(part);
    if (!match) return null;
    const start = parseTime(match[1].padStart(5, "0"));
    const end = parseTime(match[2].padStart(5, "0"));
    if (start < 0 || end <= start || start % SLOT_STEP || end % SLOT_STEP) return null;
    windows.push({ start, end });
  }
  windows.sort((a, b) => a.start - b.start);
  for (let index = 1; index < windows.length; index += 1) {
    if (windows[index].start < windows[index - 1].end) return null;
  }
  return windows;
}

async function updateWeekday(env, chatId, weekday, text) {
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return false;
  const windows = parseWindowsInput(text);
  if (windows === null) {
    await telegramMessageOnly(env, chatId, `Формат не распознан. Пример: <code>09:00-13:00, 14:00-18:00</code> или <code>выходной</code>. Время — с шагом 15 минут.`);
    return false;
  }
  await env.DB.prepare(`INSERT INTO weekly_schedule (weekday, windows_json) VALUES (?, ?)
    ON CONFLICT(weekday) DO UPDATE SET windows_json = excluded.windows_json`)
    .bind(weekday, JSON.stringify(windows)).run();
  await telegramMessageOnly(env, chatId, `График на <b>${DAY_NAMES[weekday]}</b> обновлён.`, mainMenu());
  return true;
}

async function updateOverride(env, chatId, text) {
  const match = /^(\d{4}-\d{2}-\d{2})\s+(.+)$/.exec(text);
  if (!match || !isValidDate(match[1])) {
    await telegramMessageOnly(env, chatId, `Формат: <code>2026-12-25 выходной</code>, <code>2026-12-25 10:00-15:00</code> или <code>2026-12-25 сброс</code>.`);
    return false;
  }
  const [, date, value] = match;
  if (/^сброс$/i.test(value.trim())) {
    await env.DB.prepare("DELETE FROM date_overrides WHERE local_date = ?").bind(date).run();
    await telegramMessageOnly(env, chatId, `Особая настройка на ${formatDate(date)} удалена. Применяется недельный график.`, mainMenu());
    return true;
  }
  const windows = parseWindowsInput(value);
  if (windows === null) {
    await telegramMessageOnly(env, chatId, `Не распознал время. Укажите <code>YYYY-MM-DD 10:00-15:00</code> или <code>YYYY-MM-DD выходной</code>.`);
    return false;
  }
  await env.DB.prepare(`INSERT INTO date_overrides (local_date, windows_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(local_date) DO UPDATE SET windows_json = excluded.windows_json, updated_at = CURRENT_TIMESTAMP`)
    .bind(date, JSON.stringify(windows)).run();
  await telegramMessageOnly(env, chatId, `Расписание на ${formatDate(date)} обновлено.`, mainMenu());
  return true;
}

async function updateService(env, chatId, serviceId, text) {
  if (/^выкл$/i.test(text.trim())) {
    await env.DB.prepare("UPDATE services SET active = 0 WHERE id = ?").bind(serviceId).run();
    await telegramMessageOnly(env, chatId, "Услуга отключена в онлайн-записи.", mainMenu());
    return true;
  }
  const duration = Number(text);
  if (!Number.isInteger(duration) || duration < 0 || duration > MAX_BOOKING_MINUTES) {
    await telegramMessageOnly(env, chatId, "Укажите число минут от 0 до 480 или напишите «выкл».");
    return false;
  }
  const service = await env.DB.prepare("SELECT requires_duration FROM services WHERE id = ?").bind(serviceId).first();
  const active = duration === 0 && service?.requires_duration ? 0 : 1;
  await env.DB.prepare("UPDATE services SET duration_minutes = ?, active = ? WHERE id = ?")
    .bind(duration, active, serviceId).run();
  await telegramMessageOnly(env, chatId, duration ? `Длительность сохранена: ${duration} мин.` : (active ? "Услуга оставлена без дополнительного времени." : "Услуга отключена в онлайн-записи."), mainMenu());
  return true;
}

async function telegramMessageOnly(env, chatId, text, replyMarkup) {
  await sendAdmin(env, chatId, text, replyMarkup);
}
