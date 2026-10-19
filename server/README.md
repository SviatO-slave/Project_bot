# Сервер підписки (Telegram Stars)

Маленький сервер на Cloudflare Workers. Він:

- створює рахунок-підписку на 150 ⭐ на місяць;
- приймає оплату від Telegram і запам'ятовує, до якої дати в людини є доступ;
- відповідає додатку, чи є в людини повний доступ;
- відповідає в боті на `/start`, `/paysupport`, `/terms`.

Токен бота зберігається тільки в Cloudflare, у репозиторії його немає.

## Налаштування (~15 хвилин, один раз)

1. **Акаунт.** Зареєструйся на https://dash.cloudflare.com, безкоштовного плану вистачає.
2. **Worker.** Compute (Workers) → Create → Start with Hello World → назва, наприклад `yizh-bot` → Deploy.
   Далі Edit code, видали все, встав вміст `worker.js` → Deploy.
   Адреса worker буде на кшталт `https://yizh-bot.<твій-нік>.workers.dev`.
3. **Сховище KV.** Storage & Databases → KV → Create → назва `SUBS`.
   Потім у worker: Settings → Bindings → Add → KV namespace → Variable name `SUBS`, namespace `SUBS`.
4. **Змінні.** У worker: Settings → Variables and Secrets → Add.

   | Назва | Тип | Значення |
   | --- | --- | --- |
   | `BOT_TOKEN` | Secret | токен з BotFather |
   | `WEBHOOK_SECRET` | Secret | будь-який довгий рядок з латиниці й цифр, напр. `yizh_8f3k2m9q7x` |
   | `PRICE_STARS` | Text | `150` |
   | `APP_URL` | Text | `https://sviato-slave.github.io/Project_bot/` |
   | `SUPPORT` | Text | `@твій_нік` для питань щодо оплати |
   | `ADMIN_ID` | Text | твій Telegram ID (можна дізнатися в @userinfobot), необов'язково |

   Після цього натисни Deploy.
5. **Підключення до бота.** Відкрий у браузері `https://<адреса-worker>/setup?key=<WEBHOOK_SECRET>`.
   Має з'явитися `"ok": true` і назва бота.
6. **Адреса для додатку.** Надішли Claude адресу worker (не токен!), щоб він вписав її в додаток.

## Команди в боті

- `/start` — привітання і кнопка «Відкрити додаток»;
- `/paysupport` — контакт для питань щодо оплати (Telegram вимагає цю команду для ботів зі Stars);
- `/terms` — умови підписки;
- `/stats` — кількість активних підписок (тільки для `ADMIN_ID`);
- `/refund <user_id>` — повернути Stars і закрити доступ (тільки для `ADMIN_ID`).

## Гроші

Stars накопичуються на балансі бота: @BotFather → бот → Balance, або в налаштуваннях бота в Telegram.

- Вивести можна від 1000 ⭐.
- Кожну оплату можна вивести лише через 21 день після надходження.
- Виведення йде через Fragment у TON.
