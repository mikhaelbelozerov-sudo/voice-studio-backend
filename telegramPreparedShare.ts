/**
 * Bot API 8.0+ {@link https://core.telegram.org/bots/api#savepreparedinlinemessage savePreparedInlineMessage}
 * for Telegram.WebApp.shareMessage (Mini App «Поделиться» с превью).
 */

export type PreparedInlineMessage = {
    id: string;
    expiration_date?: number;
};

type TelegramApiResponse<T> =
    | { ok: true; result: T }
    | { ok: false; description?: string; error_code?: number };

export async function telegramSavePreparedInviteShare(params: {
    botToken: string;
    userId: number;
    messageText: string;
    articleTitle: string;
}): Promise<PreparedInlineMessage> {
    const title = params.articleTitle.trim().slice(0, 256) || "Invite";
    const rawId = `i${params.userId.toString(36)}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const id = rawId.length > 64 ? rawId.slice(0, 64) : rawId;
    const result = {
        type: "article",
        id,
        title: title.slice(0, 64),
        input_message_content: {
            message_text: params.messageText
        }
    };

    const body = {
        user_id: Math.floor(params.userId),
        result,
        allow_user_chats: true,
        allow_group_chats: true,
        allow_channel_chats: true
    };

    const res = await fetch(`https://api.telegram.org/bot${params.botToken}/savePreparedInlineMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });

    const json = (await res.json()) as TelegramApiResponse<PreparedInlineMessage>;
    if (!json.ok) {
        const msg = typeof json.description === "string" ? json.description : `HTTP ${res.status}`;
        throw new Error(msg);
    }
    return json.result;
}
