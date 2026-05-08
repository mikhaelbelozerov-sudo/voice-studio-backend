import crypto from "crypto";
import { supabase } from "./supabaseClient";

/** 1 second of output ≈ 1 credit (MVP heuristic, tuned from text length). */
export const CREDITS_PER_UNIT_SECOND = 1;

export const FREE_LIFETIME_SECONDS_CAP = 60;
export const FREE_MAX_GENERATIONS = 3;
export const FREE_DAILY_REQUEST_CAP = 5;

export const COOLDOWN_MS_FREE_AND_TOPUP = 45_000;
export const COOLDOWN_MS_PRO = 12_000;

export const DUPLICATE_WINDOW_MS = 120_000;

export const PRO_MONTHLY_CREDIT_GRANT = 100 * 60; // 100 "minutes" ≈ 6000 credits
export const FIRST_PAYMENT_BONUS_CREDITS = 120;
export const DAILY_LOGIN_BONUS_CREDITS = 35;
export const STREAK_BONUS_CREDITS = 15; // per day after day 1, capped in logic
export const INVITE_BONUS_CREDITS = 90;

export const FREE_MAX_SCRIPT_CHARS = 420;
export const PAID_MAX_SCRIPT_CHARS = 2500;

const premiumVoiceSet = new Set(
  (process.env.ELEVENLABS_PREMIUM_VOICE_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

export type BillingUserRow = {
  telegram_id: number;
  subscription_tier: string | null;
  subscription_expires_at: string | null;
  stars_minutes: number | null;
  credit_balance: number | null;
  subscription_credit_balance: number | null;
  subscription_credits_reset_at: string | null;
  free_seconds_used: number | null;
  free_generation_count: number | null;
  daily_gen_count: number | null;
  daily_gen_date: string | null;
  last_generate_at: string | null;
  last_generate_fingerprint: string | null;
  login_streak_days: number | null;
  last_streak_date: string | null;
  last_daily_bonus_date: string | null;
  first_paid_at: string | null;
  created_at?: string | null;
  first_generation_at: string | null;
};

export function isProSubscriptionActive(row: Pick<BillingUserRow, "subscription_tier" | "subscription_expires_at">): boolean {
  const tier = row.subscription_tier ?? "free";
  if (tier !== "pro" && tier !== "premium") {
    return false;
  }
  if (tier === "premium") {
    return true;
  }
  if (!row.subscription_expires_at) {
    return false;
  }
  return new Date(row.subscription_expires_at).getTime() > Date.now();
}

export function estimateSpeechSeconds(text: string, speed: number): number {
  const trimmed = text.trim();
  const words = trimmed ? trimmed.split(/\s+/).filter(Boolean).length : 0;
  const safeSpeed = Math.min(Math.max(speed || 1, 0.7), 1.2);
  const rawSeconds = Math.max(3, Math.min(240, Math.ceil(words * 0.52 + trimmed.length * 0.02)));
  return Math.ceil(rawSeconds / safeSpeed);
}

export function getVoiceCreditMultiplier(voiceId: string): number {
  if (premiumVoiceSet.has(voiceId)) {
    return 1.35;
  }
  return 1;
}

export function computeGenerationCredits(text: string, voiceId: string, speed: number): number {
  const seconds = estimateSpeechSeconds(text, speed);
  const mult = getVoiceCreditMultiplier(voiceId);
  return Math.max(5, Math.ceil(seconds * mult * CREDITS_PER_UNIT_SECOND));
}

export function contentFingerprint(text: string, voiceId: string): string {
  const normalized = `${voiceId}|${text.trim().toLowerCase().replace(/\s+/g, " ")}`;
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

export function maxScriptCharsForUser(row: BillingUserRow): number {
  const paid =
    isProSubscriptionActive(row) ||
    (row.credit_balance ?? 0) > 0 ||
    (row.subscription_credit_balance ?? 0) > 0;
  return paid ? PAID_MAX_SCRIPT_CHARS : FREE_MAX_SCRIPT_CHARS;
}

export type GenerationGateResult =
  | { ok: true; creditsRequired: number; estimatedSeconds: number; source: "free" | "wallet" | "subscription" }
  | { ok: false; code: string; message: string; creditsRequired: number; creditsShortfall?: number; secondsShortfall?: number };

const inFlightByUser = new Map<number, boolean>();

export function tryBeginGeneration(telegramId: number): boolean {
  if (inFlightByUser.get(telegramId)) {
    return false;
  }
  inFlightByUser.set(telegramId, true);
  return true;
}

export function endGeneration(telegramId: number): void {
  inFlightByUser.delete(telegramId);
}

export async function fetchBillingUser(telegramId: number): Promise<BillingUserRow | null> {
  const { data, error } = await supabase.from("users").select("*").eq("telegram_id", telegramId).single();
  if (error || !data) {
    return null;
  }
  return data as BillingUserRow;
}

function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function maybeResetDailyCounters(row: BillingUserRow, telegramId: number): Promise<BillingUserRow> {
  const today = todayUtcDate();
  if (row.daily_gen_date === today) {
    return row;
  }
  await supabase
    .from("users")
    .update({ daily_gen_count: 0, daily_gen_date: today })
    .eq("telegram_id", telegramId);
  return { ...row, daily_gen_count: 0, daily_gen_date: today };
}

export async function maybeRefillProCredits(row: BillingUserRow, telegramId: number): Promise<BillingUserRow> {
  if (!isProSubscriptionActive(row) || row.subscription_tier === "premium") {
    return row;
  }
  const resetAt = row.subscription_credits_reset_at ? new Date(row.subscription_credits_reset_at).getTime() : 0;
  const now = Date.now();
  if (!resetAt || now < resetAt) {
    return row;
  }
  const subEnd = row.subscription_expires_at ? new Date(row.subscription_expires_at).getTime() : now;
  if (now > subEnd) {
    return row;
  }
  const nextReset = new Date(resetAt);
  while (nextReset.getTime() <= now && nextReset.getTime() < subEnd) {
    nextReset.setDate(nextReset.getDate() + 30);
  }
  const newBalance = (row.subscription_credit_balance ?? 0) + PRO_MONTHLY_CREDIT_GRANT;
  await supabase
    .from("users")
    .update({
      subscription_credit_balance: newBalance,
      subscription_credits_reset_at: nextReset.toISOString()
    })
    .eq("telegram_id", telegramId);
  return {
    ...row,
    subscription_credit_balance: newBalance,
    subscription_credits_reset_at: nextReset.toISOString()
  };
}

function usingFreeMvpTrack(row: BillingUserRow): boolean {
  if (isProSubscriptionActive(row)) {
    return false;
  }
  if ((row.credit_balance ?? 0) > 0) {
    return false;
  }
  if ((row.subscription_credit_balance ?? 0) > 0) {
    return false;
  }
  return true;
}

export async function assertCanGenerate(params: {
  telegramId: number;
  text: string;
  voiceId: string;
  speed: number;
}): Promise<GenerationGateResult> {
  const rowRaw = await fetchBillingUser(params.telegramId);
  if (!rowRaw) {
    return { ok: false, code: "user_missing", message: "User not found", creditsRequired: 0 };
  }
  let row = await maybeResetDailyCounters(rowRaw, params.telegramId);
  row = await maybeRefillProCredits(row, params.telegramId);

  const maxChars = maxScriptCharsForUser(row);
  if (params.text.length > maxChars) {
    return {
      ok: false,
      code: "script_too_long",
      message: `Text exceeds limit (${maxChars} characters) for your plan.`,
      creditsRequired: 0
    };
  }

  const creditsRequired = computeGenerationCredits(params.text, params.voiceId, params.speed);
  const estimatedSeconds = estimateSpeechSeconds(params.text, params.speed);
  const fp = contentFingerprint(params.text, params.voiceId);
  const now = Date.now();

  const lastAt = row.last_generate_at ? new Date(row.last_generate_at).getTime() : 0;
  const cooldown = isProSubscriptionActive(row) && row.subscription_tier !== "premium" ? COOLDOWN_MS_PRO : COOLDOWN_MS_FREE_AND_TOPUP;
  if (lastAt && now - lastAt < cooldown) {
    const waitSec = Math.ceil((cooldown - (now - lastAt)) / 1000);
    return {
      ok: false,
      code: "cooldown",
      message: `Please wait ${waitSec}s before another render.`,
      creditsRequired
    };
  }

  if (
    row.last_generate_fingerprint === fp &&
    lastAt &&
    now - lastAt < DUPLICATE_WINDOW_MS
  ) {
    return {
      ok: false,
      code: "duplicate",
      message: "Same script was just generated. Change text or wait a moment.",
      creditsRequired
    };
  }

  if ((row.subscription_tier ?? "").toLowerCase() === "premium") {
    return { ok: true, creditsRequired, estimatedSeconds, source: "subscription" };
  }

  const freeTrack = usingFreeMvpTrack(row);
  if (freeTrack) {
    if ((row.daily_gen_count ?? 0) >= FREE_DAILY_REQUEST_CAP) {
      return {
        ok: false,
        code: "daily_cap",
        message: "Daily try limit reached. Top up to keep creating.",
        creditsRequired,
        creditsShortfall: creditsRequired
      };
    }
    const freeSeconds = row.free_seconds_used ?? 0;
    const freeGens = row.free_generation_count ?? 0;
    const lifetimeExceeded = freeSeconds + estimatedSeconds > FREE_LIFETIME_SECONDS_CAP || freeGens >= FREE_MAX_GENERATIONS;
    if (lifetimeExceeded) {
      return {
        ok: false,
        code: "free_exhausted",
        message: "Free studio time is used up. Grab credits to continue.",
        creditsRequired,
        secondsShortfall: Math.max(0, freeSeconds + estimatedSeconds - FREE_LIFETIME_SECONDS_CAP),
        creditsShortfall: creditsRequired
      };
    }
    return { ok: true, creditsRequired, estimatedSeconds, source: "free" };
  }

  const subBal = row.subscription_credit_balance ?? 0;
  const wallet = row.credit_balance ?? 0;
  if (isProSubscriptionActive(row) && subBal >= creditsRequired) {
    return { ok: true, creditsRequired, estimatedSeconds, source: "subscription" };
  }
  if (wallet >= creditsRequired) {
    return { ok: true, creditsRequired, estimatedSeconds, source: "wallet" };
  }
  if (isProSubscriptionActive(row) && subBal + wallet >= creditsRequired) {
    return { ok: true, creditsRequired, estimatedSeconds, source: "subscription" };
  }

  const shortfall = creditsRequired - Math.max(subBal + wallet, 0);
  return {
    ok: false,
    code: "insufficient_credits",
    message: "Not enough credits for this voiceover.",
    creditsRequired,
    creditsShortfall: shortfall
  };
}

export async function chargeAfterSuccessfulGeneration(params: {
  telegramId: number;
  text: string;
  voiceId: string;
  speed: number;
  source: "free" | "wallet" | "subscription";
  creditsRequired: number;
  estimatedSeconds: number;
}): Promise<void> {
  const fp = contentFingerprint(params.text, params.voiceId);
  const nowIso = new Date().toISOString();
  const row = await fetchBillingUser(params.telegramId);
  if (!row) {
    return;
  }

  if ((row.subscription_tier ?? "").toLowerCase() === "premium") {
    await supabase
      .from("users")
      .update({
        daily_gen_count: (row.daily_gen_count ?? 0) + 1,
        last_generate_at: nowIso,
        last_generate_fingerprint: fp
      })
      .eq("telegram_id", params.telegramId);
    return;
  }

  if (params.source === "free") {
    await supabase
      .from("users")
      .update({
        free_seconds_used: (row.free_seconds_used ?? 0) + params.estimatedSeconds,
        free_generation_count: (row.free_generation_count ?? 0) + 1,
        daily_gen_count: (row.daily_gen_count ?? 0) + 1,
        last_generate_at: nowIso,
        last_generate_fingerprint: fp
      })
      .eq("telegram_id", params.telegramId);
    return;
  }

  let subBal = row.subscription_credit_balance ?? 0;
  let wallet = row.credit_balance ?? 0;
  let remaining = params.creditsRequired;
  let takeFromSub = Math.min(subBal, remaining);
  remaining -= takeFromSub;
  subBal -= takeFromSub;
  if (remaining > 0) {
    const takeWallet = Math.min(wallet, remaining);
    wallet -= takeWallet;
    remaining -= takeWallet;
  }

  await supabase
    .from("users")
    .update({
      subscription_credit_balance: subBal,
      credit_balance: wallet,
      daily_gen_count: (row.daily_gen_count ?? 0) + 1,
      last_generate_at: nowIso,
      last_generate_fingerprint: fp
    })
    .eq("telegram_id", params.telegramId);
}

export async function logAnalyticsEvent(
  telegramId: number,
  event: string,
  props: Record<string, unknown> = {}
): Promise<void> {
  try {
    await supabase.from("analytics_events").insert([
      {
        telegram_id: telegramId,
        event,
        props
      }
    ]);
  } catch {
    /* table may be missing in dev */
  }
}

export async function applyRetentionOnProfileOpen(telegramId: number): Promise<void> {
  const row = await fetchBillingUser(telegramId);
  if (!row) {
    return;
  }
  const today = todayUtcDate();
  let streak = row.login_streak_days ?? 0;
  const last = row.last_streak_date;

  if (last === today) {
    return;
  }

  if (!last) {
    streak = 1;
  } else {
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const y = yesterday.toISOString().slice(0, 10);
    streak = last === y ? streak + 1 : 1;
  }

  let bonus = 0;
  if (row.last_daily_bonus_date !== today) {
    bonus += DAILY_LOGIN_BONUS_CREDITS;
  }
  if (streak > 1 && row.last_daily_bonus_date !== today) {
    bonus += Math.min(STREAK_BONUS_CREDITS * (streak - 1), 45);
  }

  const nextBalance = (row.credit_balance ?? 0) + bonus;

  await supabase
    .from("users")
    .update({
      login_streak_days: streak,
      last_streak_date: today,
      last_daily_bonus_date: today,
      credit_balance: bonus > 0 ? nextBalance : row.credit_balance
    })
    .eq("telegram_id", telegramId);

  if (bonus > 0) {
    void logAnalyticsEvent(telegramId, "retention_bonus", { bonusCredits: bonus, streak });
  }
}

export async function markFirstGenerationIfNeeded(telegramId: number): Promise<void> {
  const row = await fetchBillingUser(telegramId);
  if (!row || row.first_generation_at) {
    return;
  }
  await supabase
    .from("users")
    .update({ first_generation_at: new Date().toISOString() })
    .eq("telegram_id", telegramId);
  void logAnalyticsEvent(telegramId, "first_generation", {});
}
