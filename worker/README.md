# DZEN booking backend

The GitHub Pages site stays static. This Cloudflare Worker exposes the booking API, Cloudflare D1 stores the schedule and appointments, and a Telegram bot provides the administrator menu.

## What it does

- Returns only dates and times that fit the selected services and the current schedule.
- Rechecks a slot while saving the booking. Unique 15-minute reservations and a D1 transaction prevent two clients from taking overlapping slots at the same time.
- Sends the administrator a Telegram notification with the customer, phone, services, price, date, and time. Failed notifications are queued and retried by the Worker cron trigger.
- Provides a Telegram menu for upcoming bookings, today's bookings, weekly hours, one-off days, and service durations. Deleting a booking also releases its time.
- Treats all dates and times as `Europe/Minsk`. Working hours use 15-minute boundaries; service durations are rounded up to the next 15 minutes when reserving a slot.

The weekly schedule starts closed. The administrator opens `/start` in the bot and sets weekly hours before taking live bookings. The site already shows durations for most services. The bot marks and blocks services whose duration was not listed on the site until the administrator sets a duration.

## Deploy

Requirements: a Cloudflare account, Node.js, npm, and a Telegram bot created with `@BotFather`.

1. Create the Telegram bot with `@BotFather`. Keep its token private. Find the administrator's numeric Telegram user ID (for example, from Telegram's `@userinfobot`).
2. From this directory install Wrangler and sign in:

   ```sh
   npm install
   npx wrangler login
   ```

3. Create the D1 database and copy its ID from the command output into `database_id` in `wrangler.toml`:

   ```sh
   npx wrangler d1 create dzen-bookings
   ```

4. Replace `ADMIN_TELEGRAM_ID` in `wrangler.toml` with the administrator's numeric Telegram user ID, then apply the schema and service catalog:

   ```sh
   npx wrangler d1 migrations apply dzen-bookings --remote
   ```

5. Add the bot token and a new random webhook secret through Wrangler's hidden input prompts. Do not put either value in Git or in `wrangler.toml`:

   ```sh
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
   ```

6. Deploy the Worker and copy the `workers.dev` URL printed by Wrangler:

   ```sh
   npx wrangler deploy
   ```

7. Register the Telegram webhook. In a zsh terminal, enter the values at hidden prompts, then paste the following command with the Worker's URL in `WORKER_URL`:

   ```sh
   read -s 'BOT_TOKEN?Telegram bot token: '
   read -s 'HOOK_SECRET?Webhook secret: '
   WORKER_URL='https://dzen-bookings.YOUR_ACCOUNT.workers.dev'
   curl -fsS -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
     --data-urlencode "url=${WORKER_URL}/telegram/webhook" \
     --data-urlencode "secret_token=${HOOK_SECRET}" \
     --data-urlencode 'allowed_updates=["message","callback_query"]'
   unset BOT_TOKEN HOOK_SECRET WORKER_URL
   ```

   Use the same bot token and webhook secret saved with Wrangler.

8. Put the Worker URL in the `data-booking-api` attribute on the site's `<main>` element in `index.html`:

   ```html
   <main id="top" data-booking-api="https://dzen-bookings.YOUR_ACCOUNT.workers.dev">
   ```

   Commit and push the site change so GitHub Pages can publish it.

9. Open the bot, send `/start`, and set working hours, date overrides, and any service durations marked `?`. The admin menu starts closed, so no appointment slots are offered until hours are configured.

## Administrator menu

- **Записи**: list upcoming appointments and remove one after a confirmation tap.
- **Сегодня**: today's appointments.
- **Рабочий график**: select a weekday and send ranges such as `09:00-13:00, 14:00-18:00`, or `выходной`.
- **Настроить дату / выходной**: send `2026-12-25 10:00-15:00`, `2026-12-25 выходной`, or `2026-12-25 сброс`.
- **Длительность услуг**: select a service and send its duration in minutes. Send `0` to disable a service.

The API allows requests from the GitHub Pages origin configured in `SITE_ORIGIN`. The site's API URL is intentionally empty until a Worker is deployed. The website itself continues to run on GitHub Pages; the Worker and D1 run on Cloudflare.

## Customer data

The database stores the customer's name, phone, selected services, and appointment time. The booking form asks permission to store those details in D1 and send them to the administrator through Telegram. D1 is a Cloudflare hosted database, and Telegram receives the notification; neither is hosted in Belarus. Before enabling real bookings, publish the operator's privacy notice and set its retention period. Do not commit bot tokens or customer records.
