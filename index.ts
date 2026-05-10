import cors from "cors";
import dotenv from "dotenv";
import express, { Request, Response } from "express";
import fs from "fs";
import TelegramBot from "node-telegram-bot-api";
import path from "path";
import {
    assertCanGenerate,
    applyRetentionOnProfileOpen,
    chargeAfterSuccessfulGeneration,
    endGeneration,
    fetchBillingUser,
    FIRST_PAYMENT_BONUS_CREDITS,
    insertGenerationLog,
    logAnalyticsEvent,
    markFirstGenerationIfNeeded,
    PRO_MONTHLY_CREDIT_GRANT,
    tryBeginGeneration
} from "./creditEconomy";
import {
    claimReferralLink,
    getReferralProfileSnapshot,
    hashReferralIp,
    processDueReferralRewards,
    processReferralSideEffectsAfterDownload,
    processReferralSideEffectsAfterGeneration
} from "./referralProgram";

import {
    cleanExpiredFiles,
    getAudioPublicUrl,
    getUserGenerations,
    getUserProfile,
    getUserSubscriptionTier,
    getOrCreateUser,
    mapTelegramLanguageToSupported,
    saveGenerationHistory,
    SUPABASE_AUDIO_BUCKET
} from "./quotaService";
import { supabase } from "./supabaseClient";

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
const AUDIO_STORAGE_DIR = process.env.AUDIO_STORAGE_DIR?.trim() || process.env.RENDER_DISK_PATH?.trim() || path.join(__dirname, "temp");

const SUPPORT_RATE_LIMIT_WINDOW_MS = 60_000;
const SUPPORT_RATE_LIMIT_MAX_MESSAGES = 3;
const TTS_LANGUAGE_CODES = [
    "en",
    "ru",
    "es",
    "hi",
    "id",
    "ar",
    "de",
    "fr",
    "it",
    "ja",
    "zh",
    "ko",
    "tr",
    "uk",
    "pl",
    "pt",
    "el",
    "he",
    "vi"
] as const;
type TtsLanguageCode = (typeof TTS_LANGUAGE_CODES)[number];

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

// Создание папки для аудио, если её нет
if (!fs.existsSync(AUDIO_STORAGE_DIR)) {
    fs.mkdirSync(AUDIO_STORAGE_DIR, { recursive: true });
}

if (process.env.RENDER && !process.env.AUDIO_STORAGE_DIR && !process.env.RENDER_DISK_PATH) {
    console.warn(
        "⚠️ Persistent audio storage is not configured. Set AUDIO_STORAGE_DIR (or RENDER_DISK_PATH) to Render Disk mount path to keep files available for 24 hours."
    );
}
console.log(`🗂️ Audio storage bucket: ${SUPABASE_AUDIO_BUCKET}`);

app.use(cors());
app.use(express.json());
app.use("/temp", express.static(AUDIO_STORAGE_DIR));

type ProductType = "credits" | "subscription";
type ProductConfig = {
    catalogKey: string;
    productType: ProductType;
    /** Credits granted (1 credit ~= 1s of studio time) OR subscription tier sentinel */
    productValue: number;
    amount: number;
    title: string;
    description: string;
    label: string;
};

const PRODUCT_CATALOG: Record<string, ProductConfig> = {
    credits_5m: {
        catalogKey: "credits_5m",
        productType: "credits",
        productValue: 5 * 60,
        amount: 39,
        title: "VoiceStudio Pro — Starter (5 min)",
        description: "+5 minutes of studio narration time — perfect for your next Short or Reel.",
        label: "Starter 5m"
    },
    credits_20m: {
        catalogKey: "credits_20m",
        productType: "credits",
        productValue: 20 * 60,
        amount: 99,
        title: "VoiceStudio Pro — Creator (20 min)",
        description: "+20 minutes of studio-quality voiceovers for a week of content.",
        label: "Creator 20m"
    },
    pro_creator_30d: {
        catalogKey: "pro_creator_30d",
        productType: "subscription",
        productValue: 3,
        amount: Number(process.env.PRO_CREATOR_STARS_PRICE ?? "650"),
        title: "PRO Creator Beta · 30 days",
        description: `${Math.floor(PRO_MONTHLY_CREDIT_GRANT / 60)} min/month voiceover, priority queue, longer scripts.`,
        label: "PRO Creator Beta"
    }
};

const isAuthorizedProductPurchase = (
    productType: ProductType,
    productValue: number,
    amountStars: number
): boolean =>
    Object.values(PRODUCT_CATALOG).some(
        (p) => p.productType === productType && p.productValue === productValue && p.amount === amountStars
    );

const addDaysToDate = (baseDate: Date, days: number) => {
    const nextDate = new Date(baseDate);
    nextDate.setDate(nextDate.getDate() + days);
    return nextDate;
};

type CreateInvoiceRequest = {
    telegramId?: number;
    productType?: ProductType | "minutes";
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
const miniAppOpenMessageByUser = new Map<number, number>();

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
            intro: "Нажмите кнопку ниже, чтобы открыть VoiceStudio Pro. Если на iPhone откроется нижняя шторка, используйте стандартную кнопку Telegram «Открыть» в профиле бота для полноэкранного режима.",
            button: "Открыть VoiceStudio Pro",
            noUrl: "Адрес Mini App на сервере не задан. Напишите в поддержку."
        };
    }
    if (language === "es") {
        return {
            intro: "Pulsa el boton para abrir VoiceStudio Pro. Si en iPhone se abre como panel inferior, usa el boton estandar Abrir de Telegram en el perfil del bot para pantalla completa.",
            button: "Abrir VoiceStudio Pro",
            noUrl: "La URL de Mini App no esta configurada en el servidor. Contacta con soporte."
        };
    }
    if (language === "hi") {
        return {
            intro: "VoiceStudio Pro खोलने के लिए नीचे बटन दबाएं। अगर iPhone पर नीचे की शीट खुले, तो फुलस्क्रीन के लिए बॉट प्रोफाइल में Telegram का Open बटन उपयोग करें।",
            button: "VoiceStudio Pro खोलें",
            noUrl: "सर्वर पर Mini App URL सेट नहीं है। कृपया सपोर्ट से संपर्क करें।"
        };
    }
    if (language === "id") {
        return {
            intro: "Ketuk tombol di bawah untuk membuka VoiceStudio Pro. Jika di iPhone terbuka sebagai panel bawah, gunakan tombol Open standar Telegram di profil bot untuk layar penuh.",
            button: "Buka VoiceStudio Pro",
            noUrl: "URL Mini App belum dikonfigurasi di server. Hubungi dukungan."
        };
    }
    if (language === "ar") {
        return {
            intro: "اضغط الزر بالاسفل لفتح VoiceStudio Pro. اذا فُتح في iPhone كلوحة سفلية، استخدم زر Open القياسي في Telegram من ملف البوت لفتح شاشة كاملة.",
            button: "افتح VoiceStudio Pro",
            noUrl: "لم يتم ضبط رابط Mini App على الخادم. يرجى التواصل مع الدعم."
        };
    }
    return {
        intro: "Tap the button below to open VoiceStudio Pro. If iPhone opens it as a bottom sheet, use Telegram's standard Open button in the bot profile for fullscreen mode.",
        button: "Open VoiceStudio Pro",
        noUrl: "Mini App URL is not configured on the server. Please contact support."
    };
};

const getLanguagePromptText = (language: UserLanguage): string => {
    if (language === "ru") return "Выберите язык интерфейса:";
    if (language === "es") return "Elige el idioma de la interfaz:";
    if (language === "hi") return "इंटरफेस भाषा चुनें:";
    if (language === "id") return "Pilih bahasa antarmuka:";
    if (language === "ar") return "اختر لغة الواجهة:";
    return "Choose interface language:";
};

const LANGUAGE_OPTION_LABELS: Record<UserLanguage, string> = {
    en: "English",
    ru: "Русский",
    es: "Espanol",
    hi: "हिंदी",
    id: "Bahasa Indonesia",
    ar: "العربية"
};

const buildLanguageSelectorMarkup = (current: UserLanguage): TelegramBot.InlineKeyboardMarkup => {
    const withMark = (code: UserLanguage) =>
        `${current === code ? "✓ " : ""}${LANGUAGE_OPTION_LABELS[code]}`;
    return {
        inline_keyboard: [
            [
                { text: withMark("en"), callback_data: "lang:set:en" },
                { text: withMark("ru"), callback_data: "lang:set:ru" }
            ],
            [
                { text: withMark("es"), callback_data: "lang:set:es" },
                { text: withMark("hi"), callback_data: "lang:set:hi" }
            ],
            [
                { text: withMark("id"), callback_data: "lang:set:id" },
                { text: withMark("ar"), callback_data: "lang:set:ar" }
            ]
        ]
    };
};

const buildMiniAppOpenReplyMarkup = (language: UserLanguage): TelegramBot.InlineKeyboardMarkup | undefined => {
    if (!MINI_APP_URL) {
        return undefined;
    }
    const copy = getMiniAppStartCopy(language);
    return {
        inline_keyboard: [[{ text: copy.button, web_app: { url: MINI_APP_URL } }]]
    };
};

/** Inline `web_app` — на iPhone обычно ближе к открытию через «Открыть», чем кнопка в Reply Keyboard. */
const sendVoiceStudioWebAppOpenButton = async (
    bot: TelegramBot,
    chatId: number,
    language: UserLanguage
): Promise<TelegramBot.Message> => {
    const copy = getMiniAppStartCopy(language);
    const replyMarkup = buildMiniAppOpenReplyMarkup(language);
    if (!replyMarkup) {
        return bot.sendMessage(chatId, copy.noUrl);
    }

    return bot.sendMessage(chatId, copy.intro, { reply_markup: replyMarkup });
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
            await bot.sendMessage(msg.chat.id, getLanguagePromptText(userLanguage), {
                reply_markup: buildLanguageSelectorMarkup(userLanguage)
            });
            const openMessage = await sendVoiceStudioWebAppOpenButton(bot, msg.chat.id, userLanguage);
            miniAppOpenMessageByUser.set(uid, openMessage.message_id);
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
            await telegramBot.sendMessage(chatId, "Пополните студийные минуты звёздами или возьмите Pro Creator:", {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "Starter 5 мин • 39⭐️", callback_data: "buy:credits_5m" }],
                        [{ text: "Creator 20 мин • 99⭐️", callback_data: "buy:credits_20m" }],
                        [{ text: "PRO Creator Beta • 30 дней", callback_data: "buy:pro_creator_30d" }]
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
        if (!chatId || !action) {
            await telegramBot.answerCallbackQuery(query.id);
            return;
        }

        if (action.startsWith("lang:set:")) {
            const selected = action.replace("lang:set:", "");
            const valid: UserLanguage[] = ["en", "ru", "es", "hi", "id", "ar"];
            if (!valid.includes(selected as UserLanguage)) {
                await telegramBot.answerCallbackQuery(query.id, { text: "Unknown language" });
                return;
            }
            const nextLang = selected as UserLanguage;
            try {
                await getOrCreateUser(telegramId, query.from.first_name, query.from.username, mapTelegramLanguageToSupported(query.from.language_code));
                await supabase.from("users").update({ language: nextLang }).eq("telegram_id", telegramId);
                if (query.message?.message_id) {
                    await telegramBot.editMessageText(getLanguagePromptText(nextLang), {
                        chat_id: chatId,
                        message_id: query.message.message_id,
                        reply_markup: buildLanguageSelectorMarkup(nextLang)
                    });
                }
                const openMessageId = miniAppOpenMessageByUser.get(telegramId);
                if (openMessageId) {
                    const nextCopy = getMiniAppStartCopy(nextLang);
                    const nextOpenMarkup = buildMiniAppOpenReplyMarkup(nextLang);
                    try {
                        await telegramBot.editMessageText(nextOpenMarkup ? nextCopy.intro : nextCopy.noUrl, {
                            chat_id: chatId,
                            message_id: openMessageId,
                            reply_markup: nextOpenMarkup
                        });
                    } catch (editError) {
                        console.warn("Failed to live-update mini app open message after language change:", editError);
                    }
                }
                await telegramBot.answerCallbackQuery(query.id, {
                    text: LANGUAGE_OPTION_LABELS[nextLang]
                });
            } catch (error) {
                console.error("Language switch from bot failed:", error);
                await telegramBot.answerCallbackQuery(query.id, {
                    text: "Failed to change language",
                    show_alert: true
                });
            }
            return;
        }

        if (!action.startsWith("buy:")) {
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

                try {
                    await supabase.from("stars_transactions").insert([
                        {
                            telegram_id: telegramId,
                            stars_payment_id: payment.telegram_payment_charge_id,
                            credits_added:
                                String(invoice.product_type) === "credits" || String(invoice.product_type) === "minutes"
                                    ? Number(invoice.product_value)
                                    : PRO_MONTHLY_CREDIT_GRANT,
                            purchase_type: String(invoice.product_type)
                        }
                    ]);
                } catch {
                    /* stars_transactions table optional until migration */
                }

                const user = await getOrCreateUser(telegramId);
                const productType = String(invoice.product_type);
                const wasFirstPaidEver = !(user as { first_paid_at?: string | null }).first_paid_at;

                if (productType === "credits" || productType === "minutes") {
                    const creditsToAdd = productType === "minutes"
                        ? Number(invoice.product_value) * 60
                        : Number(invoice.product_value);
                    let nextBalance =
                        ((user as { credit_balance?: number }).credit_balance ?? 0) + creditsToAdd;
                    if (wasFirstPaidEver) {
                        nextBalance += FIRST_PAYMENT_BONUS_CREDITS;
                    }
                    await supabase
                        .from("users")
                        .update({
                            credit_balance: nextBalance,
                            ...(wasFirstPaidEver ? { first_paid_at: new Date().toISOString() } : {})
                        })
                        .eq("telegram_id", telegramId);
                    void logAnalyticsEvent(telegramId, "topup_purchased", {
                        credits: creditsToAdd,
                        firstPaymentBonus: wasFirstPaidEver ? FIRST_PAYMENT_BONUS_CREDITS : 0
                    });
                } else if (productType === "subscription") {
                    const now = new Date();
                    const currentExpiry = user.subscription_expires_at ? new Date(user.subscription_expires_at) : null;
                    const startDate = currentExpiry && currentExpiry.getTime() > now.getTime() ? currentExpiry : now;
                    const nextExpiry = addDaysToDate(startDate, 30);
                    const nextSubCredits = (user as { subscription_credit_balance?: number }).subscription_credit_balance ?? 0;
                    let wallet = (user as { credit_balance?: number }).credit_balance ?? 0;
                    if (wasFirstPaidEver) {
                        wallet += FIRST_PAYMENT_BONUS_CREDITS;
                    }
                    await supabase
                        .from("users")
                        .update({
                            subscription_tier: "pro",
                            subscription_expires_at: nextExpiry.toISOString(),
                            subscription_credit_balance: nextSubCredits + PRO_MONTHLY_CREDIT_GRANT,
                            subscription_credits_reset_at: nextExpiry.toISOString(),
                            credit_balance: wallet,
                            ...(wasFirstPaidEver ? { first_paid_at: new Date().toISOString() } : {})
                        })
                        .eq("telegram_id", telegramId);
                    void logAnalyticsEvent(telegramId, "subscription_purchased", { tier: "pro_creator_beta" });
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

        if ((productType as string) === "minutes") {
            return res.status(400).json({ error: "Legacy pack no longer available. Use credit top-ups." });
        }

        if (productType !== "credits" && productType !== "subscription") {
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

        if (!isAuthorizedProductPurchase(productType as ProductType, safeProductValue, safeAmountStars)) {
            return res.status(400).json({ error: "Invalid Stars amount for this pack" });
        }

        const payloadPrefix = productType === "credits" ? "credit" : "sub";
        const payload = `${payloadPrefix}_${Date.now()}_${safeTelegramId}_${Math.floor(Math.random() * 1e6)}`;

        const catalogEntry =
            Object.values(PRODUCT_CATALOG).find(
                (p) =>
                    p.productType === productType &&
                    p.productValue === safeProductValue &&
                    p.amount === safeAmountStars
            ) ?? null;

        if (!catalogEntry) {
            return res.status(400).json({ error: "Unknown catalog item" });
        }

        const { error } = await supabase.from("stars_invoices").insert([{
            id: payload,
            telegram_id: safeTelegramId,
            amount: safeAmountStars,
            product_type: productType === "subscription" ? "subscription" : "credits",
            product_value: safeProductValue,
            status: "pending"
        }]);

        if (error) {
            throw error;
        }

        if (!telegramBot) {
            return res.status(503).json({ error: "Telegram bot is not configured" });
        }

        const invoiceLink = await telegramBot.createInvoiceLink(
            catalogEntry.title,
            catalogEntry.description,
            payload,
            "",
            "XTR",
            [{ label: catalogEntry.label, amount: safeAmountStars }]
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

const CREATOR_VOICE_PRESETS = {
    tiktok_story: {
        speed: 1.08,
        pitch: 0.06,
        stability: 0.45,
        similarity: 0.78,
        format: (t: string) => t.trim()
    },
    youtube_documentary: {
        speed: 0.95,
        pitch: -0.04,
        stability: 0.62,
        similarity: 0.82,
        format: (t: string) => t.replace(/\n+/g, " ").trim()
    },
    luxury_ad: {
        speed: 0.9,
        pitch: -0.08,
        stability: 0.55,
        similarity: 0.85,
        format: (t: string) => t.replace(/\./g, ".\n\n").trim()
    },
    podcast: {
        speed: 1.0,
        pitch: 0.0,
        stability: 0.58,
        similarity: 0.8,
        format: (t: string) => t.replace(/\n+/g, "\n\n").trim()
    },
    motivational: {
        speed: 1.1,
        pitch: 0.12,
        stability: 0.42,
        similarity: 0.74,
        format: (t: string) => t.trim()
    },
    cinematic_trailer: {
        speed: 0.88,
        pitch: -0.12,
        stability: 0.52,
        similarity: 0.8,
        format: (t: string) => t.replace(/\./g, ".\n").trim()
    }
} satisfies Record<
    string,
    {
        speed: number;
        pitch: number;
        stability: number;
        similarity: number;
        format: (t: string) => string;
    }
>;

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
    let activeQueueUser: number | null = null;
    let generationCommitted = false;
    try {
        const {
            text,
            voiceId,
            speed = 1.0,
            pitch = 0,
            languageCode = "en",
            telegramId,
            presetId
        } = req.body;

        if (!text || !voiceId) {
            return res.status(400).json({ error: "Missing text or voiceId" });
        }
        if (!telegramId) {
            return res.status(400).json({ error: "Missing telegramId. Please login." });
        }

        const safeTelegramId = Number(telegramId);
        if (!tryBeginGeneration(safeTelegramId)) {
            void logAnalyticsEvent(safeTelegramId, "queue_busy_blocked", {});
            return res.status(429).json({
                error: "Another render is in progress. Wait a moment.",
                code: "queue_busy"
            });
        }
        activeQueueUser = safeTelegramId;

        const preset =
            presetId && typeof presetId === "string" ? CREATOR_VOICE_PRESETS[presetId as keyof typeof CREATOR_VOICE_PRESETS] : null;
        let ttsText = String(text);
        let parsedSpeed = Number.parseFloat(String(speed));
        let parsedPitch = Number.parseFloat(String(pitch));
        let stabilitySetting = 0.7;
        let similaritySetting = 0.7;

        if (preset) {
            ttsText = preset.format(ttsText);
            parsedSpeed = preset.speed;
            parsedPitch = preset.pitch;
            stabilitySetting = preset.stability;
            similaritySetting = preset.similarity;
        }

        const safeSpeed = Number.isFinite(parsedSpeed) ? Math.min(Math.max(parsedSpeed, 0.7), 1.2) : 1.0;
        const safePitch = Number.isFinite(parsedPitch) ? Math.min(Math.max(parsedPitch, -1.0), 1.0) : 0;

        const safeLanguageCode = String(languageCode).toLowerCase();
        if (!(TTS_LANGUAGE_CODES as readonly string[]).includes(safeLanguageCode)) {
            endGeneration(safeTelegramId);
            activeQueueUser = null;
            return res.status(400).json({ error: "Invalid languageCode" });
        }

        console.log("🎛️ Voice settings:", {
            telegramId: safeTelegramId,
            voiceId,
            presetId,
            speed: safeSpeed,
            pitch: safePitch,
            languageCode: safeLanguageCode
        });

        const presetKey = presetId && typeof presetId === "string" ? String(presetId) : null;
        const gate = await assertCanGenerate({
            telegramId: safeTelegramId,
            text: ttsText,
            voiceId: String(voiceId),
            speed: safeSpeed,
            pitch: safePitch,
            languageCode: safeLanguageCode,
            presetId: presetKey
        });

        if (!gate.ok) {
            const statusCode =
                gate.code === "script_too_long"
                    ? 400
                    : gate.code === "cooldown" || gate.code === "duplicate"
                      ? 429
                      : 402;
            const alreadyLogged =
                gate.code === "cooldown" ||
                gate.code === "duplicate" ||
                gate.code === "daily_cap" ||
                gate.code === "free_exhausted";
            if (!alreadyLogged) {
                void logAnalyticsEvent(safeTelegramId, "generation_blocked", {
                    code: gate.code,
                    credits: gate.creditsRequired
                });
            }
            endGeneration(safeTelegramId);
            activeQueueUser = null;
            return res.status(statusCode).json({
                error: gate.message,
                code: gate.code,
                creditsRequired: gate.creditsRequired,
                creditsShortfall: gate.creditsShortfall ?? null,
                secondsShortfall: gate.secondsShortfall ?? null
            });
        }

        const billingSnap = await fetchBillingUser(safeTelegramId);
        if (billingSnap && !billingSnap.first_generation_at) {
            void logAnalyticsEvent(safeTelegramId, "first_generation_started", {
                credits: gate.creditsRequired
            });
        }

        void logAnalyticsEvent(safeTelegramId, "generation_started", {
            credits: gate.creditsRequired,
            source: gate.source
        });

        const apiKey = process.env.ELEVENLABS_API_KEY;
        const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "xi-api-key": apiKey!
            },
            body: JSON.stringify({
                text: ttsText,
                model_id: "eleven_turbo_v2_5",
                language_code: safeLanguageCode as TtsLanguageCode,
                voice_settings: {
                    stability: stabilitySetting,
                    similarity_boost: similaritySetting,
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
                telegramId: safeTelegramId,
                speed: safeSpeed,
                pitch: safePitch,
                errorText
            });
            void insertGenerationLog({
                telegramId: safeTelegramId,
                textLength: ttsText.length,
                voiceId: String(voiceId),
                creditsRequired: gate.creditsRequired,
                estimatedSeconds: gate.estimatedSeconds,
                status: "failed",
                failureReason: `elevenlabs_${response.status}`
            });
            void logAnalyticsEvent(safeTelegramId, "generation_failed", {
                phase: "tts",
                status: response.status
            });
            throw new Error(`ElevenLabs error (${response.status}): ${errorText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const filename = `audio_${Date.now()}.mp3`;
        const objectPath = `${safeTelegramId}/${filename}`;
        const { error: uploadError } = await supabase
            .storage
            .from(SUPABASE_AUDIO_BUCKET)
            .upload(objectPath, buffer, {
                contentType: "audio/mpeg",
                upsert: false
            });
        if (uploadError) {
            throw new Error(
                `Failed to upload audio to Supabase Storage bucket "${SUPABASE_AUDIO_BUCKET}". ${uploadError.message}`
            );
        }
        const audioUrl = getAudioPublicUrl(objectPath);

        await chargeAfterSuccessfulGeneration({
            telegramId: safeTelegramId,
            text: ttsText,
            voiceId: String(voiceId),
            speed: safeSpeed,
            pitch: safePitch,
            languageCode: safeLanguageCode,
            presetId: presetKey,
            source: gate.source,
            creditsRequired: gate.creditsRequired,
            estimatedSeconds: gate.estimatedSeconds
        });

        await saveGenerationHistory(safeTelegramId, text, voiceId, audioUrl);
        await markFirstGenerationIfNeeded(safeTelegramId);
        await processReferralSideEffectsAfterGeneration(safeTelegramId);

        void insertGenerationLog({
            telegramId: safeTelegramId,
            textLength: ttsText.length,
            voiceId: String(voiceId),
            creditsRequired: gate.creditsRequired,
            estimatedSeconds: gate.estimatedSeconds,
            status: "completed",
            failureReason: null
        });

        void logAnalyticsEvent(safeTelegramId, "generation_completed", {
            creditsCharged: gate.creditsRequired,
            source: gate.source
        });

        generationCommitted = true;
        endGeneration(safeTelegramId);
        activeQueueUser = null;

        res.json({
            audioUrl,
            status: "completed",
            creditsCharged: gate.creditsRequired,
            estimatedSeconds: gate.estimatedSeconds,
            presetApplied: presetId ?? null,
            hints: {
                showSoftUpsell: true
            }
        });
    } catch (err: any) {
        console.error("Generation error:", {
            message: err?.message,
            stack: err?.stack
        });
        if (!generationCommitted && activeQueueUser !== null) {
            endGeneration(activeQueueUser);
        }
        const failTg = Number(req.body.telegramId ?? 0) || 0;
        void logAnalyticsEvent(failTg, "generation_failed", {
            message: err?.message ?? "unknown",
            phase: "unhandled"
        });
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/analytics/events", async (req: Request, res: Response) => {
    try {
        const { telegramId, event, props } = req.body ?? {};
        if (!Number.isFinite(Number(telegramId)) || Number(telegramId) <= 0 || typeof event !== "string") {
            return res.status(400).json({ error: "Invalid payload" });
        }
        await logAnalyticsEvent(Number(telegramId), event, props && typeof props === "object" ? props : {});
        return res.sendStatus(204);
    } catch (err: any) {
        return res.status(500).json({ error: err.message });
    }
});

app.post("/api/referrals/claim", async (req: Request, res: Response) => {
    try {
        const body = req.body as {
            inviteeTelegramId?: unknown;
            referrerTelegramId?: unknown;
            clientFingerprint?: unknown;
        };
        const inviteeTelegramId = Number(body.inviteeTelegramId);
        const referrerTelegramId = Number(body.referrerTelegramId);
        const clientFingerprint = typeof body.clientFingerprint === "string" ? body.clientFingerprint : "";
        if (
            !Number.isFinite(inviteeTelegramId) ||
            inviteeTelegramId <= 0 ||
            !Number.isFinite(referrerTelegramId) ||
            referrerTelegramId <= 0 ||
            inviteeTelegramId === referrerTelegramId
        ) {
            return res.status(400).json({ error: "Invalid referral ids" });
        }

        await getOrCreateUser(inviteeTelegramId);

        const result = await claimReferralLink({
            inviteeTelegramId,
            referrerTelegramId,
            deviceFingerprint: clientFingerprint,
            ipHash: hashReferralIp(req)
        });

        if (!result.ok) {
            void logAnalyticsEvent(inviteeTelegramId, "referral_rejected", { code: result.code });
            return res.status(400).json({ error: result.message, code: result.code });
        }

        return res.json({ ok: true, alreadyClaimed: result.alreadyClaimed });
    } catch (err: any) {
        return res.status(500).json({ error: err.message ?? "Referral failed" });
    }
});

app.post("/api/referrals/download-ack", async (req: Request, res: Response) => {
    try {
        const telegramId = Number((req.body as { telegramId?: unknown }).telegramId);
        if (!Number.isFinite(telegramId) || telegramId <= 0) {
            return res.status(400).json({ error: "Invalid telegramId" });
        }
        await processReferralSideEffectsAfterDownload(telegramId);
        return res.sendStatus(204);
    } catch (err: any) {
        return res.status(500).json({ error: err.message ?? "download-ack failed" });
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

        await applyRetentionOnProfileOpen(telegramId);
        await processDueReferralRewards(telegramId);
        const profile = await getUserProfile(telegramId);
        const referral = await getReferralProfileSnapshot(telegramId);
        return res.json({ ...profile, referral });
    } catch (err: any) {
        console.error("Profile fetch error:", err);
        return res.status(500).json({ error: err.message ?? "Failed to fetch profile" });
    }
});

const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

const runExpiredFilesCleanup = async () => {
    try {
        console.log("🧹 Running expired files cleanup...");
        const removedCount = await cleanExpiredFiles(AUDIO_STORAGE_DIR);
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