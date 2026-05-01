import cors from "cors";
import dotenv from "dotenv";
import express, { Request, Response } from "express";
import fs from "fs";
import TelegramBot from "node-telegram-bot-api";
import path from "path";
import {
    canGenerate,
    cleanExpiredFiles,
    consumeGeneration,
    getUserGenerations,
    getUserProfile,
    getUserSubscriptionTier,
    getOrCreateUser,
    saveGenerationHistory
} from './quotaService';
import { supabase } from "./quotaService";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TEMP_DIR = path.join(__dirname, "temp");

// Проверка ключа ElevenLabs
if (!ELEVENLABS_API_KEY) {
    console.error("❌ ELEVENLABS_API_KEY is not set");
    process.exit(1);
}

// Создание папки temp, если её нет
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json());
app.use("/temp", express.static(TEMP_DIR));

type ProductType = "minutes" | "subscription";
type ProductConfig = {
    productType: ProductType;
    productValue: number;
    amount: number;
    title: string;
    description: string;
    label: string;
};

const PRODUCT_CATALOG: Record<string, ProductConfig> = {
    "minutes_100": {
        productType: "minutes",
        productValue: 100,
        amount: 50,
        title: "100 минут VoiceStudio",
        description: "Пакет из 100 дополнительных минут генерации",
        label: "100 минут"
    },
    "pro_30d": {
        productType: "subscription",
        productValue: 1,
        amount: 100,
        title: "Pro подписка на 30 дней",
        description: "Безлимитная генерация + хранение файлов до 30 дней",
        label: "Pro 30 дней"
    },
    "premium_30d": {
        productType: "subscription",
        productValue: 2,
        amount: 200,
        title: "Premium подписка на 30 дней",
        description: "Максимальный тариф и бессрочное хранение файлов",
        label: "Premium 30 дней"
    }
};

const addDaysToDate = (baseDate: Date, days: number) => {
    const nextDate = new Date(baseDate);
    nextDate.setDate(nextDate.getDate() + days);
    return nextDate;
};

type CreateInvoiceRequest = {
    telegramId?: number;
    productType?: ProductType;
    productValue?: number;
    amountStars?: number;
};

type UserLanguage = "ru" | "en";
type UpdateUserLanguageRequest = {
    telegramId?: number;
    language?: UserLanguage;
};

const getBot = () => {
    if (!TELEGRAM_BOT_TOKEN) {
        return null;
    }
    return new TelegramBot(TELEGRAM_BOT_TOKEN, { webHook: true });
};

const telegramBot = getBot();

if (!telegramBot) {
    console.warn("⚠️ TELEGRAM_BOT_TOKEN is not set. Telegram payments are disabled.");
} else {
    telegramBot.onText(/^\/buy/i, async (msg: TelegramBot.Message) => {
        const chatId = msg.chat.id;
        try {
            await telegramBot.sendMessage(chatId, "Выберите продукт для оплаты Telegram Stars:", {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "100 минут = 50 ⭐️", callback_data: "buy:minutes_100" }],
                        [{ text: "Pro 30 дней = 100 ⭐️", callback_data: "buy:pro_30d" }],
                        [{ text: "Premium 30 дней = 200 ⭐️", callback_data: "buy:premium_30d" }]
                    ]
                }
            });
        } catch (error) {
            console.error("Failed to send /buy options:", error);
        }
    });

    telegramBot.on("callback_query", async (query: TelegramBot.CallbackQuery) => {
        const telegramId = query.from.id;
        const chatId = query.message?.chat.id;
        const action = query.data;
        if (!action?.startsWith("buy:") || !chatId) {
            await telegramBot.answerCallbackQuery(query.id);
            return;
        }

        const productKey = action.replace("buy:", "");
        const product = PRODUCT_CATALOG[productKey];
        if (!product) {
            await telegramBot.answerCallbackQuery(query.id, { text: "Неизвестный товар", show_alert: true });
            return;
        }

        const payload = `inv_${Date.now()}_${telegramId}_${productKey}`;
        try {
            const { error } = await supabase.from("stars_invoices").insert([{
                id: payload,
                telegram_id: telegramId,
                amount: product.amount,
                product_type: product.productType,
                product_value: product.productValue,
                status: "pending"
            }]);
            if (error) {
                throw error;
            }

            await telegramBot.sendInvoice(
                chatId,
                product.title,
                product.description,
                payload,
                "",
                "XTR",
                [{ label: product.label, amount: product.amount }]
            );

            await telegramBot.answerCallbackQuery(query.id, { text: "Счёт отправлен в чат" });
        } catch (error) {
            console.error("Failed to create invoice:", error);
            await telegramBot.answerCallbackQuery(query.id, {
                text: "Не удалось создать счёт. Попробуйте позже.",
                show_alert: true
            });
        }
    });

    telegramBot.on("pre_checkout_query", async (preCheckoutQuery: TelegramBot.PreCheckoutQuery) => {
        try {
            const payload = preCheckoutQuery.invoice_payload;
            const { data, error } = await supabase
                .from("stars_invoices")
                .select("id, status")
                .eq("id", payload)
                .single();

            const isValid = !error && data && data.status !== "paid";
            await telegramBot.answerPreCheckoutQuery(preCheckoutQuery.id, isValid, {
                error_message: isValid ? undefined : "Счёт недействителен или уже оплачен."
            });
        } catch (error) {
            console.error("Pre-checkout validation failed:", error);
            await telegramBot.answerPreCheckoutQuery(preCheckoutQuery.id, false, {
                error_message: "Ошибка проверки платежа. Повторите попытку."
            });
        }
    });

    telegramBot.on("message", async (msg: TelegramBot.Message) => {
        if (!msg.successful_payment) {
            return;
        }

        const payment = msg.successful_payment;
        const payload = payment.invoice_payload;
        const telegramId = msg.from?.id;

        if (!telegramId) {
            return;
        }

        try {
            const { data: invoice, error: invoiceError } = await supabase
                .from("stars_invoices")
                .select("id, telegram_id, amount, product_type, product_value, status")
                .eq("id", payload)
                .single();

            if (invoiceError || !invoice || invoice.status === "paid") {
                throw new Error("Invoice not found or already paid");
            }

            await supabase
                .from("stars_invoices")
                .update({ status: "paid" })
                .eq("id", payload);

            await supabase.from("payments").insert([{
                telegram_payment_charge_id: payment.telegram_payment_charge_id,
                invoice_id: payload,
                amount: payment.total_amount
            }]);

            const user = await getOrCreateUser(telegramId);

            if (invoice.product_type === "minutes") {
                const nextMinutes = (user.stars_minutes ?? 0) + Number(invoice.product_value);
                await supabase
                    .from("users")
                    .update({ stars_minutes: nextMinutes })
                    .eq("telegram_id", telegramId);
            } else if (invoice.product_type === "subscription") {
                const nextTier = Number(invoice.product_value) === 2 ? "premium" : "pro";
                const currentExpiry = user.subscription_expires_at ? new Date(user.subscription_expires_at) : null;
                const now = new Date();
                const startDate = currentExpiry && currentExpiry.getTime() > now.getTime() ? currentExpiry : now;
                const nextExpiry = addDaysToDate(startDate, 30);

                await supabase
                    .from("users")
                    .update({
                        subscription_tier: nextTier,
                        subscription_expires_at: nextExpiry.toISOString()
                    })
                    .eq("telegram_id", telegramId);
            }

            await telegramBot.sendMessage(msg.chat.id, "Оплата прошла успешно! Доступ обновлён.");
        } catch (error) {
            console.error("Failed to process successful payment:", error);
            await telegramBot.sendMessage(msg.chat.id, "Платёж получен, но произошла ошибка обработки. Поддержка уже уведомлена.");
        }
    });
}

app.post("/webhook/bot", async (req: Request, res: Response) => {
    if (!telegramBot) {
        return res.status(503).json({ error: "Telegram bot is not configured" });
    }

    try {
        telegramBot.processUpdate(req.body);
        return res.sendStatus(200);
    } catch (error: any) {
        console.error("Webhook processing error:", error);
        return res.status(500).json({ error: error.message ?? "Webhook processing failed" });
    }
});

app.post("/api/create-invoice", async (req: Request, res: Response) => {
    try {
        const {
            telegramId,
            productType,
            productValue,
            amountStars
        } = req.body as CreateInvoiceRequest;

        if (!Number.isFinite(telegramId) || Number(telegramId) <= 0) {
            return res.status(400).json({ error: "Invalid telegramId" });
        }

        if (productType !== "minutes" && productType !== "subscription") {
            return res.status(400).json({ error: "Invalid productType" });
        }

        if (!Number.isFinite(productValue) || Number(productValue) <= 0) {
            return res.status(400).json({ error: "Invalid productValue" });
        }

        if (!Number.isFinite(amountStars) || Number(amountStars) <= 0) {
            return res.status(400).json({ error: "Invalid amountStars" });
        }

        const safeTelegramId = Number(telegramId);
        const safeProductValue = Number(productValue);
        const safeAmountStars = Number(amountStars);
        const payloadPrefix = productType === "minutes" ? "min" : "sub";
        const payload = `${payloadPrefix}_${Date.now()}_${safeTelegramId}`;

        const { error } = await supabase.from("stars_invoices").insert([{
            id: payload,
            telegram_id: safeTelegramId,
            amount: safeAmountStars,
            product_type: productType,
            product_value: safeProductValue,
            status: "pending"
        }]);

        if (error) {
            throw error;
        }

        if (!telegramBot) {
            return res.status(503).json({ error: "Telegram bot is not configured" });
        }

        const title =
            productType === "minutes"
                ? `${safeProductValue} минут VoiceStudio`
                : safeProductValue === 2
                    ? "Premium подписка на 30 дней"
                    : "Pro подписка на 30 дней";
        const description =
            productType === "minutes"
                ? `Пакет из ${safeProductValue} дополнительных минут генерации`
                : "Оплата подписки VoiceStudio Pro";
        const label =
            productType === "minutes"
                ? `${safeProductValue} минут`
                : safeProductValue === 2
                    ? "Premium 30 дней"
                    : "Pro 30 дней";

        const invoiceLink = await telegramBot.createInvoiceLink(
            title,
            description,
            payload,
            "",
            "XTR",
            [{ label, amount: safeAmountStars }]
        );

        return res.json({
            payload,
            amountStars: safeAmountStars,
            invoiceLink
        });
    } catch (err: any) {
        console.error("Create invoice error:", err);
        return res.status(500).json({ error: err.message ?? "Failed to create invoice" });
    }
});

// Получение списка голосов
app.get(["/voices", "/api/voices"], async (_req: Request, res: Response) => {
    try {
        const response = await fetch("https://api.elevenlabs.io/v1/voices", {
            method: "GET",
            headers: { "xi-api-key": ELEVENLABS_API_KEY! }
        });
        if (!response.ok) {
            throw new Error(`ElevenLabs API error: ${response.status}`);
        }
        const data = await response.json();
        res.json(data);
    } catch (err: any) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Генерация аудио (прямой API, без дополнительных пакетов)
app.post("/api/generate", async (req: Request, res: Response) => {
    try {
        const { text, voiceId, speed = 1.0, pitch = 0, telegramId } = req.body;

        // Проверка обязательных полей
        if (!text || !voiceId) {
            return res.status(400).json({ error: "Missing text or voiceId" });
        }
        if (!telegramId) {
            return res.status(400).json({ error: "Missing telegramId. Please login." });
        }

        const parsedSpeed = Number.parseFloat(String(speed));
        const parsedPitch = Number.parseFloat(String(pitch));
        const safeSpeed = Number.isFinite(parsedSpeed) ? Math.min(Math.max(parsedSpeed, 0.5), 2.0) : 1.0;
        const safePitch = Number.isFinite(parsedPitch) ? Math.min(Math.max(parsedPitch, -1.0), 1.0) : 0;

        console.log("🎛️ Voice settings received:", {
            telegramId,
            voiceId,
            rawSpeed: speed,
            rawPitch: pitch,
            speed: safeSpeed,
            pitch: safePitch
        });

        // Проверка квоты
        const canGen = await canGenerate(telegramId);
        if (!canGen) {
            return res.status(403).json({ error: "Daily limit reached. Upgrade to Pro for unlimited generations." });
        }

        // Генерация аудио через ElevenLabs (как у вас уже реализовано)
        const apiKey = process.env.ELEVENLABS_API_KEY;
        const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "xi-api-key": apiKey!
            },
            body: JSON.stringify({
                text: text,
                model_id: "eleven_turbo_v2",
                voice_settings: {
                    stability: 0.7,
                    similarity_boost: 0.7,
                    speed: safeSpeed,
                    pitch: safePitch
                }
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error("❌ ElevenLabs generation failed", {
                status: response.status,
                voiceId,
                telegramId,
                speed: safeSpeed,
                pitch: safePitch,
                errorText
            });
            throw new Error(`ElevenLabs error (${response.status}): ${errorText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const filename = `audio_${Date.now()}.mp3`;
        const filePath = path.join(TEMP_DIR, filename);
        fs.writeFileSync(filePath, buffer);

        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.get('host');
        const audioUrl = `${protocol}://${host}/temp/${filename}`;

        // Списать квоту и сохранить историю
        await consumeGeneration(telegramId);
        await saveGenerationHistory(telegramId, text, voiceId, audioUrl);

        res.json({ audioUrl, status: "completed" });
    } catch (err: any) {
        console.error("Generation error:", {
            message: err?.message,
            stack: err?.stack
        });
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/user/language", async (req: Request, res: Response) => {
    try {
        const { telegramId, language } = req.body as UpdateUserLanguageRequest;

        if (!Number.isFinite(telegramId) || Number(telegramId) <= 0) {
            return res.status(400).json({ error: "Invalid telegramId" });
        }
        if (language !== "ru" && language !== "en") {
            return res.status(400).json({ error: "Invalid language" });
        }

        const safeTelegramId = Number(telegramId);
        await getOrCreateUser(safeTelegramId);

        const { error } = await supabase
            .from("users")
            .update({ language })
            .eq("telegram_id", safeTelegramId);

        if (error) {
            throw error;
        }

        return res.json({ ok: true, language });
    } catch (err: any) {
        console.error("User language update error:", err);
        return res.status(500).json({ error: err.message ?? "Failed to update language" });
    }
});

app.get("/api/generations", async (req: Request, res: Response) => {
    try {
        const telegramId = Number(req.query.telegramId);
        const limit = Number(req.query.limit ?? 20);
        const offset = Number(req.query.offset ?? 0);

        if (!Number.isFinite(telegramId) || telegramId <= 0) {
            return res.status(400).json({ error: "Invalid or missing telegramId" });
        }

        const [generations, userTier] = await Promise.all([
            getUserGenerations(telegramId, limit, offset),
            getUserSubscriptionTier(telegramId)
        ]);

        return res.json({
            generations,
            userTier
        });
    } catch (err: any) {
        console.error("Generations fetch error:", err);
        return res.status(500).json({ error: err.message ?? "Failed to fetch generations" });
    }
});

app.get("/api/user/profile", async (req: Request, res: Response) => {
    try {
        const telegramId = Number(req.query.telegramId);
        if (!Number.isFinite(telegramId) || telegramId <= 0) {
            return res.status(400).json({ error: "Invalid or missing telegramId" });
        }

        const profile = await getUserProfile(telegramId);
        return res.json(profile);
    } catch (err: any) {
        console.error("Profile fetch error:", err);
        return res.status(500).json({ error: err.message ?? "Failed to fetch profile" });
    }
});

const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

const runExpiredFilesCleanup = async () => {
    try {
        console.log("🧹 Running expired files cleanup...");
        const removedCount = await cleanExpiredFiles(TEMP_DIR);
        console.log(`🧹 Cleanup completed. Removed files: ${removedCount}`);
    } catch (error) {
        console.error("❌ Expired files cleanup failed:", error);
    }
};

// Первичная очистка при старте
runExpiredFilesCleanup().catch((error) => {
    console.error("❌ Initial cleanup execution failed:", error);
});

// Периодическая очистка каждые 6 часов
setInterval(() => {
    runExpiredFilesCleanup().catch((error) => {
        console.error("❌ Scheduled cleanup execution failed:", error);
    });
}, CLEANUP_INTERVAL_MS);

app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
});