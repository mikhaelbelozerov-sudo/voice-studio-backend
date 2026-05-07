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
    mapTelegramLanguageToSupported,
    saveGenerationHistory
} from './quotaService';
import { supabase } from "./quotaService";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
/** Токен @VoiceStudioSupportBot (если отличается от TELEGRAM_BOT_TOKEN). Иначе сообщения в поддержку не попадут на этот сервер. */
const SUPPORT_BOT_TOKEN = process.env.SUPPORT_BOT_TOKEN?.trim();
const SUPPORT_GROUP_CHAT_ID = Number(process.env.SUPPORT_GROUP_CHAT_ID ?? 0);
/** Публичный HTTPS URL фронтенда Mini App (как в BotFather → Main App). */
const MINI_APP_URL = process.env.MINI_APP_URL?.trim() ?? "";
/**
 * Direct link Mini App из BotFather (например https://t.me/voicestudioprobot/app).
 * Его нужно указывать в web_app-кнопках: на iPhone открытие совпадает с голубой кнопкой «Открыть».
 * Если не задан — используется MINI_APP_URL (часто открывается как нижняя шторка).
 */
const normalizeTelegramHttpsUrl = (raw: string): string => {
    const t = raw.trim();
    if (!t) {
        return "";
    }
    if (t.startsWith("https://") || t.startsWith("http://")) {
        return t;
    }
    if (t.startsWith("t.me/")) {
        return `https://${t}`;
    }
    return t;
};
const MINI_APP_TELEGRAM_LINK = normalizeTelegramHttpsUrl(process.env.MINI_APP_TELEGRAM_LINK ?? "");
const miniAppWebAppOpenUrl = MINI_APP_TELEGRAM_LINK || MINI_APP_URL;
const TEMP_DIR = path.join(__dirname, "temp");

const SUPPORT_RATE_LIMIT_WINDOW_MS = 60_000;
const SUPPORT_RATE_LIMIT_MAX_MESSAGES = 3;

type SupportContext = {
    userId: number;
    firstName?: string;
    username?: string;
};

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

type UserLanguage = "ru" | "en" | "es" | "hi" | "id" | "ar";
type UpdateUserLanguageRequest = {
    telegramId?: number;
    language?: UserLanguage;
};

const getBot = () => {
    if (!TELEGRAM_BOT_TOKEN) {
        return null;
    }
    return new TelegramBot(TELEGRAM_BOT_TOKEN);
};

const telegramBot = getBot();

const supportBotUsesDedicatedToken =
    Boolean(SUPPORT_BOT_TOKEN) && SUPPORT_BOT_TOKEN !== TELEGRAM_BOT_TOKEN;
const supportBot =
    supportBotUsesDedicatedToken && SUPPORT_BOT_TOKEN
        ? new TelegramBot(SUPPORT_BOT_TOKEN)
        : telegramBot;

const supportThreadByUser = new Map<number, number>();
const supportUserByThread = new Map<number, number>();
const supportRootMessageByUser = new Map<number, number>();
const supportUserByGroupMessage = new Map<number, number>();
const supportRateLimit = new Map<number, number[]>();

const normalizeRateWindow = (timestamps: number[], now: number) =>
    timestamps.filter((timestamp) => now - timestamp < SUPPORT_RATE_LIMIT_WINDOW_MS);

const canSendSupportMessage = (userId: number): boolean => {
    const now = Date.now();
    const timestamps = normalizeRateWindow(supportRateLimit.get(userId) ?? [], now);
    if (timestamps.length >= SUPPORT_RATE_LIMIT_MAX_MESSAGES) {
        supportRateLimit.set(userId, timestamps);
        return false;
    }
    timestamps.push(now);
    supportRateLimit.set(userId, timestamps);
    return true;
};

const resolveSupportUserFromReply = (reply?: TelegramBot.Message): number | undefined => {
    if (!reply) {
        return undefined;
    }
    const direct = supportUserByGroupMessage.get(reply.message_id);
    if (direct) {
        return direct;
    }
    if (reply.reply_to_message) {
        return resolveSupportUserFromReply(reply.reply_to_message);
    }
    return undefined;
};

const ensureSupportThread = async (ctx: SupportContext, bot: TelegramBot | null): Promise<number | undefined> => {
    if (!SUPPORT_GROUP_CHAT_ID || !bot) {
        return undefined;
    }
    const existingThread = supportThreadByUser.get(ctx.userId);
    if (existingThread) {
        return existingThread;
    }

    try {
        const topicTitle = `Support #${ctx.userId}${ctx.firstName ? ` • ${ctx.firstName}` : ""}`;
        const forumTopic = await (bot as any).createForumTopic(SUPPORT_GROUP_CHAT_ID, topicTitle);
        const threadId = Number(forumTopic?.message_thread_id);
        if (Number.isFinite(threadId) && threadId > 0) {
            supportThreadByUser.set(ctx.userId, threadId);
            supportUserByThread.set(threadId, ctx.userId);
            return threadId;
        }
    } catch (error) {
        console.warn("Support forum topic creation failed, fallback to reply threads:", error);
    }
    return undefined;
};

const logSupportMessage = async (payload: {
    userId: number;
    direction: "user_to_group" | "group_to_user";
    text: string;
    groupMessageId?: number;
    userMessageId?: number;
    threadId?: number;
}) => {
    try {
        await supabase.from("support_messages").insert([{
            telegram_id: payload.userId,
            direction: payload.direction,
            text: payload.text,
            group_message_id: payload.groupMessageId ?? null,
            user_message_id: payload.userMessageId ?? null,
            thread_id: payload.threadId ?? null
        }]);
    } catch (_error) {
        // Таблица support_messages может отсутствовать; логирование опционально.
    }
};

const getSupportUiText = (
    language: UserLanguage,
    key: "rate_limited" | "sent" | "send_error" | "support_reply_prefix"
): string => {
    const localized: Record<UserLanguage, Record<"rate_limited" | "sent" | "send_error" | "support_reply_prefix", string>> = {
        ru: {
            rate_limited: "Слишком часто. Пожалуйста, отправляйте не более 3 сообщений в минуту.",
            sent: "Сообщение отправлено в поддержку. Мы ответим в этом чате.",
            send_error: "Не удалось отправить сообщение в поддержку. Попробуйте позже.",
            support_reply_prefix: "💬 Ответ поддержки:"
        },
        es: {
            rate_limited: "Demasiados mensajes. Envia no mas de 3 mensajes por minuto.",
            sent: "Tu mensaje ha sido enviado a soporte. Te responderemos en este chat.",
            send_error: "No se pudo enviar tu mensaje a soporte. Intentalo de nuevo mas tarde.",
            support_reply_prefix: "💬 Respuesta de soporte:"
        },
        hi: {
            rate_limited: "बहुत अधिक संदेश। कृपया प्रति मिनट 3 से अधिक संदेश न भेजें।",
            sent: "आपका संदेश सपोर्ट को भेज दिया गया है। हम इसी चैट में जवाब देंगे।",
            send_error: "सपोर्ट को संदेश भेजा नहीं जा सका। कृपया बाद में फिर प्रयास करें।",
            support_reply_prefix: "💬 सपोर्ट का जवाब:"
        },
        id: {
            rate_limited: "Terlalu banyak pesan. Kirim maksimal 3 pesan per menit.",
            sent: "Pesan Anda sudah dikirim ke dukungan. Kami akan membalas di chat ini.",
            send_error: "Gagal mengirim pesan ke dukungan. Coba lagi nanti.",
            support_reply_prefix: "💬 Balasan dukungan:"
        },
        ar: {
            rate_limited: "عدد الرسائل كبير جدا. يرجى ارسال 3 رسائل كحد اقصى في الدقيقة.",
            sent: "تم ارسال رسالتك الى الدعم. سنرد عليك في هذه الدردشة.",
            send_error: "تعذر ارسال رسالتك الى الدعم. حاول مرة اخرى لاحقا.",
            support_reply_prefix: "💬 رد الدعم:"
        },
        en: {
            rate_limited: "Too many messages. Please send no more than 3 messages per minute.",
            sent: "Your message has been sent to support. We will reply in this chat.",
            send_error: "Failed to send your message to support. Please try again later.",
            support_reply_prefix: "💬 Support reply:"
        }
    };
    return localized[language][key];
};

const normalizeDbLanguage = (value: string | null | undefined): UserLanguage => {
    if (value === "ru" || value === "en" || value === "es" || value === "hi" || value === "id" || value === "ar") {
        return value;
    }
    return "en";
};

const getMiniAppStartCopy = (language: UserLanguage) => {
    if (language === "ru") {
        return {
            intro: "Нажмите кнопку ниже, чтобы открыть VoiceStudio. Если на iPhone откроется нижняя шторка, используйте стандартную кнопку Telegram «Открыть» в профиле бота для полноэкранного режима.",
            button: "Открыть VoiceStudio",
            noUrl: "Адрес Mini App на сервере не задан. Напишите в поддержку."
        };
    }
    if (language === "es") {
        return {
            intro: "Pulsa el boton para abrir VoiceStudio. Si en iPhone se abre como panel inferior, usa el boton estandar Abrir de Telegram en el perfil del bot para pantalla completa.",
            button: "Abrir VoiceStudio",
            noUrl: "La URL de Mini App no esta configurada en el servidor. Contacta con soporte."
        };
    }
    if (language === "hi") {
        return {
            intro: "VoiceStudio खोलने के लिए नीचे बटन दबाएं। अगर iPhone पर नीचे की शीट खुले, तो फुलस्क्रीन के लिए बॉट प्रोफाइल में Telegram का Open बटन उपयोग करें।",
            button: "VoiceStudio खोलें",
            noUrl: "सर्वर पर Mini App URL सेट नहीं है। कृपया सपोर्ट से संपर्क करें।"
        };
    }
    if (language === "id") {
        return {
            intro: "Ketuk tombol di bawah untuk membuka VoiceStudio. Jika di iPhone terbuka sebagai panel bawah, gunakan tombol Open standar Telegram di profil bot untuk layar penuh.",
            button: "Buka VoiceStudio",
            noUrl: "URL Mini App belum dikonfigurasi di server. Hubungi dukungan."
        };
    }
    if (language === "ar") {
        return {
            intro: "اضغط الزر بالاسفل لفتح VoiceStudio. اذا فُتح في iPhone كلوحة سفلية، استخدم زر Open القياسي في Telegram من ملف البوت لفتح شاشة كاملة.",
            button: "افتح VoiceStudio",
            noUrl: "لم يتم ضبط رابط Mini App على الخادم. يرجى التواصل مع الدعم."
        };
    }
    return {
        intro: "Tap the button below to open VoiceStudio. If iPhone opens it as a bottom sheet, use Telegram's standard Open button in the bot profile for fullscreen mode.",
        button: "Open VoiceStudio",
        noUrl: "Mini App URL is not configured on the server. Please contact support."
    };
};

/** Inline `web_app` — на iPhone обычно ближе к открытию через «Открыть», чем кнопка в Reply Keyboard. */
const sendVoiceStudioWebAppOpenButton = async (bot: TelegramBot, chatId: number, language: UserLanguage) => {
    const copy = getMiniAppStartCopy(language);
    if (!MINI_APP_URL) {
        await bot.sendMessage(chatId, copy.noUrl);
        return;
    }

    await bot.sendMessage(chatId, copy.intro, {
        reply_markup: {
            inline_keyboard: [[{ text: copy.button, web_app: { url: MINI_APP_URL } }]]
        }
    });
};

const registerVoiceStudioWebAppStart = (bot: TelegramBot | null) => {
    if (!bot) {
        return;
    }
    bot.onText(/^\/start(?:\s|$)/i, async (msg: TelegramBot.Message) => {
        const from = msg.from;
        if (msg.chat.type !== "private" || !from || from.is_bot) {
            return;
        }
        const uid = from.id;
        const languageHint = mapTelegramLanguageToSupported(from.language_code);
        const userLanguage = normalizeDbLanguage(
            (await getOrCreateUser(uid, from.first_name, from.username, languageHint)).language
        );
        try {
            await sendVoiceStudioWebAppOpenButton(bot, msg.chat.id, userLanguage);
        } catch (error) {
            console.error("Failed to send Mini App open button:", error);
        }
    });
};

const handleSupportBridge = async (bot: TelegramBot, msg: TelegramBot.Message): Promise<void> => {
    const fromUser = msg.from;

    // Support bridge: private user -> support group (forum thread or reply chain).
    if (
        SUPPORT_GROUP_CHAT_ID &&
        fromUser &&
        !fromUser.is_bot &&
        msg.chat.type === "private" &&
        typeof msg.text === "string" &&
        msg.text.trim().length > 0
    ) {
        if (msg.text.trim().startsWith("/")) {
            return;
        }
        const userId = fromUser.id;
        const userLanguage = normalizeDbLanguage((await getOrCreateUser(userId)).language);
        if (!canSendSupportMessage(userId)) {
            await bot.sendMessage(
                msg.chat.id,
                getSupportUiText(userLanguage, "rate_limited")
            );
            return;
        }

        const supportThreadId = await ensureSupportThread(
            {
                userId,
                firstName: fromUser.first_name,
                username: fromUser.username
            },
            bot
        );

        const userTag = fromUser.username ? `@${fromUser.username}` : fromUser.first_name ?? "Unknown";
        const supportText = [
            "📩 Новое сообщение в поддержку",
            `👤 ${userTag}`,
            `🆔 ${userId}`,
            "",
            msg.text
        ].join("\n");

        const sendOptions: TelegramBot.SendMessageOptions = {};
        if (supportThreadId) {
            (sendOptions as any).message_thread_id = supportThreadId;
        } else {
            const rootMessageId = supportRootMessageByUser.get(userId);
            if (rootMessageId) {
                sendOptions.reply_to_message_id = rootMessageId;
            }
        }

        try {
            const sent = await bot.sendMessage(SUPPORT_GROUP_CHAT_ID, supportText, sendOptions);
            supportUserByGroupMessage.set(sent.message_id, userId);
            if (!supportRootMessageByUser.has(userId)) {
                supportRootMessageByUser.set(userId, sent.message_id);
            }
            await logSupportMessage({
                userId,
                direction: "user_to_group",
                text: msg.text,
                groupMessageId: sent.message_id,
                userMessageId: msg.message_id,
                threadId: supportThreadId
            });
            await bot.sendMessage(msg.chat.id, getSupportUiText(userLanguage, "sent"));
        } catch (error) {
            console.error("Support forward to group failed:", error);
            await bot.sendMessage(msg.chat.id, getSupportUiText(userLanguage, "send_error"));
        }
        return;
    }

    // Support bridge: admin reply in support group -> user private chat.
    if (
        SUPPORT_GROUP_CHAT_ID &&
        fromUser &&
        !fromUser.is_bot &&
        msg.chat.id === SUPPORT_GROUP_CHAT_ID &&
        typeof msg.text === "string" &&
        msg.text.trim().length > 0
    ) {
        const threadId = Number((msg as any).message_thread_id ?? 0);
        const fromThread = Number.isFinite(threadId) && threadId > 0 ? supportUserByThread.get(threadId) : undefined;
        const fromReply = resolveSupportUserFromReply(msg.reply_to_message);
        const targetUserId = fromThread ?? fromReply;

        if (!targetUserId) {
            return;
        }

        try {
            const targetUserLanguage = normalizeDbLanguage((await getOrCreateUser(targetUserId)).language);
            const responseText = `${getSupportUiText(targetUserLanguage, "support_reply_prefix")}\n\n${msg.text}`;
            const sentToUser = await bot.sendMessage(targetUserId, responseText);
            supportUserByGroupMessage.set(msg.message_id, targetUserId);
            await logSupportMessage({
                userId: targetUserId,
                direction: "group_to_user",
                text: msg.text,
                groupMessageId: msg.message_id,
                userMessageId: sentToUser.message_id,
                threadId: Number.isFinite(threadId) && threadId > 0 ? threadId : undefined
            });
        } catch (error) {
            console.error("Support reply to user failed:", error);
            await bot.sendMessage(
                msg.chat.id,
                `Не удалось отправить ответ пользователю ${targetUserId}. Возможно, пользователь заблокировал бота.`,
                Number.isFinite(threadId) && threadId > 0 ? { reply_to_message_id: msg.message_id } : undefined
            );
        }
    }
};

if (!telegramBot) {
    console.warn("⚠️ TELEGRAM_BOT_TOKEN is not set. Telegram payments are disabled.");
} else {
    registerVoiceStudioWebAppStart(telegramBot);
    if (!MINI_APP_URL) {
        console.warn("⚠️ Задайте MINI_APP_URL — иначе /start не покажет кнопку web_app.");
    }
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
        if (msg.successful_payment) {
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
            return;
        }

        if (!supportBotUsesDedicatedToken) {
            await handleSupportBridge(telegramBot, msg);
        }
    });
}

if (supportBotUsesDedicatedToken && supportBot) {
    supportBot.on("message", async (msg: TelegramBot.Message) => {
        await handleSupportBridge(supportBot, msg);
    });
    console.log(
        "Support relay: задан SUPPORT_BOT_TOKEN — укажите для этого бота webhook на POST /webhook/support-bot (тот же хост, что и основной бот)."
    );
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

app.post("/webhook/support-bot", async (req: Request, res: Response) => {
    if (!supportBotUsesDedicatedToken || !supportBot) {
        return res.status(404).json({ error: "Dedicated support bot is not configured (set SUPPORT_BOT_TOKEN)" });
    }

    try {
        supportBot.processUpdate(req.body);
        return res.sendStatus(200);
    } catch (error: any) {
        console.error("Support bot webhook processing error:", error);
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
        const safeSpeed = Number.isFinite(parsedSpeed) ? Math.min(Math.max(parsedSpeed, 0.7), 1.2) : 1.0;
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
        if (
            language !== "ru" &&
            language !== "en" &&
            language !== "es" &&
            language !== "hi" &&
            language !== "id" &&
            language !== "ar"
        ) {
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